/**
 * Tests for the static-hosting direct-fetch fallbacks.
 * fetch is stubbed per test; no network is touched.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ADSB_LOL_MIL_DIRECT,
  celestrakDirectUrl,
  discoverRadioMirrors,
  fetchMilitaryInstallationsDirect,
  fetchRadioDirectoryDirect,
  fetchWithProxyFallback,
  launchLibraryDirectUrl,
  normalizeApiBase,
  normalizeRadioBrowserRow,
  openskyDirectUrl,
  openskyDirectUrlFromProxyUrl,
  postOverpassWithDirectFallback,
  proxyUrlWithBase,
  resetApiBaseCacheForTests,
  resolveApiBase,
} from './staticDirect.js';

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function withFetchStub(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('proxy success never touches direct URLs', async () => {
  const seen = [];
  const restore = withFetchStub(async (url) => {
    seen.push(String(url));
    return jsonResponse({ states: [] });
  });
  try {
    const { response, source, triedDirect } = await fetchWithProxyFallback(
      '/api/opensky?lat=30&lon=-97',
      ['https://opensky-network.org/api/states/all?lamin=25'],
    );
    assert.ok(response.ok);
    assert.equal(source, 'proxy');
    assert.equal(triedDirect, false);
    assert.deepEqual(seen, ['/api/opensky?lat=30&lon=-97']);
  } finally {
    restore();
  }
});

test('proxy 404 (static hosting) falls back to the first healthy direct URL', async () => {
  const seen = [];
  const restore = withFetchStub(async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('/api/')) return jsonResponse({ error: 'nope' }, { status: 404 });
    if (String(url).includes('mirror-a')) return jsonResponse({ error: 'down' }, { status: 502 });
    return jsonResponse({ states: [[1]] });
  });
  try {
    const { response, source, triedDirect } = await fetchWithProxyFallback(
      '/api/opensky',
      ['https://mirror-a/states', 'https://mirror-b/states'],
    );
    assert.ok(response.ok);
    assert.equal(source, 'direct:mirror-b');
    assert.equal(triedDirect, true);
    assert.deepEqual(seen, ['/api/opensky', 'https://mirror-a/states', 'https://mirror-b/states']);
  } finally {
    restore();
  }
});

test('proxy rate-limit / upstream errors are respected, never bypassed direct', async () => {
  for (const status of [429, 500, 503, 401]) {
    const seen = [];
    const restore = withFetchStub(async (url) => {
      seen.push(String(url));
      return jsonResponse({ error: 'throttled' }, { status });
    });
    try {
      const { response, source, triedDirect } = await fetchWithProxyFallback(
        '/api/overpass',
        ['https://overpass-api.de/api/interpreter'],
        { method: 'POST' },
      );
      assert.equal(response.status, status);
      assert.equal(source, 'proxy');
      assert.equal(triedDirect, false);
      assert.deepEqual(seen, ['/api/overpass']);
    } finally {
      restore();
    }
  }
});

test('proxy throw + all directs failing returns the last direct response', async () => {
  const restore = withFetchStub(async (url) => {
    if (String(url).startsWith('/api/')) throw new TypeError('fetch failed');
    return jsonResponse({ error: 'down' }, { status: 503 });
  });
  try {
    const { response, triedDirect } = await fetchWithProxyFallback('/api/x', ['https://d1', 'https://d2']);
    assert.equal(response.status, 503);
    assert.equal(triedDirect, true);
  } finally {
    restore();
  }
});

test('abort errors are never swallowed by the fallback', async () => {
  const abort = new DOMException('aborted', 'AbortError');
  const restore = withFetchStub(async () => { throw abort; });
  try {
    await assert.rejects(fetchWithProxyFallback('/api/x', ['https://d1']), (error) => error === abort);
  } finally {
    restore();
  }
});

test('opensky direct URL carries a bbox around the proxy anchor', () => {
  const url = new URL(openskyDirectUrlFromProxyUrl('/api/opensky?lat=30.0000&lon=-97.0000'));
  assert.equal(url.hostname, 'opensky-network.org');
  assert.equal(url.searchParams.get('lamin'), '25');
  assert.equal(url.searchParams.get('lamax'), '35');
  assert.equal(url.searchParams.get('lomin'), '-102');
  assert.equal(url.searchParams.get('lomax'), '-92');
  const global = new URL(openskyDirectUrl(NaN, NaN));
  assert.equal(global.search, '');
});

test('opensky + celestrak + launch-library direct URL shapes', () => {
  assert.ok(openskyDirectUrl(10, 20).startsWith('https://opensky-network.org/api/states/all?'));
  assert.equal(
    celestrakDirectUrl('stations'),
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
  );
  const ll = new URL(launchLibraryDirectUrl(30, 100));
  assert.equal(ll.hostname, 'll.thespacedevs.com');
  assert.equal(ll.searchParams.get('limit'), '100');
  assert.equal(ll.searchParams.get('mode'), 'detailed');
  assert.ok(ll.searchParams.get('net__gte'));
  assert.equal(ADSB_LOL_MIL_DIRECT, 'https://api.adsb.lol/v2/mil');
});

test('postOverpassWithDirectFallback POSTs the same body to proxy then mirrors', async () => {
  const seen = [];
  const restore = withFetchStub(async (url, init) => {
    seen.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).startsWith('/api/')) return jsonResponse({}, { status: 404 });
    return jsonResponse({ elements: [] });
  });
  try {
    const { response, source } = await postOverpassWithDirectFallback('data=%5Bout%3Ajson%5D');
    assert.ok(response.ok);
    assert.match(source, /^direct:/);
    assert.equal(seen[0].method, 'POST');
    assert.ok(seen.every((entry) => entry.body === 'data=%5Bout%3Ajson%5D'));
    assert.ok(seen[1].url.startsWith('https://overpass-api.de/'));
  } finally {
    restore();
  }
});

const VALID_ROW = {
  stationuuid: '12345678-1234-1234-1234-1234567890ab',
  name: 'Test Station',
  url_resolved: 'https://stream.example.com/live',
  homepage: 'https://example.com',
  tags: 'news,talk',
  language: 'English',
  country: 'Germany',
  countrycode: 'DE',
  state: 'Berlin',
  geo_lat: 52.5,
  geo_long: 13.4,
  codec: 'MP3',
  bitrate: 128,
  hls: 0,
  lastcheckok: 1,
  clickcount: 42,
};

test('normalizeRadioBrowserRow accepts a valid mirror row', () => {
  const station = normalizeRadioBrowserRow(VALID_ROW);
  assert.ok(station);
  assert.equal(station.id, VALID_ROW.stationuuid);
  assert.equal(station.metadataTrust, 'untrusted-community');
  assert.equal(station.countryCode, 'DE');
});

test('normalizeRadioBrowserRow rejects bad rows like the proxy', () => {
  assert.equal(normalizeRadioBrowserRow({ ...VALID_ROW, lastcheckok: 0 }), null);
  assert.equal(normalizeRadioBrowserRow({ ...VALID_ROW, hls: 1 }), null);
  assert.equal(normalizeRadioBrowserRow({ ...VALID_ROW, codec: 'FLAC' }), null);
  assert.equal(normalizeRadioBrowserRow({ ...VALID_ROW, url_resolved: 'http://insecure.example.com/x' }), null);
  assert.equal(normalizeRadioBrowserRow({ ...VALID_ROW, stationuuid: 'not-a-uuid' }), null);
  assert.equal(normalizeRadioBrowserRow({ ...VALID_ROW, geo_lat: null }), null);
});

test('discoverRadioMirrors falls back to hardcoded mirrors when discovery fails', async () => {
  const restore = withFetchStub(async () => { throw new TypeError('fetch failed'); });
  try {
    const mirrors = await discoverRadioMirrors({});
    assert.deepEqual(mirrors, [
      'https://de1.api.radio-browser.info',
      'https://de2.api.radio-browser.info',
      'https://nl1.api.radio-browser.info',
    ]);
  } finally {
    restore();
  }
});

test('discoverRadioMirrors honors discovery and rejects rogue hostnames', async () => {
  const restore = withFetchStub(async () => jsonResponse([
    { name: 'de1.api.radio-browser.info' },
    { name: 'evil.example.com' },
    { name: 'de1.api.radio-browser.info' },
  ]));
  try {
    assert.deepEqual(await discoverRadioMirrors({}), ['https://de1.api.radio-browser.info']);
  } finally {
    restore();
  }
});

test('fetchRadioDirectoryDirect shapes mirror rows like the broker body', async () => {
  const restore = withFetchStub(async (url) => {
    if (String(url).includes('/json/servers')) {
      return jsonResponse([{ name: 'de1.api.radio-browser.info' }]);
    }
    return jsonResponse([{ ...VALID_ROW }, { ...VALID_ROW, stationuuid: 'bad' }]);
  });
  try {
    const body = await fetchRadioDirectoryDirect({});
    assert.ok(Array.isArray(body.stations));
    assert.equal(body.stations.length, 1);
    assert.ok(Date.parse(body.updatedAt) > 0);
    assert.equal(body.stale, false);
    assert.equal(typeof body.degraded, 'boolean');
    assert.equal(body.acceptedGeneration, null);
    // Broker-public rows carry no internal click signal.
    assert.ok(!('clickCount' in body.stations[0]));
  } finally {
    restore();
  }
});

test('fetchMilitaryInstallationsDirect shapes Overpass elements like the proxy', async () => {
  const restore = withFetchStub(async (url) => {
    if (String(url).startsWith('/api/')) return jsonResponse({}, { status: 404 });
    return jsonResponse({ elements: [{ type: 'node', id: 1, lat: 30, lon: -97, tags: { military: 'base' } }] });
  });
  try {
    const box = { south: 29, west: -98, north: 31, east: -96 };
    const payload = await fetchMilitaryInstallationsDirect(box, {});
    assert.equal(payload.elements.length, 1);
    assert.equal(payload.elementCap, 700);
    assert.equal(payload.saturated, false);
    assert.equal(payload.status, 'ready');
    assert.ok(Date.parse(payload.retrievedAt) > 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// API-base resolution (Worker / hosted-API deployments; default '' = static)
// ---------------------------------------------------------------------------

function saveApiBaseGlobals() {
  return {
    window: globalThis.window,
    location: globalThis.location,
    hadWindow: Object.hasOwn(globalThis, 'window'),
    hadLocation: Object.hasOwn(globalThis, 'location'),
  };
}

function restoreApiBaseGlobals(saved) {
  if (saved.hadWindow) globalThis.window = saved.window;
  else delete globalThis.window;
  if (saved.hadLocation) globalThis.location = saved.location;
  else delete globalThis.location;
  resetApiBaseCacheForTests();
}

test('normalizeApiBase trims, strips slashes, empties blanks', () => {
  assert.equal(normalizeApiBase('  https://api.example.com/// '), 'https://api.example.com');
  assert.equal(normalizeApiBase('https://api.example.com'), 'https://api.example.com');
  assert.equal(normalizeApiBase(''), '');
  assert.equal(normalizeApiBase(null), '');
  assert.equal(normalizeApiBase('   '), '');
  assert.equal(normalizeApiBase('/'), '');
});

test('resolveApiBase defaults to empty so static behavior is unchanged', () => {
  const saved = saveApiBaseGlobals();
  try {
    delete globalThis.window;
    delete globalThis.location;
    resetApiBaseCacheForTests();
    assert.equal(resolveApiBase(), '');
    assert.equal(proxyUrlWithBase('/api/opensky?lat=30'), '/api/opensky?lat=30');
  } finally {
    restoreApiBaseGlobals(saved);
  }
});

test('resolveApiBase honors window.__GEV_API_BASE__', () => {
  const saved = saveApiBaseGlobals();
  try {
    delete globalThis.location;
    resetApiBaseCacheForTests();
    globalThis.window = { __GEV_API_BASE__: 'https://api.example.com/' };
    assert.equal(resolveApiBase(), 'https://api.example.com');
    assert.equal(proxyUrlWithBase('/api/overpass'), 'https://api.example.com/api/overpass');
  } finally {
    restoreApiBaseGlobals(saved);
  }
});

test('?api= boot override wins and is read once', () => {
  const saved = saveApiBaseGlobals();
  try {
    globalThis.window = { __GEV_API_BASE__: 'https://window.example.com' };
    globalThis.location = { search: '?api=https%3A%2F%2Fboot.example.com%2F' };
    resetApiBaseCacheForTests();
    assert.equal(resolveApiBase(), 'https://boot.example.com');
    // Read-once: later query changes are ignored until an explicit reset.
    globalThis.location = { search: '?api=https://other.example.com' };
    assert.equal(resolveApiBase(), 'https://boot.example.com');
    resetApiBaseCacheForTests();
    assert.equal(resolveApiBase(), 'https://other.example.com');
  } finally {
    restoreApiBaseGlobals(saved);
  }
});

test('proxyUrlWithBase leaves absolute and non-proxy URLs untouched', () => {
  const saved = saveApiBaseGlobals();
  try {
    delete globalThis.location;
    resetApiBaseCacheForTests();
    globalThis.window = { __GEV_API_BASE__: 'https://api.example.com' };
    assert.equal(
      proxyUrlWithBase('https://overpass-api.de/api/interpreter'),
      'https://overpass-api.de/api/interpreter',
    );
    assert.equal(proxyUrlWithBase('/tiles/0/0/0.pbf'), '/tiles/0/0/0.pbf');
    assert.equal(proxyUrlWithBase('/apiary/x'), '/apiary/x');
  } finally {
    restoreApiBaseGlobals(saved);
  }
});

test('fetchWithProxyFallback prefixes the proxy call when a base is set', async () => {
  const saved = saveApiBaseGlobals();
  const seen = [];
  const restore = withFetchStub(async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('https://api.example.com/api/')) {
      return jsonResponse({ error: 'nope' }, { status: 404 });
    }
    return jsonResponse({ states: [] });
  });
  try {
    delete globalThis.location;
    resetApiBaseCacheForTests();
    globalThis.window = { __GEV_API_BASE__: 'https://api.example.com' };
    const { response, source, triedDirect } = await fetchWithProxyFallback(
      '/api/opensky?lat=30&lon=-97',
      ['https://opensky-network.org/api/states/all?lamin=25'],
    );
    assert.ok(response.ok);
    assert.equal(source, 'direct:opensky-network.org');
    assert.equal(triedDirect, true);
    assert.deepEqual(seen, [
      'https://api.example.com/api/opensky?lat=30&lon=-97',
      'https://opensky-network.org/api/states/all?lamin=25',
    ]);
  } finally {
    restore();
    restoreApiBaseGlobals(saved);
  }
});
