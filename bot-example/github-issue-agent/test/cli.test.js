import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { relay, until } from './relay.js';
import { json, ollamaServer } from './ollama-server.js';
import { githubServer } from './github-server.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${cwd}data`, { recursive: true });

// Only the variables a test sets reach the child, so a developer's own .env or shell
// configuration (GITHUB_TOKEN, NSEC...) can never leak into a test run.
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
  for (const [env, message] of [
    [{}, /GITHUB_TOKEN is required/],
    [{ GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, /Classic tokens are refused/],
  ]) {
    const { child, output } = run({ DATA_DIR: dir, ...env });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(output(), message);
    assert.ok(!output().includes('ghp_abc'), 'the token is not echoed');
  }
  assert.equal(existsSync(`${dir}/state.json`), false);
});

test(
  'CLI starts, checks Ollama and GitHub, and stops cleanly on SIGTERM',
  { timeout: 30000 },
  async (t) => {
    const local = await relay();
    const ollama = await ollamaServer((request, res) =>
      json(res, 200, { models: [{ name: 'test-model:latest' }] }),
    );
    const github = await githubServer();
    const dir = mkdtempSync(`${cwd}data/cli-test-`);
    const config = `${dir}/bot.env`;
    const user = nip19.npubEncode(getPublicKey(generateSecretKey()));
    writeFileSync(
      config,
      [
        `NSEC=${nip19.nsecEncode(generateSecretKey())}`,
        `GITHUB_TOKEN=${github.token}`,
        `GITHUB_API_URL=${github.url}`,
        'GITHUB_ALLOW_LOCAL=true',
        'ALLOWED_REPOS=lnbits/anagram',
        `ALLOWED_USERS=${user}=*`,
        `OLLAMA_URL=${ollama.url}`,
        'OLLAMA_MODEL=test-model',
        `RELAYS=${local.url}`,
        `DATA_DIR=${dir}/data`,
      ].join('\n'),
      { mode: 0o600 },
    );
    const { child, output } = run({}, config);
    t.after(async () => {
      child.kill('SIGKILL');
      await local.close();
      await ollama.close();
      await github.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await until(() => /lnbits\/anagram: ok/.test(output()), 'startup checks', 15000);
    assert.match(output(), /GitHub Issue Agent \(Example Anagram Bot\): npub1/);
    assert.match(output(), /model test-model is installed/);
    assert.match(output(), /GitHub token accepted \(account issue-bot\)/);
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.ok(!output().includes(github.token));
    assert.equal(existsSync(`${dir}/data/process.lock`), false);
  },
);
