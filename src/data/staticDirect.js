/**
 * @module staticDirect
 * @description Direct-browser fetch fallbacks for static hosting (GitHub Pages).
 *
 * The Vite dev server proxies `/api/*` to CORS-restricted or credentialed
 * upstreams. On a static host those same-origin routes 404, so every layer
 * below tries its proxy FIRST (preserving dev behavior, caching, and key
 * gating) and falls back to a direct keyless browser fetch only when the
 * proxy is unreachable or refuses. Every fallback keeps the layer's existing
 * degrade semantics: per-group / per-feed / per-mirror degradation, stale
 * catalog retention, and honest error labels.
 *
 * No Cesium dependency — pure fetch helpers, unit-testable in Node.
 */
import { normalizeRadioCountryInput } from './radioCountry.js';

/** Overpass API mirrors tried in order for direct browser POSTs (all send CORS *). */
export const OVERPASS_DIRECT_MIRRORS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]);

/** CelesTrak GP/TLE endpoint for one group (CORS-open: sends Access-Control-Allow-Origin *, verified live). */
export function celestrakDirectUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', String(group));
  url.searchParams.set('FORMAT', 'tle');
  return url.toString();
}

/** Anonymous OpenSky states endpoint (keyless, but browser-restricted: ACAO allows only opensky-network.org, so expect degrade on static hosts). */
export const OPENSKY_DIRECT_BASE = 'https://opensky-network.org/api/states/all';

/** Half-width in degrees of the anonymous OpenSky bbox around the view anchor. */
export const OPENSKY_DIRECT_BBOX_HALF_DEG = 5;

/**
 * Build an anonymous OpenSky bbox URL around a view anchor.
 * Without an anchor the global snapshot is used (heavier, rate-limited faster).
 */
export function openskyDirectUrl(latitude, longitude) {
  const url = new URL(OPENSKY_DIRECT_BASE);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    url.searchParams.set('lamin', String(Math.max(-90, latitude - OPENSKY_DIRECT_BBOX_HALF_DEG)));
    url.searchParams.set('lomin', String(longitude - OPENSKY_DIRECT_BBOX_HALF_DEG));
    url.searchParams.set('lamax', String(Math.min(90, latitude + OPENSKY_DIRECT_BBOX_HALF_DEG)));
    url.searchParams.set('lomax', String(longitude + OPENSKY_DIRECT_BBOX_HALF_DEG));
  }
  return url.toString();
}

/**
 * Derive the direct OpenSky URL from a proxy URL that carries ?lat=&lon=.
 * Falls back to the global snapshot when the proxy URL has no anchor.
 */
export function openskyDirectUrlFromProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(String(proxyUrl), 'http://localhost');
    const lat = Number(parsed.searchParams.get('lat'));
    const lon = Number(parsed.searchParams.get('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) return openskyDirectUrl(lat, lon);
  } catch { /* fall through to global */ }
  return openskyDirectUrl(NaN, NaN);
}

/** Anonymous OpenSky track endpoint for one aircraft (same shape as the proxy). */
export function openskyTrackDirectUrl(icao24) {
  return `https://opensky-network.org/api/tracks/all?icao24=${encodeURIComponent(String(icao24))}&time=0`;
}

/** Keyless adsb.lol military snapshot (no CORS headers upstream — expect degrade on static hosts, proxy path preferred). */
export const ADSB_LOL_MIL_DIRECT = 'https://api.adsb.lol/v2/mil';

/** Direct adsb.lol readsb trace (mirrors the /api/adsblol/trace proxy upstream). */
export function adsbLolTraceDirectUrl(hex) {
  const clean = String(hex || '').toLowerCase();
  return `https://adsb.lol/data/traces/${clean.slice(-2)}/trace_full_${clean}.json`;
}

/** Keyless Launch Library 2 recent-launch window (CORS *). */
export function launchLibraryDirectUrl(windowDays = 30, limit = 100) {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('mode', 'detailed');
  return url.toString();
}

/** Radio Browser mirror discovery (client-side, CORS *). */
export const RADIO_MIRROR_DISCOVERY_URL = 'https://all.api.radio-browser.info/json/servers';

/** Hardcoded Radio Browser mirrors when discovery itself is unreachable. */
export const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);

/** Proxy statuses proving the route is ABSENT (static hosting), not throttled. */
const PROXY_MISSING_STATUSES = new Set([404, 405, 501]);

/**
 * Whether a proxy failure means "no proxy here" (fall back direct) rather
 * than "proxy alive, upstream throttled" (respect it — hammering direct
 * mirrors would dodge the proxy's rate limiting and multiply load).
 */
export function isProxyMissing(response) {
  return !!response && PROXY_MISSING_STATUSES.has(response.status);
}

/** True for AbortError-shaped failures (never a trigger for direct fallback). */
export function isAbortError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || String(error?.message || '').toLowerCase().includes('aborted');
}

// ---------------------------------------------------------------------------
// API base: where same-origin /api/* calls go (static hosting + Workers)
// ---------------------------------------------------------------------------

/**
 * Normalize a configured API base: trimmed, no trailing slashes.
 * Empty/blank input yields '' (same-origin relative behavior, unchanged).
 */
export function normalizeApiBase(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

/**
 * Read the build-time API base (Vite `define`, see vite.config.js).
 * The direct `import.meta.env.GEV_API_BASE` member access is intentional so
 * Vite statically replaces it at build time; the guarded read keeps plain
 * Node (unit tests) working where `import.meta.env` is undefined.
 */
function readBuildApiBase() {
  try {
    if (typeof import.meta.env?.GEV_API_BASE === 'string') return import.meta.env.GEV_API_BASE;
  } catch { /* plain Node: no import.meta.env — fall through to '' */ }
  return '';
}

let bootApiBaseRead = false;
let bootApiBaseValue = '';

/** Read the `?api=<base>` boot override once (cached; see resolveApiBase). */
function readBootApiBaseOverride() {
  if (bootApiBaseRead) return bootApiBaseValue;
  bootApiBaseRead = true;
  bootApiBaseValue = '';
  try {
    const search = globalThis.location?.search;
    if (typeof search === 'string' && search) {
      bootApiBaseValue = normalizeApiBase(new URLSearchParams(search).get('api'));
    }
  } catch { bootApiBaseValue = ''; }
  return bootApiBaseValue;
}

/** Reset the cached `?api=` boot override (unit tests only). */
export function resetApiBaseCacheForTests() {
  bootApiBaseRead = false;
  bootApiBaseValue = '';
}

/**
 * Resolve the API base for proxied calls.
 * Precedence: `?api=<base>` boot override > `window.__GEV_API_BASE__` >
 * `import.meta.env.GEV_API_BASE` > `''` (same-origin, current static behavior).
 */
export function resolveApiBase() {
  const boot = readBootApiBaseOverride();
  if (boot) return boot;
  try {
    const runtime = globalThis.window?.__GEV_API_BASE__;
    if (typeof runtime === 'string' && runtime.trim()) return normalizeApiBase(runtime);
  } catch { /* ignore exotic window shims */ }
  const build = readBuildApiBase();
  if (build.trim()) return normalizeApiBase(build);
  return '';
}

/**
 * Prefix a same-origin `/api/*` proxy path with the configured API base.
 * Absolute/direct upstream URLs pass through untouched, so this is safe to
 * apply to every proxyUrl handed to fetchWithProxyFallback.
 */
export function proxyUrlWithBase(proxyUrl) {
  if (typeof proxyUrl !== 'string' || !/^\/api(?=\/|$|\?)/.test(proxyUrl)) return proxyUrl;
  const base = resolveApiBase();
  if (!base) return proxyUrl;
  return `${base}${proxyUrl}`;
}

/**
 * Fetch a same-origin proxy URL, falling back to direct upstream URLs when the
 * proxy is missing (static hosting 404), refuses, or is unreachable.
 *
 * Contract: proxy is ALWAYS tried first, so dev-server caching/auth and all
 * existing stubbed-fetch tests behave byte-identically. Direct URLs are tried
 * ONLY when the proxy is absent (HTTP 404/405/501) or unreachable — a live
 * proxy's own error (429/500/auth) is returned untouched so rate limits,
 * backoffs, and serve-stale semantics keep working exactly as before.
 *
 * @param {string} proxyUrl - Same-origin /api/* URL (prefixed with the
 *   configured API base, if any — see proxyUrlWithBase).
 * @param {string[]} directUrls - Direct upstream URLs tried after proxy failure.
 * @param {object} [init] - fetch init passed to every attempt.
 * @returns {Promise<{response: Response, source: string, triedDirect: boolean}>}
 */
export async function fetchWithProxyFallback(proxyUrl, directUrls = [], init) {
  const resolvedProxyUrl = proxyUrlWithBase(proxyUrl);
  let proxyResponse = null;
  try {
    const res = await fetch(resolvedProxyUrl, init);
    if (res.ok) return { response: res, source: 'proxy', triedDirect: false };
    // The proxy answered with a real HTTP error (rate limit, upstream 5xx,
    // auth refusal): respect it exactly as before — only an ABSENT proxy
    // (static-hosting 404/405/501) or an unreachable one falls through.
    if (!isProxyMissing(res)) return { response: res, source: 'proxy', triedDirect: false };
    proxyResponse = res;
  } catch (error) {
    if (isAbortError(error)) throw error;
    proxyResponse = null;
  }
  let lastError = null;
  let lastResponse = null;
  for (const url of directUrls) {
    try {
      const res = await fetch(url, init);
      if (res.ok) {
        let host = 'direct';
        try { host = new URL(url).hostname; } catch { /* keep generic */ }
        return { response: res, source: `direct:${host}`, triedDirect: true };
      }
      lastResponse = res;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }
  if (proxyResponse) return { response: proxyResponse, source: 'proxy', triedDirect: true };
  if (lastResponse) return { response: lastResponse, source: 'proxy', triedDirect: true };
  throw lastError || new Error('Static fetch fallback failed with no response');
}

/**
 * POST an Overpass QL body to the proxy, then directly to public mirrors.
 * @param {string} body - URL-encoded `data=...` POST body.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{response: Response, source: string, triedDirect: boolean}>}
 */
export function postOverpassWithDirectFallback(body, { signal } = {}) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    ...(signal ? { signal } : {}),
  };
  return fetchWithProxyFallback('/api/overpass', [...OVERPASS_DIRECT_MIRRORS], init);
}

// ---------------------------------------------------------------------------
// Radio Browser direct directory (client-side mirror discovery)
// ---------------------------------------------------------------------------

const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RADIO_MIRROR_HOST_RE = /^[a-z0-9-]+\.api\.radio-browser\.info$/;
const RADIO_DIRECTORY_LIMIT = 750;
const RADIO_BROAD_RESULTS = 1800;
const RADIO_TAG_RESULTS = 220;

function cleanRadioText(value, maxLength) {
  return String(value ?? '')
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || !hostname) return null;
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.includes(':')
    ) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Client-side mirror of the proxy's normalizeRadioBrowserStation: same accept
 * rules (uuid, lastcheckok, no HLS, geo present, allow-listed audio codec,
 * public https stream) so direct rows pass the layer's directory validation.
 */
export function normalizeRadioBrowserRow(raw) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? null : Number(raw?.geo_long);
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  const streamUrl = publicRadioHttpsUrl(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id)
    || Number(raw?.lastcheckok) !== 1
    || Number(raw?.hls) === 1
    || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lon) || lon < -180 || lon > 180
    || !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec)
    || !streamUrl
  ) return null;
  const name = cleanRadioText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '')
    .split(',')
    .map((tag) => cleanRadioText(tag, 80).toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 24);
  const languages = String(raw?.language ?? '')
    .split(',')
    .map((language) => cleanRadioText(language, 40))
    .filter(Boolean)
    .slice(0, 8);
  const normalizedCode = normalizeRadioCountryInput(cleanRadioText(raw?.countrycode, 2).toUpperCase());
  const normalizedCountry = normalizedCode.valid && !normalizedCode.empty
    ? normalizedCode
    : normalizeRadioCountryInput(cleanRadioText(raw?.country, 80));
  const bitrate = Number(raw?.bitrate);
  return {
    id,
    name,
    lat,
    lon,
    streamUrl,
    homepage: publicRadioHttpsUrl(raw?.homepage),
    tags,
    languages,
    state: cleanRadioText(raw?.state, 80),
    country: normalizedCountry.valid && !normalizedCountry.empty
      ? normalizedCountry.name
      : cleanRadioText(raw?.country, 80),
    countryCode: normalizedCountry.valid ? normalizedCountry.code : '',
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
  };
}

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!RADIO_MIRROR_HOST_RE.test(hostname)) return null;
  return `https://${hostname}`;
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, values.length))).fill(null).map(async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Discover usable Radio Browser mirrors client-side (discovery + hardcoded fallback). */
export async function discoverRadioMirrors({ signal } = {}) {
  try {
    const res = await fetch(RADIO_MIRROR_DISCOVERY_URL, {
      ...(signal ? { signal } : {}),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const rows = await res.json();
      const origins = (Array.isArray(rows) ? rows : [])
        .map((row) => radioMirrorOrigin(row?.name))
        .filter(Boolean);
      if (origins.length) return [...new Set(origins)];
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  return [...RADIO_FALLBACK_MIRRORS];
}

async function fetchRadioPath(mirrors, pathname, { signal } = {}) {
  let lastError = null;
  for (const origin of mirrors) {
    try {
      const res = await fetch(`${origin}${pathname}`, {
        ...(signal ? { signal } : {}),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Radio mirror HTTP ${res.status}`);
      const payload = await res.json();
      if (!Array.isArray(payload)) throw new Error('Radio mirror payload was not an array');
      return payload;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('No Radio Browser mirror is available');
}

/**
 * Fetch the station directory directly from Radio Browser mirrors and shape it
 * like the `/api/radio/stations` broker body ({stations, updatedAt, stale,
 * degraded, acceptedGeneration}) so the layer's existing validation passes.
 */
export async function fetchRadioDirectoryDirect({ signal } = {}) {
  const mirrors = await discoverRadioMirrors({ signal });
  const queries = [null, 'news', 'talk', 'weather', 'emergency', 'aviation', 'marine', 'traffic'];
  const outcomes = await mapConcurrent(queries, 3, async (tag, index) => {
    const params = new URLSearchParams({
      has_geo_info: 'true',
      is_https: 'true',
      hidebroken: 'true',
      order: 'clickcount',
      reverse: 'true',
      limit: String(index === 0 ? RADIO_BROAD_RESULTS : RADIO_TAG_RESULTS),
    });
    if (tag) params.set('tag', tag);
    try {
      const rows = await fetchRadioPath(mirrors, `/json/stations/search?${params}`, { signal });
      const stations = rows.map(normalizeRadioBrowserRow).filter(Boolean);
      const wanted = String(tag || '').toLowerCase();
      const tagCovered = !wanted || stations.some((station) => (
        station.tags.some((stationTag) => stationTag === wanted || stationTag.includes(wanted))
      ));
      return { succeeded: stations.length > 0 && tagCovered, stations };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { succeeded: false, stations: [] };
    }
  });
  const selected = [];
  const seen = new Set();
  const take = (station) => {
    if (!station || seen.has(station.id) || selected.length >= RADIO_DIRECTORY_LIMIT) return;
    seen.add(station.id);
    selected.push(station);
  };
  // Specialist tag coverage first so operational categories survive a musical click chart.
  for (const outcome of outcomes.slice(1)) outcome.stations.slice(0, 45).forEach(take);
  outcomes
    .flatMap((outcome) => outcome.stations)
    .sort((a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name))
    .forEach(take);
  if (!selected.length) throw new Error('Radio directory returned no usable stations');
  const successfulQueries = outcomes.filter((outcome) => outcome.succeeded).length;
  const degraded = successfulQueries < 5
    || !outcomes[0].succeeded
    || selected.length < Math.ceil(RADIO_DIRECTORY_LIMIT / 2);
  return {
    stations: selected.map(({
      // clickCount is broker-internal ranking signal; the public row omits it.
      clickCount: _dropped,
      ...publicRow
    }) => publicRow),
    updatedAt: new Date().toISOString(),
    stale: false,
    degraded,
    acceptedGeneration: null,
  };
}

// ---------------------------------------------------------------------------
// Mapped-installations direct Overpass payload (same QL + shape as the proxy)
// ---------------------------------------------------------------------------

/** Element cap matching the proxy so saturation semantics stay identical. */
export const MILITARY_INSTALLATION_ELEMENT_CAP = 700;

/** Same QL the /api/military-installations proxy issues for a viewport box. */
export function militaryInstallationQueryForBox(box) {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  return `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${bbox});nwr["landuse"="military"](${bbox}););out center tags geom ${MILITARY_INSTALLATION_ELEMENT_CAP};`;
}

/**
 * Query Overpass directly for mapped military features and shape the result
 * like the proxy body ({elements, saturated, elementCap, retrievedAt, status})
 * for normalizeMilitaryInstallations().
 */
export async function fetchMilitaryInstallationsDirect(box, { signal } = {}) {
  const query = militaryInstallationQueryForBox(box);
  const body = `data=${encodeURIComponent(query)}`;
  const { response } = await postOverpassWithDirectFallback(body, { signal });
  if (!response.ok) throw new Error(`Installation feed HTTP ${response.status}`);
  const parsed = await response.json();
  const elements = Array.isArray(parsed?.elements)
    ? parsed.elements.slice(0, MILITARY_INSTALLATION_ELEMENT_CAP)
    : [];
  return {
    elements,
    saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
    elementCap: MILITARY_INSTALLATION_ELEMENT_CAP,
    retrievedAt: new Date().toISOString(),
    status: 'ready',
  };
}
