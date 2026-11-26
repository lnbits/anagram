import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  failureText,
  formatAnswer,
  helpText,
  neutralizeMentions,
  parseCommand,
  stripMention,
} from '../commands.js';
import { mentions } from '../runtime.js';
import { OllamaError } from '../ollama.js';

const bot = getPublicKey(generateSecretKey());
const other = getPublicKey(generateSecretKey());

test('commands are recognized only at the start of a message', () => {
  assert.equal(parseCommand('/help'), 'help');
  assert.equal(parseCommand('/RESET please'), 'reset');
  assert.equal(parseCommand('/model'), 'model');
  assert.equal(parseCommand('/setmodel llama3'), 'unknown');
  assert.equal(parseCommand('/usr/bin is a folder'), null);
  assert.equal(parseCommand('what does /reset do?'), null);
  assert.equal(parseCommand('hello'), null);
  assert.match(helpText('llama3.2'), /\/help[\s\S]*\/reset[\s\S]*\/model/);
  assert.match(helpText('llama3.2'), /llama3\.2/);
});

test("only the bot's own mention is removed from the prompt", () => {
  const me = nip19.npubEncode(bot);
  const them = nip19.npubEncode(other);
  assert.equal(stripMention(`nostr:${me} /help`, bot), '/help');
  assert.equal(
    stripMention(`Hey ${nip19.nprofileEncode({ pubkey: bot })} ask ${them}`, bot),
    `Hey ask ${them}`,
  );
  assert.equal(stripMention(`  nostr:${me}  `, bot), '');
});

test('model output cannot mention (and so trigger) other accounts', () => {
  const text = `Ask nostr:${nip19.npubEncode(other)} or ${nip19.nprofileEncode({ pubkey: other })}.`;
  const safe = neutralizeMentions(text);
  assert.equal(mentions(safe, other), false);
  assert.match(safe, /npub1\w{7}…\w{4}/);
  assert.equal(neutralizeMentions('npub1notreallyakey'), 'npub1notreallyakey');
});

test('answers are limited by characters, never split inside an emoji', () => {
  assert.equal(formatAnswer('  short  ', 100), 'short');
  const long = formatAnswer('😀'.repeat(10), 4);
  assert.ok(long.startsWith('😀😀😀😀…'));
  assert.match(long, /shortened/);
  assert.ok(!long.includes('�'));
  assert.match(formatAnswer('cut by the model', 100, true), /shortened/);
});

test('failure messages are friendly and reveal no configuration', () => {
  const codes = ['model_not_found', 'timeout', 'unavailable', 'invalid_response', 'too_large'];
  for (const code of codes) {
    const text = failureText(new OllamaError(code, 'http://127.0.0.1:11434 secret detail'), 'm');
    assert.ok(text.length > 10);
    assert.ok(!/127\.0\.0\.1|11434|secret/.test(text), text);
  }
  assert.match(
    failureText(new OllamaError('model_not_found', ''), 'llama3.2'),
    /ollama pull llama3\.2/,
  );
  assert.match(failureText(new TypeError('boom'), 'm'), /unexpected/);
});
