/**
 * Static-hosting fallback tests: one per changed fetcher.
 * Each test stubs fetch as "proxy 404 (Pages) + direct upstream OK" and drives
 * the layer's REAL entry point, asserting the direct URL was requested and the
 * data still lands. Proxy-first behavior is covered by the existing per-layer
 * tests; the shared mechanism by staticDirect.test.mjs.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import flightsLayer from './flights.js';
import militaryFlightsLayer from './militaryFlights.js';
import { isMilitaryIcao, refreshMilitaryRegistryIfStale } from './militaryRegistry.js';
import radioLayer from './radio.js';
import satellitesLayer from './satellites.js';
import rocketLaunchesLayer, { _setRocketMissionOverlayHostForTest } from './rocketLaunches.js';
import militaryInstallationsLayer from './militaryInstallations.js';

function restoreFetch(original) {
  globalThis.fetch = original;
}

const OPENSKY_STATE = [
  'a1b2c3', 'DAL123 ', 'United States', 0, 0,
  -97.6, 30.3, 10_668, false, 250, 95, 5, null, 10_700,
  null, null, null, 5,
];

function stubBrowserGlobals() {
  globalThis.document = {
    body: { classList: { contains: () => false } },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
}

function makeAircraftViewer() {
  return {
    camera: { positionCartographic: null },
    trackedEntityChanged: { addEventListener() { return () => {}; } },
    scene: {
      primitives: { add(collection) { return collection; }, remove() {}, raiseToTop() {} },
      preRender: { addEventListener() { return () => {}; } },
      canvas: { addEventListener() {}, removeEventListener() {} },
    },
  };
}

test('military registry: proxy 404 falls back to the direct military feed', async () => {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).startsWith('/api/')) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ac: [{ hex: 'F00DAD' }] }) };
  };
  try {
    refreshMilitaryRegistryIfStale();
    const deadline = Date.now() + 2000;
    while (!isMilitaryIcao('f00dad') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(isMilitaryIcao('f00dad'), 'direct feed populates the registry');
    assert.ok(requested.includes('https://api.adsb.lol/v2/mil'));
  } finally {
    restoreFetch(original);
  }
});

test('flights: proxy 404 falls back to the direct OpenSky snapshot', async () => {
  const original = globalThis.fetch;
  stubBrowserGlobals();
  const viewer = makeAircraftViewer();
  const requested = [];
  const nowSec = Math.floor(Date.now() / 1000);
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).startsWith('/api/adsblol')) {
      return { ok: true, status: 200, json: async () => ({ ac: [] }) };
    }
    if (String(url).startsWith('/api/')) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ time: nowSec, states: [OPENSKY_STATE] }),
    };
  };
  try {
    flightsLayer.init(viewer);
    await flightsLayer.update(viewer);
    assert.ok(
      requested.some((url) => url.startsWith('https://opensky-network.org/api/states/all')),
      `direct OpenSky URL requested, saw: ${requested.join(', ')}`,
    );
    assert.equal(flightsLayer.getStats().error, null);
    assert.equal(flightsLayer.getAnalystRecords().length, 1);
    assert.match(flightsLayer.getStats().source, /direct/);
  } finally {
    restoreFetch(original);
  }
});

test('military flights: proxy 404 falls back to api.adsb.lol/v2/mil direct', async () => {
  const original = globalThis.fetch;
  stubBrowserGlobals();
  const viewer = makeAircraftViewer();
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).startsWith('/api/')) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ac: [{
          hex: 'ae01ce', lon: -96.9, lat: 31.1, alt_baro: 28_000,
          track: 95, gs: 400, flight: 'RCH451 ', t: 'C17',
        }],
      }),
    };
  };
  try {
    militaryFlightsLayer.init(viewer);
    await militaryFlightsLayer.update(viewer);
    assert.ok(
      requested.includes('https://api.adsb.lol/v2/mil'),
      `direct adsb.lol URL requested, saw: ${requested.join(', ')}`,
    );
    assert.equal(militaryFlightsLayer.getStats().error, null);
    assert.equal(militaryFlightsLayer.getAnalystRecords().length, 1);
  } finally {
    restoreFetch(original);
  }
});

test('radio: broker 404 falls back to client-side mirror discovery', async () => {
  const original = globalThis.fetch;
  const requested = [];
  const station = {
    stationuuid: '12345678-1234-1234-1234-1234567890ab',
    name: 'Static Fallback FM',
    url_resolved: 'https://stream.example.com/live',
    homepage: 'https://example.com',
    tags: 'news',
    language: 'English',
    country: 'United States',
    countrycode: 'US',
    state: 'Texas',
    geo_lat: 30.27,
    geo_long: -97.74,
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    clickcount: 10,
  };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('/json/servers')) {
      return { ok: true, status: 200, json: async () => [{ name: 'de1.api.radio-browser.info' }] };
    }
    if (String(url).includes('api.radio-browser.info')) {
      return { ok: true, status: 200, json: async () => [station] };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await radioLayer.update();
    assert.ok(
      requested.some((url) => url.includes('all.api.radio-browser.info/json/servers')),
      `mirror discovery requested, saw: ${requested.join(', ')}`,
    );
    assert.equal(radioLayer.getUIState().stationCount, 1);
    // One usable station is below the broker's healthy-coverage policy, so the
    // layer reports degraded coverage AND still plays the station it got.
    assert.equal(radioLayer.getUIState().error, 'Radio directory coverage is degraded.');
  } finally {
    radioLayer.destroy();
    restoreFetch(original);
  }
});

test('satellites: proxy 404 falls back to per-group CelesTrak direct with degrade', async () => {
  const original = globalThis.fetch;
  const requested = [];
  const TLE = 'ISS (ZARYA)\n'
    + '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n'
    + '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const viewer = {
    camera: {},
    trackedEntityChanged: { addEventListener() { return () => {}; } },
    scene: {
      primitives: { add(collection) { return collection; }, remove() {} },
      preRender: { addEventListener() { return () => {}; } },
      canvas: { addEventListener() {}, removeEventListener() {} },
    },
  };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).startsWith('/api/')) {
      return { ok: false, status: 404, text: async () => '' };
    }
    // Bulk-belt group refuses direct: per-group degrade must keep the rest.
    if (String(url).includes('GROUP=geo')) {
      return { ok: false, status: 403, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => TLE };
  };
  try {
    await satellitesLayer.init(viewer);
    await satellitesLayer.update(viewer);
    assert.ok(
      requested.some((url) => url.startsWith('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations')),
      `direct CelesTrak URL requested, saw: ${requested.join(', ')}`,
    );
    assert.equal(satellitesLayer.getStats().count, 1);
    assert.match(satellitesLayer.getStats().error || '', /CelesTrak group unavailable/);
  } finally {
    satellitesLayer.destroy(viewer);
    restoreFetch(original);
  }
});

test('space missions: proxy 404 falls back to Launch Library 2 direct', async () => {
  const realDocument = globalThis.document;
  const realFetch = globalThis.fetch;
  const realHtmlCanvasElement = globalThis.HTMLCanvasElement;
  const realHtmlImageElement = globalThis.HTMLImageElement;
  const realImageBitmap = globalThis.ImageBitmap;
  const realOffscreenCanvas = globalThis.OffscreenCanvas;
  const listeners = new Map();
  const reticleContext = {
    strokeStyle: '',
    lineWidth: 1,
    lineCap: '',
    shadowColor: '',
    shadowBlur: 0,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.dataset = {};
    }

    addEventListener(type, handler) { listeners.set(`${this.tagName}:${type}`, handler); }
    removeEventListener(type) { listeners.delete(`${this.tagName}:${type}`); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      this.parentElement = null;
    }
    setAttribute() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 1600, height: 900 }; }
    getContext() { return this.tagName === 'CANVAS' ? reticleContext : null; }
  }
  const requested = [];
  const document = {
    body: new FakeElement('body'),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: () => null,
    addEventListener(type, handler) { listeners.set(`document:${type}`, handler); },
    removeEventListener(type) { listeners.delete(`document:${type}`); },
  };
  const canvas = new FakeElement('canvas');
  const dataSources = [];
  const camera = {
    positionCartographic: null,
    positionWC: Cesium.Cartesian3.fromDegrees(-80.604, 28.608, 18_000_000),
    cancelFlight() {},
    lookAtTransform() {},
  };
  const scene = {
    canvas,
    camera,
    frameState: { frameNumber: 1 },
    postRender: new Cesium.Event(),
    preRender: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    primitives: { add: (primitive) => primitive, remove: () => true },
    drillPick: () => [],
  };
  const viewer = {
    camera,
    scene,
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) { return dataSources.includes(dataSource); },
    },
    selectedEntity: undefined,
  };
  const host = { setEntries() {}, setVisible() {}, clearSource() {} };
  const launchTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  globalThis.document = document;
  globalThis.HTMLCanvasElement = FakeElement;
  globalThis.HTMLImageElement = class {};
  globalThis.ImageBitmap = class {};
  globalThis.OffscreenCanvas = class {};
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes('celestrak')) {
      return { ok: false, status: 404, text: async () => '' };
    }
    if (String(url).startsWith('/api/')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          id: 'mission-direct',
          name: 'Falcon 9 | Direct Payload',
          net: launchTime,
          status: { name: 'Launch Successful' },
          pad: { latitude: '28.608', longitude: '-80.604', name: 'Space Launch Complex 39A' },
          mission: { name: 'Direct Payload', description: 'Static fallback check' },
        }],
      }),
    };
  };
  _setRocketMissionOverlayHostForTest(host);
  try {
    rocketLaunchesLayer.init(viewer);
    await rocketLaunchesLayer.enable();
    await rocketLaunchesLayer.update();
    assert.ok(
      requested.some((url) => url.startsWith('https://ll.thespacedevs.com/2.3.0/launches/')),
      `direct Launch Library URL requested, saw: ${requested.join(', ')}`,
    );
    assert.ok(dataSources[0].entities.values.length >= 1, 'direct LL2 payload renders missions');
  } finally {
    rocketLaunchesLayer.destroy(viewer);
    globalThis.document = realDocument;
    globalThis.fetch = realFetch;
    globalThis.HTMLCanvasElement = realHtmlCanvasElement;
    globalThis.HTMLImageElement = realHtmlImageElement;
    globalThis.ImageBitmap = realImageBitmap;
    globalThis.OffscreenCanvas = realOffscreenCanvas;
  }
});

test('mapped installations: proxy 404 falls back to direct Overpass QL', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const requested = [];
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = {
    dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    requested.push(href);
    if (href.startsWith('/api/')) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body || ''), /military/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        elements: [{ type: 'node', id: 42, lat: 30.2, lon: -97.7, tags: { military: 'base', name: 'Site' } }],
      }),
    };
  };
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(30.1),
          west: Cesium.Math.toRadians(-97.8),
          north: Cesium.Math.toRadians(30.3),
          east: Cesium.Math.toRadians(-97.6),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() {},
    },
    dataSources: {
      add(dataSource) { return dataSource; },
      remove() { return true; },
    },
  };
  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();
    assert.ok(
      requested.some((url) => url.startsWith('https://overpass')),
      `direct Overpass mirror requested, saw: ${requested.join(', ')}`,
    );
    const stats = militaryInstallationsLayer.getStats();
    assert.equal(stats.status, 'ready');
    assert.ok(stats.count >= 1);
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
