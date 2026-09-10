// Embedded browser-native voice agent — pure-logic + stubbed-browser tests.
//
// Run with: node --test src/voice/embeddedAgent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDED_LAYERS,
  EMBEDDED_VOICE_UNSUPPORTED_REPLY,
  EmbeddedVoiceAgent,
  cancelEmbeddedSpeech,
  createEmbeddedVoiceAgent,
  formatEmbeddedReply,
  formatStatusReply,
  getSpeechSynthesisHandle,
  levenshtein,
  parseEmbeddedVoiceCommand,
  speakEmbeddedReply,
  suggestClosestCommand,
} from './embeddedAgent.js';
import { GevRealtimeController } from './gevRealtime.js';

test('the agent module performs no network calls (static guard)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./embeddedAgent.js', import.meta.url), 'utf8');
  for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'RTCPeerConnection', 'navigator.sendBeacon']) {
    assert.ok(!source.includes(banned), `embeddedAgent.js must not reference ${banned}`);
  }
});

test('fly-to covers verbs and bare place names', () => {
  assert.deepEqual(parseEmbeddedVoiceCommand('fly to Austin'), {
    action: 'fly_to_location', args: { query: 'Austin' }, reply: 'Flying to Austin.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('take me to the Eiffel Tower').action, 'fly_to_location');
  assert.deepEqual(parseEmbeddedVoiceCommand('Reykjavik'), {
    action: 'fly_to_location', args: { query: 'Reykjavik' }, reply: 'Flying to Reykjavik.',
  });
  assert.equal(parseEmbeddedVoiceCommand(''), null);
  assert.equal(parseEmbeddedVoiceCommand('   '), null);
});

test('layer toggles cover all 15 layers by spoken name', () => {
  assert.equal(EMBEDDED_LAYERS.length, 15);
  const ids = new Set(EMBEDDED_LAYERS.map((l) => l.id));
  for (const expected of ['flights', 'military', 'earthquakes', 'satellites', 'rocket-launches',
    'traffic', 'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'local-datacenters',
    'local-dams', 'telegeography-submarine-cables', 'local-firms', 'military-installations']) {
    assert.ok(ids.has(expected), `missing layer ${expected}`);
  }
  assert.deepEqual(parseEmbeddedVoiceCommand('turn flights on'), {
    action: 'set_layer_visibility', args: { layerId: 'flights', enabled: true }, reply: 'flights on.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('turn traffic off'), {
    action: 'set_layer_visibility', args: { layerId: 'traffic', enabled: false }, reply: 'traffic off.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('show earthquakes'), {
    action: 'set_layer_visibility', args: { layerId: 'earthquakes', enabled: true }, reply: 'earthquakes on.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('hide cctv'), {
    action: 'set_layer_visibility', args: { layerId: 'cctv', enabled: false }, reply: 'cctv off.',
  });
  // Alias-heavy layers resolve to canonical ids.
  assert.equal(parseEmbeddedVoiceCommand('turn planes on').args.layerId, 'flights');
  assert.equal(parseEmbeddedVoiceCommand('turn submarine cables off').args.layerId, 'telegeography-submarine-cables');
  assert.equal(parseEmbeddedVoiceCommand('turn fires on').args.layerId, 'local-firms');
  assert.equal(parseEmbeddedVoiceCommand('turn military bases off').args.layerId, 'military-installations');
  assert.equal(parseEmbeddedVoiceCommand('turn ships on').args.layerId, 'ais-live-vessels');
  assert.equal(parseEmbeddedVoiceCommand('turn data centers on').args.layerId, 'local-datacenters');
});

test('scene commands match known titles and pass through queries', () => {
  const scenes = ['Downtown Tour', 'Harbor Flyover'];
  assert.deepEqual(
    parseEmbeddedVoiceCommand('play downtown tour', { sceneNames: scenes }),
    { action: 'control_scene', args: { action: 'play', sceneId: 'Downtown Tour' }, reply: 'Playing scene Downtown Tour.' },
  );
  assert.deepEqual(parseEmbeddedVoiceCommand('list scenes'), {
    action: 'control_scene', args: { action: 'list' }, reply: 'Listing scenes.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('next scene'), {
    action: 'control_scene', args: { action: 'next' }, reply: 'Playing the next scene.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('stop scene'), {
    action: 'control_scene', args: { action: 'stop' }, reply: 'Stopping the scene.',
  });
  // Unknown title passes through as the query for the director to resolve.
  assert.equal(parseEmbeddedVoiceCommand('play volcano tour').args.sceneId, 'volcano tour');
});

test('zoom, locate-me, status, and help intents', () => {
  assert.deepEqual(parseEmbeddedVoiceCommand('zoom in'), {
    action: 'adjust_camera_zoom', args: { direction: 'in', amount: 'medium' }, reply: 'Zooming in.',
  });
  assert.deepEqual(parseEmbeddedVoiceCommand('zoom out').args, { direction: 'out', amount: 'medium' });
  assert.equal(parseEmbeddedVoiceCommand('locate me').action, 'locate_me');
  assert.equal(parseEmbeddedVoiceCommand('find my location').action, 'locate_me');
  const status = parseEmbeddedVoiceCommand('status');
  assert.equal(status.action, 'get_current_view_state');
  assert.equal(status.reply, null); // reply is built from live state
  assert.equal(parseEmbeddedVoiceCommand('where am i').action, 'get_current_view_state');
  const help = parseEmbeddedVoiceCommand('help');
  assert.equal(help.help, true);
  assert.ok(help.reply.includes('fly to'));
});

test('unknown input suggests the closest command without network', () => {
  assert.ok(levenshtein('kitten', 'sitting') > 0);
  assert.equal(levenshtein('zoom in', 'zoom in'), 0);
  assert.equal(suggestClosestCommand('zoom in'), 'zoom in');
  assert.equal(suggestClosestCommand('fligh to austin'), 'fly to Austin');
  const unknown = parseEmbeddedVoiceCommand('zoon in');
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.suggestion, 'zoom in');
  assert.ok(unknown.reply.includes('zoom in'));
  const unrelated = parseEmbeddedVoiceCommand('purple elephant banana');
  // A bare multi-word name with no close command match is treated as a place.
  assert.equal(unrelated.action, 'fly_to_location');
  assert.equal(unrelated.args.query, 'purple elephant banana');
});

test('formatEmbeddedReply stays honest on failures', () => {
  assert.equal(
    formatEmbeddedReply({ action: 'fly_to_location' }, { ok: true, label: 'Austin' }),
    'Now at Austin.',
  );
  assert.equal(
    formatEmbeddedReply({ action: 'set_layer_visibility' }, { ok: true, label: 'Traffic', layerId: 'traffic', enabled: true }),
    'Traffic on.',
  );
  assert.ok(formatEmbeddedReply({ action: 'fly_to_location' }, { ok: false, error: 'No match' }).startsWith('That did not work.'));
  assert.equal(formatEmbeddedReply({ action: 'fly_to_location' }, null), 'That did not work. Try again.');
  assert.equal(
    formatStatusReply({ layers: [{ id: 'traffic', name: 'Traffic', enabled: true }], camera: { latitude: 30.26, longitude: -97.74 } }),
    'Layers on: Traffic. Position 30.26, -97.74.',
  );
  assert.equal(formatStatusReply({ layers: [] }), 'All layers off.');
});

test('speech helpers degrade cleanly without a browser', () => {
  assert.equal(getSpeechSynthesisHandle({}), null);
  assert.equal(getSpeechSynthesisHandle(undefined), null);
  assert.equal(speakEmbeddedReply('hello', { synthesis: null }), false);
  assert.equal(speakEmbeddedReply('   ', { synthesis: null }), false);
  assert.doesNotThrow(() => cancelEmbeddedSpeech(null));
});

// ---- Stubbed-browser agent tests ----

function stubSynthesis() {
  const spoken = [];
  function FakeUtterance(text) {
    this.text = text;
  }
  return {
    spoken,
    Utterance: FakeUtterance,
    handle: {
      speak(u) { spoken.push(u.text); },
      cancel() { spoken.length = 0; },
      Utterance: FakeUtterance,
    },
  };
}

function stubRecognitionCtor() {
  function FakeRecognition() {
    FakeRecognition.instances.push(this);
    this.started = false;
  }
  FakeRecognition.instances = [];
  FakeRecognition.prototype.start = function () { this.started = true; };
  FakeRecognition.prototype.stop = function () { this.started = false; };
  FakeRecognition.prototype.abort = function () { this.started = false; };
  return FakeRecognition;
}

test('agent speaks confirmations for mapped intents via stubbed speech', async () => {
  const { handle, spoken } = stubSynthesis();
  const calls = [];
  const agent = createEmbeddedVoiceAgent({
    runner: async (action, args) => {
      calls.push([action, args]);
      if (action === 'fly_to_location') return { ok: true, label: 'Austin' };
      if (action === 'set_layer_visibility') return { ok: true, layerId: args.layerId, label: 'Traffic', enabled: args.enabled };
      return { ok: true };
    },
    recognitionCtor: stubRecognitionCtor(),
    synthesis: handle,
  });
  assert.equal(agent.isSupported(), true);
  assert.equal(agent.start(), true);
  await agent.handleTranscript('fly to Austin');
  assert.deepEqual(calls[0], ['fly_to_location', { query: 'Austin' }]);
  assert.ok(spoken.some((s) => s.includes('Austin')), `spoken: ${JSON.stringify(spoken)}`);
  spoken.length = 0; // next command cancels the previous reply
  await agent.handleTranscript('turn traffic on');
  assert.deepEqual(calls[1], ['set_layer_visibility', { layerId: 'traffic', enabled: true }]);
  assert.ok(spoken.some((s) => s.includes('Traffic')), `spoken: ${JSON.stringify(spoken)}`);
  agent.stop();
});

test('agent answers help locally and clarifies unknown input', async () => {
  const { handle, spoken } = stubSynthesis();
  let runnerCalls = 0;
  const agent = new EmbeddedVoiceAgent({
    runner: async () => { runnerCalls++; return { ok: true }; },
    recognitionCtor: stubRecognitionCtor(),
    synthesis: handle,
  });
  agent.start();
  await agent.handleTranscript('help');
  assert.equal(runnerCalls, 0);
  assert.ok(spoken.some((s) => s.includes('fly to')));
  await agent.handleTranscript('zoon in');
  assert.equal(runnerCalls, 0);
  assert.ok(spoken.some((s) => s.includes('zoom in')));

  // New commands cancel in-flight speech before speaking the new reply.
  spoken.push('stale reply');
  await agent.handleTranscript('zoom in');
  assert.equal(runnerCalls, 1);
  assert.ok(!spoken.includes('stale reply'), 'stale speech must be cancelled');
  agent.stop();
});

test('locate-me geolocates then flies via the runner (stubbed)', async () => {
  const { handle, spoken } = stubSynthesis();
  const calls = [];
  const agent = new EmbeddedVoiceAgent({
    runner: async (action, args) => {
      calls.push([action, args]);
      return { ok: true, label: '30.2700, -97.7500' };
    },
    recognitionCtor: stubRecognitionCtor(),
    synthesis: handle,
    geolocation: {
      getCurrentPosition: (ok) => ok({ coords: { latitude: 30.27, longitude: -97.75 } }),
    },
  });
  agent.start();
  await agent.handleTranscript('locate me');
  assert.deepEqual(calls[0], ['fly_to_location', { latitude: 30.27, longitude: -97.75 }]);
  assert.ok(spoken.some((s) => s.includes('30.2700')), `spoken: ${JSON.stringify(spoken)}`);
  agent.stop();
});

test('unsupported browsers get the degrade message, never a throw', () => {
  const { handle, spoken } = stubSynthesis();
  const agent = new EmbeddedVoiceAgent({
    runner: async () => ({ ok: true }),
    recognitionCtor: null,
    synthesis: handle,
  });
  assert.equal(agent.isSupported(), false);
  assert.equal(agent.start(), false);
  assert.ok(spoken.some((s) => s === EMBEDDED_VOICE_UNSUPPORTED_REPLY));
});

test('continuous toggle and push-to-talk reuse the shared mic guards', () => {
  const Ctor = stubRecognitionCtor();
  const agent = new EmbeddedVoiceAgent({
    runner: async () => ({ ok: true }),
    recognitionCtor: Ctor,
    synthesis: null,
  });
  agent.start({ continuous: true });
  assert.equal(agent.setContinuous(false), false);
  assert.equal(Ctor.instances[0].continuous, false);

  const added = [];
  const target = {
    addEventListener: (t, fn) => added.push([t, fn]),
    removeEventListener: () => {},
  };
  const detach = agent.attachPushToTalk({ target });
  assert.deepEqual(added.map(([t]) => t), ['keydown', 'keyup']);
  const [, keyDown] = added.find(([t]) => t === 'keydown');
  // Typing in an input must not trigger PTT.
  let started = 0;
  agent.attachPushToTalk({ target, onHoldStart: () => { started++; } });
  keyDown({ code: 'Space', target: { closest: () => ({}) }, preventDefault: () => {} });
  assert.equal(started, 0);
  assert.doesNotThrow(detach);
  agent.stop();
});

// ---- GevRealtimeController wiring tests (stubbed recognition/synthesis/runner) ----

function stubSynthesisForWiring() {
  const spoken = [];
  const handle = {
    speak(u) { spoken.push(u); },
    cancel() { spoken.length = 0; },
    Utterance: function (text) { this.text = text; },
  };
  return { spoken, handle };
}

function stubRecognitionCtorForWiring() {
  function FakeRecognition() {
    FakeRecognition.instances.push(this);
    this.lang = 'en-US';
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.continuous = false;
    this.started = false;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  FakeRecognition.instances = [];
  FakeRecognition.prototype.start = function () { this.started = true; };
  FakeRecognition.prototype.stop = function () { this.started = false; };
  FakeRecognition.prototype.abort = function () { this.started = false; };
  return FakeRecognition;
}

function wiringUiMock() {
  return {
    root: {
      dataset: {},
      classList: { remove() {}, add() {} },
      querySelectorAll: () => [],
    },
    button: { addEventListener: () => {}, removeEventListener: () => {} },
    buttonLabel: { textContent: '' },
    status: { textContent: '' },
    detail: { textContent: '', title: '' },
    helpDetail: { textContent: '' },
    errorDetail: { textContent: '' },
    tierButton: null,
    costValue: { textContent: '', dataset: {} },
  };
}

test('wiring prefers embedded voice on mic click when no Realtime route is live', async () => {
  const { spoken } = stubSynthesisForWiring();
  let runnerCalls = 0;
  const controller = new GevRealtimeController({
    runner: async () => { runnerCalls++; return { ok: true, label: 'Austin' }; },
    ui: wiringUiMock(),
  });
  controller.debugLog = () => {};

  // No API base → realtimeRouteLive is false → mic click launches embedded voice.
  const launched = controller.launchEmbeddedVoice();
  assert.equal(launched, true, 'launchEmbeddedVoice returns true when supported');
  assert.ok(controller.embeddedAgent, 'embedded agent is retained on the controller');
  assert.equal(runnerCalls, 0, 'launching embedded voice does not call the Realtime runner');

  // Route one transcript through the embedded recognition path (stubbed ctor).
  const wire2 = stubSynthesisForWiring();
  controller.embeddedAgent.synthesis = wire2.handle;
  controller.embeddedAgent.recognitionCtor = stubRecognitionCtorForWiring();
  controller.embeddedAgent.active = true;
  await controller.embeddedAgent.handleTranscript('fly to Austin');
  assert.equal(runnerCalls, 1, 'transcript routes through createEmbeddedVoiceAgent → parseEmbeddedVoiceCommand → runner');
  assert.ok(wire2.spoken.some((s) => (typeof s === 'string' ? s : s?.text || '').includes('Austin')), `spoken: ${JSON.stringify(wire2.spoken)}`);
  controller.stop();
});

test('wiring keeps Realtime path available when API base is configured', () => {
  const controller = new GevRealtimeController({
    runner: async () => ({ ok: true }),
    ui: wiringUiMock(),
  });
  controller.debugLog = () => {};

  // Force the Realtime route to appear live for this test.
  controller.realtimeRouteLive = () => true;

  // When the Realtime route is live, launchEmbeddedVoice still works (it is the
  // free path), but the Realtime start() is no longer gated out — so the mic button
  // handler would proceed to controller.start() after the embedded path is offered.
  const launched = controller.launchEmbeddedVoice();
  assert.equal(launched, true, 'embedded voice is still offered when Realtime route is live');
  assert.ok(controller.embeddedAgent, 'embedded agent created even when Realtime route is live');
  controller.stop();
});

test('stop tears down embedded voice so the mic is not left live', async () => {
  const controller = new GevRealtimeController({
    runner: async () => ({ ok: true }),
    ui: wiringUiMock(),
  });
  controller.debugLog = () => {};

  const launched = controller.launchEmbeddedVoice();
  assert.equal(launched, true);
  assert.ok(controller.embeddedAgent);

  // Start the embedded agent so it owns the mic (stubbed ctor).
  controller.embeddedAgent.recognitionCtor = stubRecognitionCtorForWiring();
  controller.embeddedAgent.start();
  assert.equal(controller.embeddedAgent.active, true);

  // stop() must tear down the embedded agent.
  controller.stop();
  assert.equal(controller.embeddedAgent, null, 'embedded agent cleared by stop()');
  assert.equal(controller.status, 'idle', 'controller returns to idle after embedded stop');
});
