/**
 * @module locate
 * @description Opt-in single-fix geolocation for the dock locate button.
 *
 * The app NEVER prompts for location on load: the browser permission prompt
 * appears only after an explicit tap on the locate button. One fix is
 * requested per tap (no watchPosition), so a deny/timeout leaves the default
 * Austin view untouched and the caller shows a toast instead.
 *
 * No Cesium dependency — pure geolocation plumbing, unit-testable in Node
 * with a stub `env` carrying `navigator.geolocation`.
 */

/** Per-tap budget for the single position fix (ms). */
export const LOCATE_TIMEOUT_MS = 10_000;

/** Maximum cached-fix age the device may return (ms). */
export const LOCATE_MAXIMUM_AGE_MS = 60_000;

/**
 * True when a geolocation provider exists on this environment.
 * @param {object} [env]
 * @returns {boolean}
 */
export function isGeolocationAvailable(env = globalThis) {
  try {
    return typeof env?.navigator?.geolocation?.getCurrentPosition === 'function';
  } catch {
    return false;
  }
}

/**
 * Request exactly one position fix. Never called except from the explicit
 * locate-button tap — there is no load-time or background caller.
 *
 * @param {object} [env]
 * @param {object} [options]
 * @param {number} [options.timeoutMs] — per-tap budget, rejects as `timeout`.
 * @returns {Promise<{latitude: number, longitude: number, accuracy: number}>}
 * @throws {Error} code `unavailable` (no provider), `denied` (permission or
 *   position unavailable), or `timeout` (budget exceeded).
 */
export function requestFirstFix(env = globalThis, { timeoutMs = LOCATE_TIMEOUT_MS } = {}) {
  if (!isGeolocationAvailable(env)) {
    return Promise.reject(Object.assign(new Error('Geolocation is unavailable'), { code: 'unavailable' }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { code }));
    };
    const timer = setTimeout(
      () => fail('timeout', 'Location request timed out'),
      timeoutMs,
    );
    try {
      env.navigator.geolocation.getCurrentPosition(
        (position) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const { latitude, longitude, accuracy } = position?.coords ?? {};
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            reject(Object.assign(new Error('Location fix had no coordinates'), { code: 'denied' }));
            return;
          }
          resolve({ latitude, longitude, accuracy: Number(accuracy) || 0 });
        },
        (error) => {
          clearTimeout(timer);
          // PERMISSION_DENIED and POSITION_UNAVAILABLE both mean "stay on the
          // default view"; TIMEOUT maps to the same toast path via `timeout`.
          const code = error?.code === 3 ? 'timeout' : 'denied';
          fail(code, code === 'timeout' ? 'Location request timed out' : 'Location permission was not granted');
        },
        {
          enableHighAccuracy: false,
          timeout: timeoutMs,
          maximumAge: LOCATE_MAXIMUM_AGE_MS,
        },
      );
    } catch {
      clearTimeout(timer);
      fail('denied', 'Location permission was not granted');
    }
  });
}
