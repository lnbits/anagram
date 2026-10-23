import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { now } from '../runtime.js';
import { relay, until } from './relay.js';
import { chat, json, ollamaServer } from './ollama-server.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${cwd}data`, { recursive: true });

// Only the variables a test sets reach the child, so a developer's own .env or shell
// configuration (NSEC, ALLOWED_NPUBS...) can never leak into a test run.
function run(env, config) {
  let output = '';
  const child = spawn(process.execPath, [...(config ? [`--env-file=${config}`] : []), 'bot.js'], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  return { child, output: () => output };
}

test('invalid configuration stops startup with a clear message and no identity is created', async (t) => {
  const dir = mkdtempSync(`${cwd}data/cli-config-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { child, output } = run({ DATA_DIR: dir, OLLAMA_URL: 'http://192.168.1.10:11434' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output(), /OLLAMA_ALLOW_REMOTE=true/);
  assert.equal(existsSync(`${dir}/state.json`), false);
});

test(
  'CLI starts, checks the model, answers an allowed DM and stops cleanly on SIGTERM',
  { timeout: 60000 },
  async (t) => {
    const local = await relay();
    const ollama = await ollamaServer((request, res) =>
      request.url === '/api/tags'
        ? json(res, 200, { models: [{ name: 'test-model:latest' }] })
        : chat(res, 'Hello from the local model.'),
    );
    const dir = mkdtempSync(`${cwd}data/cli-test-`);
    const key = generateSecretKey(),
      user = generateSecretKey();
    const config = `${dir}/bot.env`;
    writeFileSync(
      config,
      `NSEC=${nip19.nsecEncode(key)}\nALLOWED_NPUBS=${nip19.npubEncode(getPublicKey(user))}\n`,
      { mode: 0o600 },
    );
    let child;
    t.after(async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      await local.close();
      await ollama.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const bot = run(
      { DATA_DIR: dir, RELAYS: local.url, OLLAMA_URL: ollama.url, OLLAMA_MODEL: 'test-model' },
      config,
    );
    child = bot.child;
    await until(() => bot.output().includes('Profile and DM inbox published.'), 'CLI startup');
    await until(() => bot.output().includes('model test-model is installed'), 'model check');
    assert.ok(bot.output().includes(nip19.npubEncode(getPublicKey(key))));
    local.emit(
      wrapEvent(
        {
          kind: 14,
          tags: [['p', getPublicKey(key)]],
          content: 'secret question',
          created_at: now(),
        },
        user,
        getPublicKey(key),
      ),
    );
    const answered = () =>
      [...local.events.values()].some((event) => {
        try {
          return (
            event.kind === 1059 &&
            unwrapEvent(event, user).content === 'Hello from the local model.'
          );
        } catch {
          return false;
        }
      });
    await until(answered, 'DM answer');
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(existsSync(`${dir}/process.lock`), false);
    assert.ok(!bot.output().includes('secret question'), 'message text is never logged');
    assert.ok(!readFileSync(`${dir}/state.json`, 'utf8').includes('secret question'));
  },
);
