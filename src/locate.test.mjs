import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATE_TIMEOUT_MS,
  isGeolocationAvailable,
  requestFirstFix,
} from './locate.js';

function stubEnv(behavior) {
  return {
    navigator: {
      geolocation: {
        getCurrentPosition: behavior,
      },
    },
  };
}

test('isGeolocationAvailable is false without a provider', () => {
  assert.equal(isGeolocationAvailable({}), false);
  assert.equal(isGeolocationAvailable({ navigator: {} }), false);
  assert.equal(
    isGeolocationAvailable({ navigator: { geolocation: {} } }),
    false,
  );
});

test('isGeolocationAvailable is true with getCurrentPosition', () => {
  assert.equal(
    isGeolocationAvailable(stubEnv(() => {})),
    true,
  );
});

test('requestFirstFix resolves the first fix coordinates', async () => {
  const env = stubEnv((success) => {
    success({ coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 25 } });
  });
  const fix = await requestFirstFix(env, { timeoutMs: 1000 });
  assert.equal(fix.latitude, 30.2672);
  assert.equal(fix.longitude, -97.7431);
  assert.equal(fix.accuracy, 25);
});

test('requestFirstFix rejects unavailable with no provider', async () => {
  await assert.rejects(() => requestFirstFix({}, { timeoutMs: 50 }), (error) => {
    assert.equal(error.code, 'unavailable');
    return true;
  });
});

test('requestFirstFix maps denial to code denied', async () => {
  const env = stubEnv((_, failure) => failure({ code: 1 }));
  await assert.rejects(() => requestFirstFix(env, { timeoutMs: 500 }), (error) => {
    assert.equal(error.code, 'denied');
    return true;
  });
});

test('requestFirstFix maps error code 3 to timeout', async () => {
  const env = stubEnv((_, failure) => failure({ code: 3 }));
  await assert.rejects(() => requestFirstFix(env, { timeoutMs: 500 }), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

test('requestFirstFix times out when the provider never answers', async () => {
  const env = stubEnv(() => {});
  await assert.rejects(() => requestFirstFix(env, { timeoutMs: 20 }), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

test('LOCATE_TIMEOUT_MS defaults to a 10s per-tap budget', () => {
  assert.equal(LOCATE_TIMEOUT_MS, 10_000);
});
