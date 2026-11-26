import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { DEFAULT_MODEL, DEFAULT_RELAYS, loadConfig } from '../config.js';
import { ConfigurationError } from '../runtime.js';

test('defaults are safe: loopback Ollama, nobody allowed, bounded limits', () => {
  const config = loadConfig({});
  assert.equal(config.ollama.url, 'http://127.0.0.1:11434');
  assert.equal(config.ollama.allowRemote, false);
  assert.equal(config.ollama.model, DEFAULT_MODEL);
  assert.equal(config.ollama.timeoutMs, 120000);
  assert.deepEqual(config.relays, DEFAULT_RELAYS);
  assert.deepEqual(config.access, { senders: [], privateGroups: [], publicGroups: [] });
  assert.deepEqual(config.limits, {
    maxInputChars: 4000,
    maxOutputChars: 4000,
    requestsPerHour: 30,
    maxQueue: 10,
  });
  assert.deepEqual(config.history, { maxMessages: 20, maxChars: 8000, idleSeconds: 3600 });
});

test('remote Ollama endpoints need explicit opt-in and every value is validated', () => {
  assert.throws(
    () => loadConfig({ OLLAMA_URL: 'http://192.168.1.5:11434' }),
    (error) => error instanceof ConfigurationError && /OLLAMA_ALLOW_REMOTE/.test(error.message),
  );
  const remote = loadConfig({
    OLLAMA_URL: 'https://gpu.example.org',
    OLLAMA_ALLOW_REMOTE: 'true',
  });
  assert.equal(remote.ollama.allowRemote, true);
  for (const env of [
    { OLLAMA_ALLOW_REMOTE: 'maybe' },
    { OLLAMA_TIMEOUT_SECONDS: '0' },
    { OLLAMA_TIMEOUT_SECONDS: 'ten' },
    { MAX_OUTPUT_CHARS: '1.5' },
    { MAX_QUEUE: '-1' },
    { HISTORY_MAX_MESSAGES: '9999' },
    { OLLAMA_URL: 'http://user:secret@127.0.0.1:11434' },
  ])
    assert.throws(() => loadConfig(env), ConfigurationError, JSON.stringify(env));
  const custom = loadConfig({
    OLLAMA_MODEL: ' qwen3:8b ',
    OLLAMA_TIMEOUT_SECONDS: '30',
    MAX_OUTPUT_CHARS: '900',
    HISTORY_IDLE_MINUTES: '5',
  });
  assert.equal(custom.ollama.model, 'qwen3:8b');
  assert.equal(custom.ollama.timeoutMs, 30000);
  assert.equal(custom.ollama.maxTokens, 300);
  assert.equal(custom.history.idleSeconds, 300);
});

test('allowlists accept npub, nostr:npub and hex, and reject anything else', () => {
  const a = getPublicKey(generateSecretKey()),
    b = getPublicKey(generateSecretKey()),
    group = getPublicKey(generateSecretKey());
  const config = loadConfig({
    ALLOWED_NPUBS: ` ${nip19.npubEncode(a)}, nostr:${nip19.npubEncode(b)} ,`,
    ALLOWED_PRIVATE_GROUPS: group,
  });
  assert.deepEqual(config.access.senders, [a, b]);
  assert.deepEqual(config.access.privateGroups, [group]);
  assert.throws(
    () => loadConfig({ ALLOWED_NPUBS: nip19.nsecEncode(generateSecretKey()) }),
    /ALLOWED_NPUBS entry 1/,
  );
  assert.throws(() => loadConfig({ ALLOWED_PRIVATE_GROUPS: 'everyone' }), ConfigurationError);
});

test('allowed public groups accept naddr values and full share links', () => {
  const owner = getPublicKey(generateSecretKey());
  const naddr = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner,
    identifier: 'ai-room',
    relays: ['wss://relay.example'],
  });
  const config = loadConfig({
    ALLOWED_PUBLIC_GROUPS: `${naddr},https://anagram.chat/join/chat.html#/public/${naddr}`,
  });
  assert.deepEqual(
    config.access.publicGroups.map((g) => g.address),
    [`34550:${owner}:ai-room`, `34550:${owner}:ai-room`],
  );
  assert.throws(
    () => loadConfig({ ALLOWED_PUBLIC_GROUPS: nip19.npubEncode(owner) }),
    /ALLOWED_PUBLIC_GROUPS entry 1/,
  );
});
