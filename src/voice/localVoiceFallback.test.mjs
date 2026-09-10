// Keyless Web Speech API voice fallback (static hosting: no /api/realtime/token
// backend). Pure-logic tests only — no DOM, no microphone.
//
// Run with: node --test src/voice/localVoiceFallback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appAssetUrl,
  getLocalSpeechRecognitionCtor,
  parseLocalVoiceCommand,
} from './gevRealtime.js';

test('location verbs are stripped to the search query', () => {
  assert.deepEqual(parseLocalVoiceCommand('fly to Austin'), {
    action: 'fly_to_location',
    args: { query: 'Austin' },
  });
  assert.deepEqual(parseLocalVoiceCommand('take me to the Eiffel Tower'), {
    action: 'fly_to_location',
    args: { query: 'Eiffel Tower' },
  });
  assert.deepEqual(parseLocalVoiceCommand('please show me Tokyo'), {
    action: 'fly_to_location',
    args: { query: 'Tokyo' },
  });
  assert.deepEqual(parseLocalVoiceCommand('go to Zilker Park'), {
    action: 'fly_to_location',
    args: { query: 'Zilker Park' },
  });
});

test('a bare place name passes through as the query', () => {
  assert.deepEqual(parseLocalVoiceCommand('Reykjavik'), {
    action: 'fly_to_location',
    args: { query: 'Reykjavik' },
  });
  // "to" must not eat into place names that start with To- (Tokyo, Toronto).
  assert.deepEqual(parseLocalVoiceCommand('show me Tokyo'), {
    action: 'fly_to_location',
    args: { query: 'Tokyo' },
  });
  assert.deepEqual(parseLocalVoiceCommand('fly to Toronto'), {
    action: 'fly_to_location',
    args: { query: 'Toronto' },
  });
  // A verb with nothing after it keeps the whole utterance (never empty).
  assert.deepEqual(parseLocalVoiceCommand('fly'), {
    action: 'fly_to_location',
    args: { query: 'fly' },
  });
});

test('empty transcripts route nowhere', () => {
  assert.equal(parseLocalVoiceCommand(''), null);
  assert.equal(parseLocalVoiceCommand('   '), null);
  assert.equal(parseLocalVoiceCommand(null), null);
});

test('speech-recognition detection never throws and prefers the standard ctor', () => {
  assert.equal(getLocalSpeechRecognitionCtor({}), null);
  assert.equal(getLocalSpeechRecognitionCtor(undefined), null);
  function Standard() {}
  function Webkit() {}
  assert.equal(getLocalSpeechRecognitionCtor({ SpeechRecognition: Standard }), Standard);
  assert.equal(
    getLocalSpeechRecognitionCtor({ SpeechRecognition: Standard, webkitSpeechRecognition: Webkit }),
    Standard,
  );
  assert.equal(getLocalSpeechRecognitionCtor({ webkitSpeechRecognition: Webkit }), Webkit);
  assert.equal(getLocalSpeechRecognitionCtor({ SpeechRecognition: 'nope' }), null);
});

test('voice assets resolve base-relative, never root-absolute', () => {
  const url = appAssetUrl('mic.svg');
  assert.ok(!url.startsWith('/'), `must not be root-absolute: ${url}`);
  assert.ok(url.endsWith('mic.svg'), url);
  assert.equal(appAssetUrl('/mic.svg'), appAssetUrl('mic.svg'));
});
