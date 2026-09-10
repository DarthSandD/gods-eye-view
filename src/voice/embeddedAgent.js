/**
 * Fully embedded browser-native voice agent — zero network, zero keys.
 *
 * STT via SpeechRecognition/webkitSpeechRecognition (Chrome/Edge), local
 * intent grammar routed into the existing gev action runner, spoken replies
 * via speechSynthesis. No fetch, no tokens, no backend.
 *
 * Pure intent parsing / reply formatting is DOM-free and unit-tested.
 * Only start()/speech touch browser APIs, all injectable for tests.
 */
import {
  getLocalSpeechRecognitionCtor,
  isPushToTalkKey,
  shouldHandlePushToTalkKeyDown,
  shouldIgnoreVoiceButtonClick,
} from './gevRealtime.js';

/** Spoken when no SpeechRecognition constructor exists (e.g. Firefox). */
export const EMBEDDED_VOICE_UNSUPPORTED_REPLY =
  'Voice recognition is not supported in this browser. Try Chrome or Edge.';

/** Short help readout listing every supported command family. */
export const EMBEDDED_VOICE_HELP_REPLY =
  'You can say: fly to a place; turn a layer on or off; play, stop, or list scenes; '
  + 'zoom in or out; locate me; status; or help.';

/**
 * All 15 data layers by canonical id with spoken names. Mirrors the
 * LAYER_ALIASES vocabulary in gevActions.js (import-free copy so this module
 * stays backend-agnostic and unit-testable in plain node).
 */
export const EMBEDDED_LAYERS = Object.freeze([
  { id: 'flights', names: ['flights', 'planes', 'aircraft'] },
  { id: 'military', names: ['military', 'military flights'] },
  { id: 'earthquakes', names: ['earthquakes', 'quakes'] },
  { id: 'satellites', names: ['satellites'] },
  { id: 'rocket-launches', names: ['rocket launches', 'space missions', 'launches', 'rockets', 'missions'] },
  { id: 'traffic', names: ['traffic', 'street traffic'] },
  { id: 'cctv', names: ['cctv', 'cameras'] },
  { id: 'radio', names: ['radio', 'internet radio', 'radio stations'] },
  { id: 'bikeshare', names: ['bikeshare', 'bike share', 'bikes'] },
  { id: 'ais-live-vessels', names: ['ships', 'vessels', 'ais', 'boats', 'live vessels'] },
  { id: 'local-datacenters', names: ['data centers', 'datacenters', 'data centres'] },
  { id: 'local-dams', names: ['dams'] },
  { id: 'telegeography-submarine-cables', names: ['submarine cables', 'cables', 'undersea cables'] },
  { id: 'local-firms', names: ['fires', 'firms', 'wildfires', 'active fires'] },
  { id: 'military-installations', names: ['military bases', 'military installations', 'bases'] },
]);

/** Example phrases used for the closest-command suggestion on unknown input. */
export const EMBEDDED_COMMAND_PHRASES = Object.freeze([
  'fly to Austin',
  'turn flights on',
  'turn traffic off',
  'play scene',
  'next scene',
  'stop scene',
  'list scenes',
  'zoom in',
  'zoom out',
  'locate me',
  'status',
  'help',
]);

const LAYER_LOOKUP = new Map();
for (const layer of EMBEDDED_LAYERS) {
  for (const name of layer.names) LAYER_LOOKUP.set(name, layer.id);
}

const LOCATION_VERB_PREFIX =
  /^(?:please\s+)?(?:fly(?:\s+me)?|go|navigate|zoom|take\s+me|bring\s+me|show\s+me|centre\s+on|center\s+on|look\s+at)\s+(?:to\b(?:\s+the\b)?|at\b(?:\s+the\b)?|towards?\b(?:\s+the\b)?|over\b(?:\s+the\b)?)?\s*/i;

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function findLayerId(text) {
  const lower = text.toLowerCase();
  // Longest spoken name first so "military bases" wins over "military".
  const names = [...LAYER_LOOKUP.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (lower === name || lower.endsWith(` ${name}`) || lower.startsWith(`${name} `) || lower.includes(` ${name} `)) {
      return { layerId: LAYER_LOOKUP.get(name), name };
    }
  }
  return null;
}

/**
 * Character-level edit distance (no network, no dictionary).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    prev = next;
  }
  return prev[right.length];
}

/**
 * Closest known command phrase to free text, or null when nothing is close
 * enough to be a useful suggestion.
 */
export function suggestClosestCommand(text) {
  const input = clean(text).toLowerCase();
  if (!input) return null;
  let best = null;
  let bestScore = Infinity;
  for (const phrase of EMBEDDED_COMMAND_PHRASES) {
    const score = levenshtein(input, phrase) / Math.max(input.length, phrase.length);
    if (score < bestScore) {
      bestScore = score;
      best = phrase;
    }
  }
  // 0.6 normalized distance: catches "fligh to austin" / "zoon in" without
  // suggesting "fly to Austin" for genuinely unrelated speech.
  return bestScore <= 0.6 ? best : null;
}

/**
 * Parse one speech-recognition transcript into a runner intent.
 *
 * Returns `{ action, args, reply }` for known commands, `{ help: true, reply }`
 * for help (answered locally, no runner call), or
 * `{ unknown: true, suggestion, reply }` for unrecognized input.
 *
 * @param {string} transcript
 * @param {{ sceneNames?: string[] }} [options]
 */
export function parseEmbeddedVoiceCommand(transcript, { sceneNames = [] } = {}) {
  const text = clean(transcript);
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/^(help|what can i say|commands?|list commands?|how do i use (this|voice))\.?$/.test(lower)) {
    return { help: true, reply: EMBEDDED_VOICE_HELP_REPLY };
  }

  if (/^(list scenes|what scenes|show scenes)\.?$/.test(lower)) {
    return { action: 'control_scene', args: { action: 'list' }, reply: 'Listing scenes.' };
  }
  if (/^(stop (the )?scene|stop playback)\.?$/.test(lower)) {
    return { action: 'control_scene', args: { action: 'stop' }, reply: 'Stopping the scene.' };
  }
  if (/^(next scene|skip scene)\.?$/.test(lower)) {
    return { action: 'control_scene', args: { action: 'next' }, reply: 'Playing the next scene.' };
  }
  {
    // "play <scene>" / "start scene <name>" — match against known scene titles
    // when supplied, otherwise pass the remainder through as the query.
    const sceneMatch = lower.match(/^(?:play|start)(?: the)?(?: scene)? (.+?)\.?$/)
      || lower.match(/^scene (.+?)\.?$/);
    if (sceneMatch) {
      const query = clean(sceneMatch[1]);
      const known = sceneNames.find((name) => name.toLowerCase() === query.toLowerCase())
        || sceneNames.find((name) => name.toLowerCase().includes(query.toLowerCase()));
      return {
        action: 'control_scene',
        args: { action: 'play', ...(known || query ? { sceneId: known || query } : {}) },
        reply: `Playing scene ${known || query}.`,
      };
    }
  }

  {
    const zoom = lower.match(/^zoom (in|out)( a (lot|little|bit))?\.?$/) || lower.match(/^(zoom closer|closer|farther|zoom farther)\.?$/);
    if (zoom) {
      const direction = /out|farther/.test(zoom[1] || zoom[0]) ? 'out' : 'in';
      const amount = /lot/.test(lower) ? 'lot' : /little|bit/.test(lower) ? 'little' : 'medium';
      return {
        action: 'adjust_camera_zoom',
        args: { direction, amount },
        reply: direction === 'in' ? 'Zooming in.' : 'Zooming out.',
      };
    }
  }

  if (/^(locate me|find me|find my location|go to my location|my location|take me home)\.?$/.test(lower)) {
    return { action: 'locate_me', args: {}, reply: 'Flying to your location.' };
  }

  if (/^(status( report)?|what'?s on|what is visible|what layers are on|where am i|what do you see)\.?$/.test(lower)) {
    return { action: 'get_current_view_state', args: {}, reply: null }; // reply built from live state
  }

  {
    const turnMatch = lower.match(/^(turn|switch|toggle)\s+(.+?)\s+(on|off)\.?$/);
    const showMatch = turnMatch ? null : lower.match(/^(show|hide|enable|disable)\s+(.+?)\.?$/);
    // turnMatch groups: 1 verb, 2 layer, 3 on/off. showMatch groups: 1 verb, 2 layer.
    const verb = turnMatch?.[1] || showMatch?.[1];
    const layerText = turnMatch?.[2] || showMatch?.[2];
    const onOff = turnMatch?.[3];
    if (verb && layerText) {
      const found = findLayerId(clean(layerText));
      if (found) {
        const v = verb.toLowerCase();
        const enabled = onOff ? onOff === 'on' : ['show', 'enable'].includes(v);
        return {
          action: 'set_layer_visibility',
          args: { layerId: found.layerId, enabled },
          reply: `${found.layerId} ${enabled ? 'on' : 'off'}.`,
        };
      }
    }
    // Bare "flights on/off" / "traffic on/off".
    const bare = lower.match(/^(.+?)\s+(on|off)\.?$/);
    if (bare) {
      const found = findLayerId(clean(bare[1]));
      if (found) {
        const enabled = bare[2] === 'on';
        return {
          action: 'set_layer_visibility',
          args: { layerId: found.layerId, enabled },
          reply: `${found.layerId} ${enabled ? 'on' : 'off'}.`,
        };
      }
    }
  }

  {
    // Fly-to: explicit verb prefix, or a bare place name (existing fallback
    // behavior — a bare name is overwhelmingly a place).
    const query = clean(text.replace(LOCATION_VERB_PREFIX, '')) || text;
    if (LOCATION_VERB_PREFIX.test(text) || !suggestClosestCommandIsNonPlace(lower)) {
      return { action: 'fly_to_location', args: { query }, reply: `Flying to ${query}.` };
    }
  }

  const suggestion = suggestClosestCommand(text);
  return {
    unknown: true,
    suggestion,
    reply: suggestion
      ? `Sorry, I did not catch that. Did you mean "${suggestion}"?`
      : 'Sorry, I did not catch that. Say "help" to hear what I understand.',
  };
}

/**
 * Fly-to is the default for bare utterances, but not when the text is clearly
 * a mangled known command ("zoon in" should suggest, not fly to "zoon in").
 */
function suggestClosestCommandIsNonPlace(lower) {
  const suggestion = suggestClosestCommand(lower);
  if (!suggestion) return false;
  if (suggestion.startsWith('fly to ')) return false;
  const score = levenshtein(lower, suggestion) / Math.max(lower.length, suggestion.length);
  return score <= 0.45;
}

/**
 * Short spoken confirmation for a runner result. Reads the runner's own
 * labels so replies stay honest (failures are spoken as failures).
 * @param {{ action: string, args?: object }} intent
 * @param {object|null} result Runner result (or null when runner threw).
 * @returns {string}
 */
export function formatEmbeddedReply(intent, result) {
  if (!result) return 'That did not work. Try again.';
  if (result.ok === false) {
    const detail = clean(result.error).slice(0, 120);
    return detail ? `That did not work. ${detail}` : 'That did not work. Try again.';
  }
  switch (intent?.action) {
    case 'fly_to_location':
      return result.label ? `Now at ${result.label}.` : 'Flight complete.';
    case 'set_layer_visibility':
      return `${result.label || result.layerId || 'Layer'} ${result.enabled ? 'on' : 'off'}.`;
    case 'adjust_camera_zoom':
      return intent.args?.direction === 'out' ? 'Zoomed out.' : 'Zoomed in.';
    case 'control_scene':
      if (result.scenes) {
        const titles = result.scenes.map((s) => s.title || s.id).filter(Boolean).slice(0, 5);
        return titles.length ? `Scenes: ${titles.join(', ')}.` : 'No scenes available.';
      }
      return result.playing ? `Playing ${result.playing}.` : 'Scene updated.';
    case 'get_current_view_state':
      return formatStatusReply(result);
    case 'locate_me':
      return result.label ? `Now at ${result.label}.` : 'Now at your location.';
    default:
      return intent?.reply || 'Done.';
  }
}

/** One-sentence spoken summary of get_current_view_state output. */
export function formatStatusReply(state) {
  const layers = Array.isArray(state?.layers) ? state.layers.filter((l) => l.enabled) : [];
  const names = layers.map((l) => l.name || l.id).slice(0, 5);
  const layerBit = names.length ? `Layers on: ${names.join(', ')}.` : 'All layers off.';
  const camera = state?.camera;
  const placeBit = camera && Number.isFinite(camera.latitude)
    ? ` Position ${camera.latitude.toFixed(2)}, ${camera.longitude.toFixed(2)}.`
    : '';
  return `${layerBit}${placeBit}`;
}

/**
 * speechSynthesis handle (standard or webkit-prefixed), null when unsupported.
 * Never throws. Injectable scope for tests.
 */
export function getSpeechSynthesisHandle(scope = undefined) {
  try {
    const win = scope !== undefined
      ? scope
      : (typeof window !== 'undefined' ? window : undefined);
    const synth = win?.speechSynthesis || null;
    return synth && typeof synth.speak === 'function' ? synth : null;
  } catch {
    return null;
  }
}

/**
 * Speak one short utterance, cancelling anything already queued so a new
 * command always interrupts the previous reply.
 * @param {string} text
 * @param {{ synthesis?: object, voice?: object, rate?: number }} [options]
 * @returns {boolean} true when the utterance was queued
 */
export function speakEmbeddedReply(text, { synthesis = undefined, voice = null, rate = 1 } = {}) {
  const synth = synthesis !== undefined ? synthesis : getSpeechSynthesisHandle();
  const cleanText = clean(text);
  if (!synth || !cleanText) return false;
  try {
    synth.cancel?.();
    const Utterance = synth.Utterance
      || (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null)
      || globalThis.SpeechSynthesisUtterance;
    if (typeof Utterance !== 'function') return false;
    const utterance = new Utterance(cleanText);
    if (voice) utterance.voice = voice;
    if (Number.isFinite(rate) && rate > 0) utterance.rate = rate;
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/** Silence any in-flight spoken reply. Never throws. */
export function cancelEmbeddedSpeech(synthesis = undefined) {
  try {
    (synthesis !== undefined ? synthesis : getSpeechSynthesisHandle())?.cancel?.();
  } catch { /* no-op */ }
}

/**
 * Browser geolocation as a promise. Rejects where unsupported or denied —
 * the agent speaks the failure instead of throwing it at the operator.
 */
export function getEmbeddedUserPosition({ geolocation = undefined, timeoutMs = 8000 } = {}) {
  const geo = geolocation !== undefined
    ? geolocation
    : (typeof navigator !== 'undefined' ? navigator.geolocation : null);
  if (!geo || typeof geo.getCurrentPosition !== 'function') {
    return Promise.reject(new Error('Geolocation is not available in this browser'));
  }
  return new Promise((resolve, reject) => {
    try {
      geo.getCurrentPosition(resolve, (error) => {
        reject(new Error(error?.message || 'Location unavailable'));
      }, { timeout: timeoutMs, maximumAge: 60000 });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Location unavailable'));
    }
  });
}

/**
 * Embedded voice agent: recognition → local grammar → runner → speech.
 *
 * All browser surfaces are injectable: `recognitionCtor`, `synthesis`,
 * `geolocation`, and the runner. `sceneNames` (or `getSceneNames()`) feeds
 * the "play <scene>" matcher; `locateRunner` defaults to calling the runner
 * with fly_to_location + coordinates from geolocation.
 */
export class EmbeddedVoiceAgent {
  constructor({
    runner,
    sceneNames = [],
    getSceneNames = null,
    recognitionCtor = undefined,
    recognitionScope = undefined,
    synthesis = undefined,
    geolocation = undefined,
    onStatus = null,
    onTranscript = null,
  } = {}) {
    if (typeof runner !== 'function') throw new Error('EmbeddedVoiceAgent needs a runner(action, args)');
    this.runner = runner;
    this.sceneNames = sceneNames;
    this.getSceneNames = getSceneNames;
    this.recognitionScope = recognitionScope;
    this.recognitionCtor = recognitionCtor !== undefined
      ? recognitionCtor
      : getLocalSpeechRecognitionCtor(recognitionScope);
    this.synthesis = synthesis;
    this.geolocation = geolocation;
    this.onStatus = typeof onStatus === 'function' ? onStatus : null;
    this.onTranscript = typeof onTranscript === 'function' ? onTranscript : null;
    this.recognition = null;
    this.active = false;
    this.continuous = false;
    this.pttDetach = null;
  }

  /** False where SpeechRecognition is unavailable — callers show the degrade message. */
  isSupported() {
    return typeof this.recognitionCtor === 'function';
  }

  setContinuous(continuous) {
    this.continuous = Boolean(continuous);
    if (this.recognition) {
      try { this.recognition.continuous = this.continuous; } catch { /* one-shot engines ignore */ }
    }
    return this.continuous;
  }

  status(state, detail) {
    this.onStatus?.({ state, detail });
  }

  sceneList() {
    try {
      const live = typeof this.getSceneNames === 'function' ? this.getSceneNames() : null;
      if (Array.isArray(live)) return live;
    } catch { /* fall through to static list */ }
    return Array.isArray(this.sceneNames) ? this.sceneNames : [];
  }

  start({ continuous = null } = {}) {
    if (continuous !== null) this.continuous = Boolean(continuous);
    if (!this.isSupported()) {
      this.status('unsupported', EMBEDDED_VOICE_UNSUPPORTED_REPLY);
      speakEmbeddedReply(EMBEDDED_VOICE_UNSUPPORTED_REPLY, { synthesis: this.synthesis });
      return false;
    }
    if (this.active) return true;
    const recognition = new this.recognitionCtor();
    try { recognition.lang = recognition.lang || 'en-US'; } catch { /* engine default */ }
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    try { recognition.continuous = this.continuous; } catch { /* one-shot engines restart via onend */ }
    this.recognition = recognition;
    this.active = true;
    recognition.onresult = (event) => { void this.handleRecognitionResult(event); };
    recognition.onerror = (event) => this.handleRecognitionError(event);
    recognition.onend = () => {
      if (this.active && this.continuous && this.recognition === recognition) {
        try { recognition.start(); } catch { /* already started */ }
      }
    };
    try {
      recognition.start();
    } catch {
      this.recognition = null;
      this.active = false;
      this.status('idle', 'Local voice unavailable — check microphone permission');
      return false;
    }
    this.status('listening', this.continuous ? 'Embedded voice — always listening' : 'Embedded voice — say a command');
    return true;
  }

  stop() {
    this.active = false;
    cancelEmbeddedSpeech(this.synthesis);
    if (this.recognition) {
      const recognition = this.recognition;
      this.recognition = null;
      try {
        recognition.onend = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.abort?.();
        recognition.stop?.();
      } catch { /* already stopped */ }
    }
    this.detachPushToTalk();
    this.status('idle', 'Voice off');
  }

  /**
   * Hold-Space push-to-talk reusing the shared mic UX guards: Space is
   * ignored while typing or with modifiers, and a mic-button click made while
   * Space is held is ignored (the reverse race guard lives with the button).
   * @param {{ target?: object, onHoldStart?: Function, onHoldEnd?: Function }} [options]
   * @returns {Function} detach function
   */
  attachPushToTalk({ target = undefined, onHoldStart = null, onHoldEnd = null } = {}) {
    const doc = target
      || (typeof document !== 'undefined' ? document : null);
    if (!doc?.addEventListener) return () => {};
    const keyDown = (event) => {
      if (!shouldHandlePushToTalkKeyDown(event)) return;
      if (event.repeat) {
        event.preventDefault?.();
        return;
      }
      event.preventDefault?.();
      // Pause continuous listening while held so the open mic does not echo.
      if (this.active) {
        try { this.recognition?.stop?.(); } catch { /* no-op */ }
      }
      onHoldStart?.();
    };
    const keyUp = (event) => {
      if (!isPushToTalkKey(event)) return;
      event.preventDefault?.();
      if (this.active && this.continuous && this.recognition) {
        try { this.recognition.start(); } catch { /* already started */ }
      }
      onHoldEnd?.();
    };
    doc.addEventListener('keydown', keyDown);
    doc.addEventListener('keyup', keyUp);
    this.pttDetach = () => {
      doc.removeEventListener('keydown', keyDown);
      doc.removeEventListener('keyup', keyUp);
      this.pttDetach = null;
    };
    return this.pttDetach;
  }

  detachPushToTalk() {
    try { this.pttDetach?.(); } catch { /* no-op */ }
    this.pttDetach = null;
  }

  /** Re-exported so mic-button wiring can honor the Space-click race guard. */
  shouldIgnoreButtonClick(spaceKeyHeld) {
    return shouldIgnoreVoiceButtonClick(spaceKeyHeld);
  }

  async handleRecognitionResult(event) {
    let transcript = '';
    for (const result of event?.results || []) {
      const best = result?.[0];
      if (best?.transcript) transcript += `${best.transcript} `;
    }
    await this.handleTranscript(transcript.trim());
  }

  handleRecognitionError(event) {
    const kind = event?.error || 'unknown';
    if (kind === 'not-allowed' || kind === 'service-not-allowed') {
      this.stop();
      this.status('idle', 'Microphone blocked — allow access and try again');
      return;
    }
    this.status('listening', 'Did not catch that — say "help" for commands');
  }

  /**
   * Route one transcript through the grammar into the runner, then speak the
   * confirmation. New commands cancel in-flight speech first.
   * @param {string} transcript
   * @returns {Promise<object|null>} the intent (or unknown marker), null when empty
   */
  async handleTranscript(transcript) {
    const text = clean(transcript);
    if (!text) return null;
    this.onTranscript?.(text);
    cancelEmbeddedSpeech(this.synthesis);
    const intent = parseEmbeddedVoiceCommand(text, { sceneNames: this.sceneList() });
    if (!intent) return null;
    if (intent.help) {
      speakEmbeddedReply(intent.reply, { synthesis: this.synthesis });
      this.status('listening', 'Commands listed');
      return intent;
    }
    if (intent.unknown) {
      speakEmbeddedReply(intent.reply, { synthesis: this.synthesis });
      this.status('listening', intent.suggestion ? `Did you mean "${intent.suggestion}"?` : 'Say "help" for commands');
      return intent;
    }
    this.status('executing', `Heard "${text.slice(0, 60)}"`);
    try {
      let result;
      if (intent.action === 'locate_me') {
        result = await this.runLocateMe();
      } else {
        result = await this.runner(intent.action, intent.args);
      }
      if (!this.active) return intent;
      // Always confirm from the runner's result (never the optimistic ack),
      // so failures and resolved labels are spoken honestly.
      const reply = formatEmbeddedReply(intent, result);
      speakEmbeddedReply(reply, { synthesis: this.synthesis });
      this.status('listening', reply);
      return intent;
    } catch (error) {
      if (!this.active) return intent;
      const reply = error?.message
        ? `That did not work. ${clean(error.message).slice(0, 120)}`
        : 'That did not work. Try again.';
      speakEmbeddedReply(reply, { synthesis: this.synthesis });
      this.status('listening', reply);
      return intent;
    }
  }

  /** Geolocate, then fly via the runner's Nominatim-backed fly_to_location. */
  async runLocateMe() {
    const position = await getEmbeddedUserPosition({ geolocation: this.geolocation });
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('Location unavailable');
    }
    return this.runner('fly_to_location', { latitude, longitude });
  }
}

/**
 * Create an embedded voice agent wired to the gev action runner.
 * @param {object} options Same as EmbeddedVoiceAgent constructor options.
 * @returns {EmbeddedVoiceAgent}
 */
export function createEmbeddedVoiceAgent(options = {}) {
  return new EmbeddedVoiceAgent(options);
}
