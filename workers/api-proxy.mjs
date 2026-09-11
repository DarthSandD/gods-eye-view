/**
 * Omni Eyes View — Cloudflare Workers API proxy (modules syntax, zero deps).
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
const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RADIO_DIR_TAGS = [null, 'news', 'talk', 'weather', 'emergency', 'aviation', 'marine', 'traffic'];
const RADIO_DIR_LIMIT = 600;
const RADIO_CODEC_RE = /^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i;

/** Trim + strip control chars, capped — mirrors cleanRadioText for worker use. */
function radioCleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, max);
}

/** Conservative https-only check mirroring isSafeRadioHttpsUrl (app-side). */
function radioSafeHttps(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !host) return null;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':')) return null;
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const parts = v4.slice(1).map(Number);
      if (parts.some((n) => n > 255)) return null;
      const [a, b] = parts;
      if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Normalize one Radio Browser row to the broker station shape the app validates. */
function normalizeRadioRow(raw) {
  const id = radioCleanText(raw?.stationuuid, 40).toLowerCase();
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? NaN : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? NaN : Number(raw?.geo_long);
  const codec = radioCleanText(raw?.codec, 16).toUpperCase();
  const streamUrl = radioSafeHttps(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id)
    || Number(raw?.lastcheckok) !== 1
    || Number(raw?.hls) === 1
    || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lon) || lon < -180 || lon > 180
    || !RADIO_CODEC_RE.test(codec)
    || !streamUrl
  ) return null;
  const name = radioCleanText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '').split(',')
    .map((t) => radioCleanText(t, 80).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).filter((t, i, all) => all.indexOf(t) === i).slice(0, 24);
  const languages = String(raw?.language ?? '').split(',')
    .map((l) => radioCleanText(l, 40)).filter(Boolean).slice(0, 8);
  const bitrate = Number(raw?.bitrate);
  const homepageRaw = radioSafeHttps(raw?.homepage);
  return {
    id, name, lat, lon, streamUrl,
    homepage: homepageRaw || null,
    tags, languages,
    state: radioCleanText(raw?.state, 80),
    country: radioCleanText(raw?.country, 80),
    countryCode: '',
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
  };
}

/** GET one Radio Browser search path with mirror failover; resolves to the row array. */
async function fetchRadioSearch(path) {
  const targets = RADIO_MIRRORS.map((m) => `${m}${path}`);
  const init = { headers: { Accept: 'application/json', 'User-Agent': RADIO_UA } };
  let lastErr = null;
  for (const url of targets) {
    try {
      const res = await timedFetch(url, init, 12000);
      if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
      const payload = await res.json();
      if (!Array.isArray(payload)) throw new Error('mirror payload was not an array');
      return payload;
    } catch (error) {
      lastErr = error;
    }
  }
  throw lastErr || new Error('No Radio Browser mirror is available');
}

/**
 * Build a broker-shaped station catalog (same response contract as the Vite
 * dev-server broker: {stations, updatedAt, stale, degraded, ...}). Stateless:
 * no cross-request cache except a short edge cache on the response.
 */
async function buildRadioCatalog() {
  const jobs = RADIO_DIR_TAGS.map((tag, index) => (async () => {
    const params = new URLSearchParams({
      has_geo_info: 'true', is_https: 'true', hidebroken: 'true',
      order: 'clickcount', reverse: 'true',
      limit: String(index === 0 ? 300 : 120),
    });
    if (tag) params.set('tag', tag);
    try {
      const rows = await fetchRadioSearch(`/json/stations/search?${params}`);
      const stations = rows.map(normalizeRadioRow).filter(Boolean);
      const wanted = String(tag || '').toLowerCase();
      const covered = !wanted || stations.some((s) => s.tags.some((t) => t === wanted || t.includes(wanted)));
      return { succeeded: stations.length > 0 && covered, stations };
    } catch {
      return { succeeded: false, stations: [] };
    }
  })());
  const outcomes = await Promise.all(jobs);
  const selected = [];
  const seen = new Set();
  const take = (station) => {
    if (!station || seen.has(station.id) || selected.length >= RADIO_DIR_LIMIT) return;
    seen.add(station.id);
    selected.push(station);
  };
  for (const outcome of outcomes.slice(1)) outcome.stations.slice(0, 45).forEach(take);
  outcomes.flatMap((o) => o.stations)
    .sort((a, b) => (b.clickCount || 0) - (a.clickCount || 0) || a.name.localeCompare(b.name))
    .forEach(take);
  if (!selected.length) throw new Error('Radio directory returned no usable stations');
  const successfulQueries = outcomes.filter((o) => o.succeeded).length;
  return {
    stations: selected,
    updatedAt: new Date().toISOString(),
    stale: false,
    degraded: false,
    degradedReason: null,
    coverage: { successfulQueries, totalQueries: outcomes.length, stationCount: selected.length },
    acceptedGeneration: null,
    catalogInstance: 'worker',
  };
}

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
// CCTV (production parity with the vite dev broker)
// ---------------------------------------------------------------------------
const CCTV_UA = 'omni-eyes-cctv-worker/1.0';
const CCTV_FRAME_TIMEOUT_MS = 8000;
const CCTV_MAX_PLAYLIST_BYTES = 512 * 1024;
const CCTV_MAX_BYTES = 64 * 1024 * 1024;

function cctvNormalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png' || raw === 'gif') return 'image';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

function cctvIsVideo(feedType) {
  return feedType === 'mp4' || feedType === 'hls' || feedType === 'webm';
}

function cctvLoadSources(env) {
  const raw = (env.CCTV_SOURCES_JSON || '').trim();
  if (!raw) return { error: 'CCTV_SOURCES_JSON is not set' };
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.sources || [];
    if (!Array.isArray(list)) return { error: 'CCTV_SOURCES_JSON has no source list' };
    return { sources: list };
  } catch {
    return { error: 'CCTV_SOURCES_JSON is not valid JSON' };
  }
}

function cctvFind(sources, id) {
  return sources.find((s) => s && String(s.id) === String(id)) || null;
}

function cctvEscapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cctvHashSeed(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cctvSyntheticSvg({ cameraId, label, city, status }) {
  const seed = cctvHashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const safeLabel = cctvEscapeXml(label);
  const safeCity = cctvEscapeXml(city || 'GLOBAL GRID');
  const safeId = cctvEscapeXml(cameraId);
  const safeStatus = cctvEscapeXml(status || 'SYNTHETIC');
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${cctvEscapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

function cctvRewritePlaylist(text, playlistUrl, cameraId) {
  let base;
  try {
    base = new URL(playlistUrl);
  } catch {
    return String(text);
  }
  return String(text).split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    let abs;
    try {
      abs = new URL(t, base).toString();
    } catch {
      return line;
    }
    if (!/^https?:\/\//i.test(abs)) return line;
    return `/api/cctv/media/${encodeURIComponent(cameraId)}?u=${encodeURIComponent(abs)}`;
  }).join('\n');
}

async function handleCctv(request, url, env) {
  const path = url.pathname;
  const loaded = cctvLoadSources(env);
  if (loaded.error) {
    if (path.startsWith('/api/cctv/health')) return err(503, loaded.error, { cameras: [] });
    return err(503, loaded.error, { sources: [] });
  }
  const sources = loaded.sources;

  if (path === '/api/cctv/sources' || path === '/api/cctv/sources/') {
    return ok({ sources }, 'no-store');
  }

  if (path === '/api/cctv/health' || path === '/api/cctv/health/') {
    const now = Date.now();
    return ok({
      cameras: sources.map((s) => {
        const feedType = cctvNormalizeFeedType(s?.feedType);
        const live = typeof s?.url === 'string' && !!s.url.trim();
        return {
          id: String(s?.id || ''),
          status: live ? 'ok' : 'degraded',
          sourceKind: live ? (cctvIsVideo(feedType) ? 'live' : 'snapshot') : 'fallback',
          label: String(s?.provider || s?.name || ''),
          message: live ? 'Feed configured' : 'No upstream URL — placeholder',
          updatedAt: now,
        };
      }),
    }, 'no-store');
  }

  const streamMatch = path.match(/^\/api\/cctv\/stream\/([^/]+)\/?$/);
  if (streamMatch) {
    const cameraId = decodeURIComponent(streamMatch[1]).trim() || 'camera';
    const source = cctvFind(sources, cameraId);
    const feedType = cctvNormalizeFeedType(source?.feedType);
    return ok({
      id: cameraId,
      feedType,
      mediaUrl: cctvIsVideo(feedType) ? `/api/cctv/media/${encodeURIComponent(cameraId)}` : null,
      frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      provider: source?.provider || '',
      sourceKind: source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
    }, 'no-store');
  }

  const mediaMatch = path.match(/^\/api\/cctv\/media\/([^/]+)\/?$/);
  if (mediaMatch) {
    const cameraId = decodeURIComponent(mediaMatch[1]).trim() || 'camera';
    const source = cctvFind(sources, cameraId);
    const target = (url.searchParams.get('u') || source?.url || '').trim();
    if (!target || !/^https?:\/\//i.test(target)) {
      return err(404, 'No media URL configured for this camera');
    }
    const headers = { 'User-Agent': CCTV_UA, Accept: '*/*' };
    const range = request.headers.get('range');
    if (range) headers.Range = range;
    const upstream = await timedFetch(target, { headers }, 15000).catch(() => null);
    if (!upstream) return err(502, 'cctv upstream unreachable');
    if (!upstream.ok) return err(upstream.status, `cctv upstream HTTP ${upstream.status}`);
    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8(?:$|[?#])/i.test(target);
    if (isPlaylist) {
      const text = await upstream.text().catch(() => null);
      if (text === null) return err(502, 'cctv playlist unreadable');
      if (text.length > CCTV_MAX_PLAYLIST_BYTES) return err(502, 'cctv playlist too large');
      const rewritten = cctvRewritePlaylist(text, target, cameraId);
      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          ...corsHeaders({ 'Cache-Control': 'no-store', 'X-CCTV-Source': 'live-playlist' }),
        },
      });
    }
    const buf = await upstream.arrayBuffer().catch(() => null);
    if (!buf) return err(502, 'cctv upstream body unreadable');
    if (buf.byteLength > CCTV_MAX_BYTES) return err(502, 'cctv upstream response too large');
    const outHeaders = {
      'Content-Type': contentType || 'application/octet-stream',
      ...corsHeaders({ 'Cache-Control': 'no-store', 'X-CCTV-Source': 'live-media' }),
    };
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) outHeaders['Accept-Ranges'] = acceptRanges;
    return new Response(buf, { status: 200, headers: outHeaders });
  }

  const frameMatch = path.match(/^\/api\/cctv\/frame\/([^/]+)\/?$/);
  if (frameMatch) {
    const cameraId = decodeURIComponent(frameMatch[1]).trim() || 'camera';
    const source = cctvFind(sources, cameraId) || {};
    const feedType = cctvNormalizeFeedType(source.feedType);
    const candidate = source.snapshotUrl || (!cctvIsVideo(feedType) ? source.url : '');
    if (candidate && /^https?:\/\//i.test(candidate)) {
      const up = await timedFetch(candidate, {
        headers: { 'User-Agent': CCTV_UA, Accept: 'image/*,*/*' },
      }, CCTV_FRAME_TIMEOUT_MS).catch(() => null);
      const ct = up ? up.headers.get('content-type') || '' : '';
      if (up && up.ok && ct.startsWith('image/')) {
        const buf = await up.arrayBuffer().catch(() => null);
        if (buf && buf.byteLength > 0 && buf.byteLength <= 8 * 1024 * 1024) {
          return new Response(buf, {
            status: 200,
            headers: {
              'Content-Type': ct,
              ...corsHeaders({ 'Cache-Control': 'no-store', 'X-CCTV-Source': 'upstream-image' }),
            },
          });
        }
      }
    }
    const label = url.searchParams.get('label') || source.name || cameraId;
    const city = url.searchParams.get('city') || source.city || '';
    const svg = cctvSyntheticSvg({
      cameraId,
      label,
      city,
      status: source.url ? 'LIVE HLS — PLAYING VIA MEDIA' : 'NO UPSTREAM CONFIGURED',
    });
    return new Response(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        ...corsHeaders({ 'Cache-Control': 'no-store', 'X-CCTV-Source': 'synthetic' }),
      },
    });
  }

  return err(404, `unknown cctv route: ${path}`);
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

      // --- CCTV (sources / health / stream / media / frame) ------------------
      if (path === '/api/cctv' || path.startsWith('/api/cctv/')) {
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        return handleCctv(request, url, env);
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
        // Click accounting: uuid-shaped ids only, fire upstream, always 204.
        // Stateless worker keeps no served-set, so any well-formed uuid is accepted.
        const clickMatch = sub.match(/^\/click\/([0-9a-f-]+)$/i);
        if (clickMatch) {
          if (request.method !== 'POST') return err(405, 'Method Not Allowed');
          const id = clickMatch[1].toLowerCase();
          if (!RADIO_UUID_RE.test(id)) return err(404, 'Unknown radio station');
          const targets = RADIO_MIRRORS.map((m) => `${m}/json/url/${id}`);
          try {
            const res = await fetchFailover(
              targets,
              { headers: { Accept: 'application/json', 'User-Agent': RADIO_UA } },
              12000,
            );
            await res.text().catch(() => '');
          } catch { /* accounting is best-effort */ }
          return new Response(null, { status: 204, headers: corsHeaders({ 'Cache-Control': 'no-store' }) });
        }
        // Directory catalog in the dev-broker shape the app validates.
        if (sub !== '/stations') return err(404, 'Unknown radio route');
        if (request.method !== 'GET') return err(405, 'Method Not Allowed');
        try {
          const catalog = await buildRadioCatalog();
          return ok(catalog, 'public, max-age=300');
        } catch {
          return err(503, 'Radio directory is temporarily unavailable', { degraded: true, degradedReason: 'refresh-failed' });
        }
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
