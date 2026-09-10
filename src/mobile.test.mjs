import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  COARSE_TRAFFIC_MAX_DOTS,
  DESKTOP_TRAFFIC_MAX_DOTS,
  isCoarsePointer,
  isMobileProfile,
  isNarrowViewport,
  isRecordingBoot,
  mobileViewerProfile,
  trafficDotBudget,
  yieldForNonCriticalGeojsonl,
} from './mobile.js';

function desktopEnv() {
  return {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1600,
    location: { search: '' },
  };
}

function phoneEnv() {
  return {
    matchMedia: (query) => ({ matches: query === '(pointer: coarse)' }),
    innerWidth: 390,
    location: { search: '' },
  };
}

test('desktop profile is pixel-identical to today', () => {
  const profile = mobileViewerProfile(desktopEnv());
  assert.equal(profile.mobile, false);
  assert.equal(profile.msaaSamples, 4);
  assert.equal(profile.targetFrameRate, 60);
  assert.equal(profile.resolutionScaleCap, null);
  assert.equal(profile.preserveDrawingBuffer, true);
});

test('coarse-pointer phone gets the capped mobile profile', () => {
  const profile = mobileViewerProfile(phoneEnv());
  assert.equal(profile.mobile, true);
  assert.equal(profile.msaaSamples, 1);
  assert.equal(profile.targetFrameRate, 30);
  assert.equal(profile.resolutionScaleCap, 1.5);
  assert.equal(profile.preserveDrawingBuffer, false);
});

test('fine-pointer small screen caps at 2x and keeps recording buffer opt-in', () => {
  const env = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 500,
    location: { search: '?recording=1' },
  };
  assert.equal(isMobileProfile(env), true);
  assert.equal(isCoarsePointer(env), false);
  const profile = mobileViewerProfile(env);
  assert.equal(profile.resolutionScaleCap, 2);
  assert.equal(profile.preserveDrawingBuffer, true);
});

test('recording boot signals: query param or pre-boot flag', () => {
  assert.equal(isRecordingBoot(desktopEnv()), false);
  assert.equal(isRecordingBoot({ location: { search: '?record=1' } }), true);
  assert.equal(isRecordingBoot({ __GEV_RECORDING: true, location: { search: '' } }), true);
  assert.equal(isNarrowViewport({ innerWidth: 575 }), true);
  assert.equal(isNarrowViewport({ innerWidth: 576 }), false);
  assert.equal(isCoarsePointer({}), false);
});

test('traffic dot budget drops on coarse pointers only', () => {
  assert.equal(trafficDotBudget(desktopEnv()), DESKTOP_TRAFFIC_MAX_DOTS);
  assert.equal(DESKTOP_TRAFFIC_MAX_DOTS, 6000);
  assert.equal(trafficDotBudget(phoneEnv()), COARSE_TRAFFIC_MAX_DOTS);
  assert.equal(COARSE_TRAFFIC_MAX_DOTS, 2500);
});

test('non-critical geojsonl yield is immediate on desktop, deferred on mobile', async () => {
  let desktopResolved = false;
  await yieldForNonCriticalGeojsonl(desktopEnv()).then(() => { desktopResolved = true; });
  assert.equal(desktopResolved, true);
  // Mobile without requestIdleCallback falls back to a macrotask (still async).
  let mobileSync = true;
  const pending = yieldForNonCriticalGeojsonl({ ...phoneEnv(), setTimeout: (fn) => setTimeout(fn, 0) })
    .then(() => { mobileSync = false; });
  assert.equal(mobileSync, true);
  await pending;
  assert.equal(mobileSync, false);
});
