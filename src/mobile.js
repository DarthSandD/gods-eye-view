/**
 * @module mobile
 * @description Mobile render profile + capability detection.
 *
 * Desktop rendering stays pixel-identical (MSAA 4, 60 fps, preserved drawing
 * buffer, uncapped resolution scale). Small-screen / coarse-pointer devices
 * get a cheaper profile: MSAA 1, 30 fps target, resolutionScale capped at 2
 * (1.5 on coarse pointers), and no preserved drawing buffer outside recording
 * mode (recording needs it for frame capture; pass ?recording=1 or set
 * window.__GEV_RECORDING before boot when capturing clips on mobile).
 *
 * No Cesium dependency — pure environment detection, unit-testable in Node.
 */

/** True when the primary input is touch-like (coarse pointer). */
export function isCoarsePointer(env = globalThis) {
  try {
    return Boolean(env?.matchMedia?.('(pointer: coarse)')?.matches);
  } catch {
    return false;
  }
}

/** True on small-screen viewports (narrow phones in portrait). */
export function isNarrowViewport(env = globalThis, breakpointPx = 575) {
  const width = Number(env?.innerWidth);
  return Number.isFinite(width) && width <= breakpointPx;
}

/** True for the mobile render profile: coarse pointer or narrow viewport. */
export function isMobileProfile(env = globalThis) {
  return isCoarsePointer(env) || isNarrowViewport(env);
}

/**
 * True when the app booted for clip capture on a mobile profile.
 * The viewer is constructed before SceneDirector runs, so recording mode can
 * only be honored from boot-time signals: an explicit ?recording=1 (or
 * ?record=1) query param, or a window.__GEV_RECORDING flag set before boot.
 */
export function isRecordingBoot(env = globalThis) {
  try {
    if (env?.__GEV_RECORDING === true) return true;
    const search = String(env?.location?.search || '');
    if (!search) return false;
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    return params.get('recording') === '1' || params.get('record') === '1';
  } catch {
    return false;
  }
}

/**
 * Viewer construction profile. Desktop returns today's exact values so
 * desktop rendering stays pixel-identical; mobile returns the capped budget.
 */
export function mobileViewerProfile(env = globalThis) {
  if (!isMobileProfile(env)) {
    return {
      mobile: false,
      msaaSamples: 4,
      targetFrameRate: 60,
      resolutionScaleCap: null,
      preserveDrawingBuffer: true,
    };
  }
  return {
    mobile: true,
    msaaSamples: 1,
    targetFrameRate: 30,
    resolutionScaleCap: isCoarsePointer(env) ? 1.5 : 2,
    preserveDrawingBuffer: isRecordingBoot(env),
  };
}

/** Photoreal tile budget lever for coarse pointers (default SSE is 16). */
export const COARSE_TILE_MAXIMUM_SCREEN_SPACE_ERROR = 32;

/** Traffic dot budget on coarse pointers (desktop keeps 6000). */
export const COARSE_TRAFFIC_MAX_DOTS = 2500;

/** Desktop traffic dot budget (unchanged). */
export const DESKTOP_TRAFFIC_MAX_DOTS = 6000;

/** Resolve the traffic dot budget for this device. */
export function trafficDotBudget(env = globalThis) {
  return isCoarsePointer(env) ? COARSE_TRAFFIC_MAX_DOTS : DESKTOP_TRAFFIC_MAX_DOTS;
}

/**
 * Yield to a idle moment before heavy non-critical work (geojsonl fetch +
 * parse) on mobile so first paint is never blocked. Desktop resolves
 * immediately — no behavior change.
 */
export function yieldForNonCriticalGeojsonl(env = globalThis) {
  if (!isMobileProfile(env)) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      if (typeof env?.requestIdleCallback === 'function') {
        env.requestIdleCallback(() => resolve(), { timeout: 2000 });
        return;
      }
    } catch { /* fall through to the timer */ }
    const setTimeoutFn = env?.setTimeout || globalThis.setTimeout;
    setTimeoutFn.call(env, resolve, 0);
  });
}
