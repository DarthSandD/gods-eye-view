/**
 * God's Eye View — Cloudflare Workers API proxy (modules syntax, zero deps).
 *
 * Same-origin `/api/*` surface for static hosting (Cloudflare Pages +
 * Workers). Mirrors the upstream targets the Vite dev server proxies use
 * (see vite.config.js):
 *
 *   /api/opensky*               → https://opensky-network.org/api/* (OAuth when
 *                                  OPENSKY_CLIENT_ID/SECRET are set, else anon)
 *   /api/adsblol/*              → https://api.adsb.lol/v2/* (+ trace fallback
 *                                  https://adsb.lol/data/traces/*)
 *   /api/celestrak/*            → https://celestrak.org/NORAD/elements/gp.php
 *                                  (6 h edge cache for TLE)
 *   /api/launches*              → https://ll.thespacedevs.com/2.3.0/launches/
 *                                  (optional LL2_API_TOKEN)
 *   /api/cctv/*                 → catalog served from CCTV_SOURCES_JSON env
 *   /api/ais-live               → status snapshot (stateless; no socket here)
 *   /api/firms*                 → https://firms.modaps.eosdis.nasa.gov/...
 *   /api/tomtom/*               → https://api.tomtom.com/traffic/map/4/...
 *   /api/radio/*                → Radio Browser mirrors (de1/de2/nl1 failover)
 *   /api/gbfs/*                 → allowlisted GBFS provider URLs only
 *   /api/realtime/token         → https://api.openai.com/v1/realtime/client_secrets
 *   /api/realtime/debug-log     → accepted + console-logged (POST only)
 *   /api/google/*               → Places API (searchNearby / searchText)
 *   /api/overpass*              → Overpass mirrors (POST, failover)
 *   /api/military-installations*→ bounded Overpass `military` query (bbox)
 *
 * Secrets come ONLY from worker env bindings — never logged, never echoed.
 * All error responses are JSON: { ok:false, error }.
 * CORS is permissive (`*`) to match static-hosting use.
 */

const UA = 'gods-eye-view-api-worker/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
const TLE_CACHE_TTL_S = 6 * 3600; // 6 h edge cache for CelesTrak TLE
const FETCH_TIMEOUT_MS = 15000;

const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const RADIO_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
];
const RADIO_UA = 'GodsEyeView/1.0 (Radio Browser directory client)';

const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net',
  'hon.publicbikesystem.net',
  'chat.publicbikesystem.net',
]);
const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024;

const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/** Permissive CORS headers for every response. */
function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extra,
  };
}

/** JSON error with the standard shape. */
function err(status, error, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'no-store' }) },
  });
}

/** JSON success. */
function ok(data, cacheControl = 'no-store') {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': cacheControl }) },
  });
}

function timeoutSignal(ms = FETCH_TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
}

/** Fetch with a timeout; throws on network failure. */
async function timedFetch(url, init = {}, ms = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: timeoutSignal(ms) });
}

/** Try URLs in order; return the first non-5xx response, else the last one. */
async function fetchFailover(urls, init = {}, ms = FETCH_TIMEOUT_MS) {
  let lastRes = null;
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await timedFetch(url, init, ms);
      if (res.status < 500) return res;
      lastRes = res;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastRes) return lastRes;
  throw lastErr || new Error('all upstreams failed');
}

// ---------------------------------------------------------------------------
// OpenSky (OAuth client-credentials when configured, else anonymous)
// ---------------------------------------------------------------------------

/** Module-level token cache (per isolate). */
let _openskyToken = null;
let _openskyTokenExpiry = 0;

async function openskyToken(env) {
  const id = (env.OPENSKY_CLIENT_ID || '').trim();
  const secret = (env.OPENSKY_CLIENT_SECRET || '').trim();
  if (!id || !secret) return null;
  const now = Date.now();
  if (_openskyToken && now < _openskyTokenExpiry - 30_000) return _openskyToken;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: id,
    client_secret: secret,
  });
  const res = await timedFetch(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.access_token) return null;
  _openskyToken = data.access_token;
  _openskyTokenExpiry = now + (Number(data.expires_in) || 1800) * 1000;
  return _openskyToken;
}

async function handleOpenSky(url, env) {
  // /api/opensky* → opensky-network.org/api/* (keep path + query).
  // e.g. /api/opensky/states/all?extended=1, /api/opensky-track/...
  let sub = url.pathname.replace(/^\/api\/opensky(-track)?/, '') || '/';
  const upstream = sub.startsWith('/trace')
    ? null // handled by adsb.lol trace below
    : `https://opensky-network.org/api${sub}${url.search}`;
  const headers = { Accept: 'application/json', 'User-Agent': UA };
  const token = await openskyToken(env).catch(() => null);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await timedFetch(upstream, { headers }).catch((e) => null);
  if (!res) return err(502, 'opensky upstream unreachable');
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'no-store' }) },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const path = url.pathname;

    try {
      // --- OpenSky ---------------------------------------------------------
      if (path === '/api/opensky' || path.startsWith('/api/opensky/') || path.startsWith('/api/opensky-track')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        return handleOpenSky(url, env);
      }

      // --- adsb.lol --------------------------------------------------------
      if (path === '/api/adsblol' || path.startsWith('/api/adsblol/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const sub = path.replace(/^\/api\/adsblol/, '') || '/';
        const upstream = sub.startsWith('/trace')
          ? `https://adsb.lol/data/traces${sub.replace(/^\/trace/, '')}${url.search}`
          : `https://api.adsb.lol/v2${sub === '/' ? '/mil' : sub}${url.search}`;
        const res = await timedFetch(upstream, {
          headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
        }).catch(() => null);
        if (!res) return err(502, 'adsb.lol upstream unreachable');
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'no-store' }) },
        });
      }

      // --- CelesTrak TLE (6 h edge cache) ----------------------------------
      if (path === '/api/celestrak' || path.startsWith('/api/celestrak/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const group = path.replace(/^\/api\/celestrak\/?/, '').split('?')[0].split('/')[0];
        if (!/^[a-z0-9_+-]+$/i.test(group || '')) return err(400, 'invalid TLE group');
        const upstream = new URL('https://celestrak.org/NORAD/elements/gp.php');
        upstream.searchParams.set('GROUP', group);
        upstream.searchParams.set('FORMAT', 'tle');
        for (const [k, v] of url.searchParams) {
          if (k.toUpperCase() !== 'GROUP' && k.toUpperCase() !== 'FORMAT') upstream.searchParams.set(k, v);
        }
        const res = await fetch(upstream.toString(), {
          headers: { 'User-Agent': UA },
          cf: { cacheTtl: TLE_CACHE_TTL_S, cacheEverything: false },
        }).catch(() => null);
        if (!res) return err(502, 'celestrak upstream unreachable');
        const body = await res.text();
        if (!res.ok) return err(res.status, `celestrak upstream HTTP ${res.status}`);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders({ 'Cache-Control': `public, max-age=${TLE_CACHE_TTL_S}` }) },
        });
      }

      // --- Rocket launches (Launch Library 2) ------------------------------
      if (path === '/api/launches' || path.startsWith('/api/launches/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const upstream = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
        for (const [k, v] of url.searchParams) upstream.searchParams.set(k, v);
        const headers = { Accept: 'application/json', 'User-Agent': UA };
        const token = (env.LL2_API_TOKEN || '').trim();
        if (token) headers.Authorization = `Token ${token}`;
        const res = await timedFetch(upstream.toString(), { headers }).catch(() => null);
        if (!res) return err(502, 'launch library upstream unreachable');
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'public, max-age=900' }) },
        });
      }

      // --- CCTV catalog (from CCTV_SOURCES_JSON env) -----------------------
      if (path === '/api/cctv' || path.startsWith('/api/cctv/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const raw = (env.CCTV_SOURCES_JSON || '').trim();
        if (!raw) return err(503, 'CCTV_SOURCES_JSON is not set', { sources: [] });
        let sources;
        try {
          sources = JSON.parse(raw);
        } catch {
          return err(500, 'CCTV_SOURCES_JSON is not valid JSON', { sources: [] });
        }
        const list = Array.isArray(sources) ? sources : sources.sources || [];
        return ok({ sources: list });
      }

      // --- AIS live (stateless snapshot; no socket in a Worker) ------------
      if (path === '/api/ais-live' || path.startsWith('/api/ais-live/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        if (!env.AISSTREAM_API_KEY) {
          return err(503, 'AISSTREAM_API_KEY is not set', { rows: [] });
        }
        if (path.includes('/track')) {
          const mmsi = (url.searchParams.get('mmsi') || '').trim();
          if (!/^\d{5,10}$/.test(mmsi)) return err(400, 'mmsi query param required', { samples: [] });
          return ok({ mmsi, samples: [], source: 'AISStream', note: 'track history unavailable in stateless worker' });
        }
        return ok({
          rows: [],
          source: 'AISStream',
          status: 'stateless',
          error: null,
          refreshing: true,
          note: 'worker is stateless: no live socket; connect AISStream client-side or use a Durable Object feed',
        });
      }

      // --- NASA FIRMS ------------------------------------------------------
      if (path === '/api/firms' || path.startsWith('/api/firms/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const key = (env.FIRMS_MAP_KEY || '').trim();
        if (!key) return err(503, 'FIRMS_MAP_KEY is not set', { fires: [] });
        if (path.endsWith('/status')) {
          const res = await timedFetch(
            `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`,
            { headers: { 'User-Agent': UA } },
          ).catch(() => null);
          if (!res) return err(502, 'firms status upstream unreachable');
          return new Response(await res.text(), {
            status: res.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'public, max-age=300' }) },
          });
        }
        const source = (url.searchParams.get('source') || 'VIIRS_SNPP_NRT').trim();
        if (!/^[A-Z0-9_]+$/i.test(source)) return err(400, 'invalid FIRMS source');
        const upstream =
          `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
          `/${encodeURIComponent(source)}/world/2?day_range=2`;
        const res = await timedFetch(upstream, { headers: { 'User-Agent': UA } }, 20000).catch(() => null);
        if (!res) return err(502, 'firms upstream unreachable');
        return new Response(await res.text(), {
          status: res.status,
          headers: { 'Content-Type': 'text/csv; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'public, max-age=1800' }) },
        });
      }

      // --- TomTom traffic tiles --------------------------------------------
      if (path === '/api/tomtom' || path.startsWith('/api/tomtom/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const apiKey = (env.TOMTOM_API_KEY || '').trim();
        if (path === '/api/tomtom/status' || path === '/api/tomtom/status/') {
          return ok({ hasKey: Boolean(apiKey) });
        }
        if (!apiKey) return err(503, 'TOMTOM_API_KEY is not set');
        const m = path.match(/^\/api\/tomtom\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
        if (!m) return err(400, 'expected /api/tomtom/flow/{z}/{x}/{y}.pbf');
        const [, z, x, y] = m;
        const upstream =
          `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf` +
          `?key=${encodeURIComponent(apiKey)}`;
        const res = await timedFetch(upstream, { headers: { 'User-Agent': UA } }).catch(() => null);
        if (!res) return err(502, 'tomtom upstream unreachable');
        if (!res.ok) return err(res.status, `tomtom upstream HTTP ${res.status}`);
        return new Response(await res.arrayBuffer(), {
          status: 200,
          headers: { 'Content-Type': 'application/x-protobuf', ...corsHeaders({ 'Cache-Control': 'public, max-age=120' }) },
        });
      }

      // --- Radio Browser (mirror failover) ---------------------------------
      if (path === '/api/radio' || path.startsWith('/api/radio/')) {
        const sub = path.replace(/^\/api\/radio/, '') || '/';
        const targets = RADIO_MIRRORS.map((m) => `${m}${sub}${url.search}`);
        const init =
          request.method === 'POST'
            ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': RADIO_UA }, body: await request.text() }
            : { headers: { Accept: 'application/json', 'User-Agent': RADIO_UA } };
        let res = null;
        try {
          res = await fetchFailover(targets, init, 12000);
        } catch {
          return err(502, 'radio-browser upstream unreachable');
        }
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'no-store' }) },
        });
      }

      // --- GBFS (allowlisted providers only) -------------------------------
      if (path === '/api/gbfs' || path.startsWith('/api/gbfs/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const encoded = path.replace(/^\/api\/gbfs\/?/, '');
        if (!encoded) return err(400, 'Missing GBFS upstream target');
        let target;
        try {
          target = new URL(decodeURIComponent(encoded));
        } catch {
          return err(400, 'Invalid GBFS target encoding');
        }
        if (target.protocol !== 'https:') return err(400, 'Only https GBFS targets are allowed');
        const host = target.hostname.toLowerCase();
        const allowed =
          GBFS_ALLOWED_HOSTS.has(host) ||
          (host.endsWith('.publicbikesystem.net') && host.split('.').length > 2);
        if (!allowed) return err(403, 'GBFS host not allowed');
        if (!/\/station_(information|status)\.json$/i.test(target.pathname)) {
          return err(400, 'Only station_information/status GBFS endpoints are allowed');
        }
        const res = await timedFetch(target.toString(), {
          headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-gbfs-proxy/1.0' },
        }).catch(() => null);
        if (!res) return err(502, 'GBFS upstream unreachable');
        const body = await res.text();
        if (body.length > GBFS_MAX_BODY_BYTES) return err(502, 'GBFS upstream response too large');
        const cacheControl = /station_information\.json$/i.test(target.pathname)
          ? 'public, max-age=300'
          : 'no-store';
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': cacheControl }) },
        });
      }

      // --- OpenAI Realtime token -------------------------------------------
      if (path === '/api/realtime/token') {
        if (request.method !== 'GET' && request.method !== 'POST') return err(405, 'Method Not Allowed');
        const apiKey = (env.OPENAI_API_KEY || '').trim();
        if (!apiKey) return err(503, 'OPENAI_API_KEY is not set');
        const tier = url.searchParams.get('tier') === 'mini' ? 'mini' : 'standard';
        const model = tier === 'mini'
          ? (env.OPENAI_REALTIME_MODEL_MINI || 'gpt-realtime-mini').trim() || 'gpt-realtime-mini'
          : (env.OPENAI_REALTIME_MODEL || 'gpt-realtime').trim() || 'gpt-realtime';
        const voice = (env.OPENAI_REALTIME_VOICE || 'verse').trim() || 'verse';
        const res = await timedFetch('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'OpenAI-Safety-Identifier': 'gev-cloudflare-worker',
          },
          body: JSON.stringify({ session: { type: 'realtime', model, audio: { output: { voice } } } }),
        }).catch(() => null);
        if (!res) return err(502, 'openai upstream unreachable');
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'no-store' }) },
        });
      }

      // --- Realtime debug log (accepted + logged; no disk in a Worker) -----
      if (path === '/api/realtime/debug-log') {
        if (request.method !== 'POST') return err(405, 'Method Not Allowed');
        const text = (await request.text().catch(() => '')).slice(0, 64 * 1024);
        try {
          console.log(JSON.stringify({ realtimeDebug: true, loggedAt: new Date().toISOString(), event: JSON.parse(text || '{}') }));
        } catch {
          console.log(`[realtime-debug] ${text.slice(0, 2000)}`);
        }
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // --- Google Places ----------------------------------------------------
      if (path === '/api/google/nearby-places' || path === '/api/google/text-search') {
        if (request.method !== 'GET' && request.method !== 'POST') return err(405, 'Method Not Allowed');
        const apiKey = (env.GOOGLE_MAPS_API_KEY || '').trim();
        if (!apiKey) return err(503, 'GOOGLE_MAPS_API_KEY is not set', { places: [] });
        const endpoint = path.endsWith('/nearby-places')
          ? 'https://places.googleapis.com/v1/places:searchNearby'
          : 'https://places.googleapis.com/v1/places:searchText';
        const res = await timedFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': url.searchParams.get('fieldMask') || 'places.displayName,places.location,places.id',
            'User-Agent': UA,
          },
          body: request.method === 'POST' ? await request.text() : JSON.stringify({}),
        }).catch(() => null);
        if (!res) return err(502, 'google places upstream unreachable');
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'no-store' }) },
        });
      }

      // --- Overpass (POST, mirror failover) ---------------------------------
      if (path === '/api/overpass' || path.startsWith('/api/overpass')) {
        if (request.method !== 'POST') return err(405, 'Method Not Allowed');
        const body = await request.text().catch(() => '');
        if (!body || body.length > 24 * 1024) return err(413, 'Overpass query too large');
        if (!/data=/.test(body)) return err(400, 'Overpass body must contain a data query');
        let res = null;
        try {
          res = await fetchFailover(
            OVERPASS_UPSTREAMS,
            { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body },
            22000,
          );
        } catch {
          return err(502, 'overpass upstreams unreachable');
        }
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'public, max-age=86400' }) },
        });
      }

      // --- Military installations (bounded Overpass query) ------------------
      if (path === '/api/military-installations' || path.startsWith('/api/military-installations')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
        if (
          bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)) ||
          bbox[2] <= bbox[0] || bbox[3] <= bbox[1] ||
          bbox[2] - bbox[0] > 10 || bbox[3] - bbox[1] > 10
        ) {
          return err(400, 'A non-dateline bbox no larger than 10 degrees is required');
        }
        const [w, s, e, n] = bbox;
        const ql = `[out:json][timeout:25];(node["military"](${s},${w},${n},${e});way["military"](${s},${w},${n},${e});relation["military"](${s},${w},${n},${e}););out center tags;`;
        let res = null;
        try {
          res = await fetchFailover(
            OVERPASS_UPSTREAMS,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
              body: `data=${encodeURIComponent(ql)}`,
            },
            22000,
          );
        } catch {
          return err(502, 'overpass upstreams unreachable');
        }
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders({ 'Cache-Control': 'public, max-age=86400' }) },
        });
      }

      return err(404, `unknown api route: ${path}`);
    } catch (e) {
      return err(500, e?.message || 'worker proxy error');
    }
  },
};
