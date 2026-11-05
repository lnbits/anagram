// The real process: configuration errors, startup, SIGTERM and restart, over a local relay.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { getPublicKey } from 'nostr-tools';
import { now } from '../vendor/runtime.js';
import { relay, until } from './relay.js';
import { ALICE_KEY, alice, defer, npub, tempDir } from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';

const BOT = fileURLToPath(new URL('../bot.js', import.meta.url));
const GUARD = fileURLToPath(new URL('./no-network.js', import.meta.url));
// A closed port on this computer: a bot that should never get this far cannot reach anything.
const NOWHERE = 'ws://127.0.0.1:9/';

// Starts bot.js in its own directory with only the variables given, so a developer's .env
// or shell (NSEC, WALLETS_FILE...) never leaks in. The network guard is preloaded, and the
// child is killed if it outlives timeoutMs. Only this child is ever signalled.
let runs = 0;
function run(t, dir, env, { timeoutMs = 10000 } = {}) {
  const index = ++runs;
  let output = '';
  const child = spawn(process.execPath, ['--import', GUARD, BOT], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, RELAYS: NOWHERE, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, output });
    }),
  );
  defer(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    // One file per process, kept with the directory if the test fails.
    writeFileSync(`${dir}/output-${index}.txt`, output);
  });
  return { child, exited, output: () => output };
}

// Fixtures are built when a case runs, in that case's own directory.
function walletFile(dir, mode = 0o600, owner = npub(alice)) {
  const file = `${dir}/wallets.json`;
  writeFileSync(file, JSON.stringify({ [owner]: { label: 'Alice', invoiceKey: ALICE_KEY } }), {
    mode,
  });
  chmodSync(file, mode);
  return file;
}
const state = (dir) => JSON.parse(readFileSync(`${dir}/data/state.json`, 'utf8'));
const base = (dir) => ({ DATA_DIR: `${dir}/data`, LNBITS_URL: 'https://lnbits.example' });

const INVALID = [
  [
    'missing-url',
    (dir) => ({ DATA_DIR: `${dir}/data`, WALLETS_FILE: walletFile(dir) }),
    /LNBITS_URL is required/,
  ],
  [
    'http-url',
    (dir) => ({ ...base(dir), LNBITS_URL: 'http://127.0.0.1:5000', WALLETS_FILE: walletFile(dir) }),
    /must use HTTPS/,
  ],
  [
    'no-wallets',
    (dir) => ({ ...base(dir), WALLETS_FILE: `${dir}/missing.json` }),
    /does not exist/,
  ],
  ['wallets-644', (dir) => ({ ...base(dir), WALLETS_FILE: walletFile(dir, 0o644) }), /chmod 600/],
  ['wallets-640', (dir) => ({ ...base(dir), WALLETS_FILE: walletFile(dir, 0o640) }), /chmod 600/],
  [
    'bad-nsec',
    (dir) => ({ ...base(dir), WALLETS_FILE: walletFile(dir), NSEC: 'nsec1bad' }),
    /NSEC must be a valid nsec/,
  ],
];
for (const [label, env, message] of INVALID)
  test(`invalid configuration (${label}) stops startup before an identity exists`, async (t) => {
    const dir = tempDir(t, `cli-${label}`);
    const result = await run(t, dir, env(dir)).exited;
    assert.equal(result.timedOut, false, `exited by itself:\n${result.output}`);
    assert.equal(result.code, 1);
    assert.match(result.output, message);
    assert.ok(!result.output.includes(ALICE_KEY), 'the wallet key is never echoed');
    assert.ok(!existsSync(`${dir}/data/state.json`), 'no identity was created');
    assert.ok(!result.output.includes('[no-network]'), 'nothing tried to leave this computer');
  });

// Regression: a shared fixture once turned the 0644 case into a valid start against the
// default public relays. That case must stay a refusal even when other cases run.
test('the private-file check reads the file this case wrote, not a neighbour', async (t) => {
  const dir = tempDir(t, 'cli-mode-regression');
  const file = walletFile(dir, 0o644);
  const other = tempDir(t, 'cli-mode-other');
  walletFile(other, 0o600);
  const result = await run(t, dir, { ...base(dir), WALLETS_FILE: file }).exited;
  assert.equal(result.code, 1);
  assert.match(result.output, /chmod 600/);
});

test('without RELAYS the default public relays are blocked in tests, not contacted', async (t) => {
  const dir = tempDir(t, 'cli-defaults');
  const { child, output, exited } = run(t, dir, {
    ...base(dir),
    WALLETS_FILE: walletFile(dir),
    RELAYS: '',
  });
  await until(() => /\[no-network\] blocked/.test(output()), 'guard refusal', 8000);
  child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.timedOut, false);
  assert.doesNotMatch(result.output, /Profile and DM inbox published/);
});

// A local mock LNbits holding Alice's wallet, so a running bot never needs the network.
async function localLNbits(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'alice', balance: 2_100_500, payments: [] },
  });
  defer(t, () => server.close());
  return server;
}

// Starts a bot linked to Alice against a local relay and local LNbits, and waits until it
// has checked its wallet link.
async function startBot(t, dir, local, lnbits, marker = /LNbits accepted 1 of 1 wallet link/) {
  const env = {
    ...base(dir),
    LNBITS_URL: lnbits.url,
    LNBITS_ALLOW_HTTP: 'true',
    WALLETS_FILE: `${dir}/wallets.json`,
    RELAYS: local.url,
  };
  const bot = run(t, dir, env, { timeoutMs: 20000 });
  await until(() => marker.test(bot.output()), 'startup', 10000);
  const pubkey = /: (npub1[a-z0-9]+)/.exec(bot.output())[1];
  return { ...bot, pubkey };
}
const fromBot = (local, key) =>
  [...local.events.values()]
    .filter((e) => e.kind === 1059)
    .flatMap((event) => {
      try {
        return [unwrapEvent(event, key)];
      } catch {
        return [];
      }
    });
async function stop(bot) {
  const started = Date.now();
  bot.child.kill('SIGTERM');
  const result = await bot.exited;
  return { ...result, ms: Date.now() - started };
}

test(
  'SIGTERM exits within 5 seconds, releases the lock and keeps state; restart answers once',
  { timeout: 60000 },
  async (t) => {
    const dir = tempDir(t, 'cli-sigterm');
    const local = await relay();
    defer(t, () => local.close());
    const lnbits = await localLNbits(t);
    walletFile(dir);
    const first = await startBot(t, dir, local, lnbits);
    await until(() => /Profile and DM inbox published\./.test(first.output()), 'profile', 10000);
    assert.match(first.output(), /LNbits Wallet: npub1/);
    const { nip19 } = await import('nostr-tools');
    const botKey = nip19.decode(first.pubkey).data;
    const message = wrapEvent(
      { kind: 14, tags: [['p', botKey]], content: '/balance', created_at: now() },
      alice,
      botKey,
    );
    local.emit(message);
    await until(() => fromBot(local, alice).length === 1, 'reply', 10000);
    assert.equal(fromBot(local, alice)[0].content, 'Balance (Alice): 2,100.5 sats');

    const stopped = await stop(first);
    assert.equal(stopped.timedOut, false);
    assert.equal(stopped.code, 0, stopped.output);
    assert.ok(stopped.ms < 5000, `shutdown took ${stopped.ms} ms`);
    assert.ok(!existsSync(`${dir}/data/process.lock`), 'lock released');
    const saved = state(dir);
    assert.equal(Object.keys(saved.seen).length, 1, 'the handled message is remembered');
    assert.ok(saved.authorized.users[getPublicKey(alice)]);

    // The relay resends Alice's message to the restarted bot; it is not answered again.
    const second = await startBot(t, dir, local, lnbits);
    assert.equal(second.pubkey, first.pubkey, 'same identity');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fromBot(local, alice).length, 1, 'no duplicate reply');
    // Startup check, the /balance, the second startup check: never the old /balance again.
    // (Payment-notification history scans are counted separately.)
    assert.equal(lnbits.requests.filter((r) => r.path === '/api/v1/wallet').length, 3);
    const again = await stop(second);
    assert.equal(again.code, 0);
    assert.ok(again.ms < 5000, `shutdown took ${again.ms} ms`);
    assert.ok(!(first.output() + second.output()).includes(ALICE_KEY));
    assert.ok(!(first.output() + second.output()).includes('[no-network]'));
  },
);

test(
  'replies waiting for relays survive SIGTERM and are published unchanged after restart',
  { timeout: 60000 },
  async (t) => {
    const dir = tempDir(t, 'cli-outbox');
    const local = await relay();
    defer(t, () => local.close());
    const lnbits = await localLNbits(t);
    walletFile(dir);
    local.reject = true; // the relay refuses every publication for now
    const first = await startBot(t, dir, local, lnbits);
    const { nip19 } = await import('nostr-tools');
    const botKey = nip19.decode(first.pubkey).data;
    local.emit(
      wrapEvent(
        { kind: 14, tags: [['p', botKey]], content: '/balance', created_at: now() },
        alice,
        botKey,
      ),
    );
    await until(
      () => existsSync(`${dir}/data/state.json`) && state(dir).outbox.length === 1,
      'queued reply',
      10000,
    );
    const queued = state(dir)
      .outbox.map((item) => item.event.id)
      .sort();

    const stopped = await stop(first);
    assert.equal(stopped.code, 0, stopped.output);
    assert.ok(stopped.ms < 5000, `shutdown took ${stopped.ms} ms`);
    assert.deepEqual(
      state(dir)
        .outbox.map((item) => item.event.id)
        .sort(),
      queued,
      'outbox kept on disk',
    );

    local.reject = false;
    const second = await startBot(t, dir, local, lnbits);
    await until(() => queued.every((id) => local.events.has(id)), 'outbox published', 15000);
    await until(() => state(dir).outbox.length === 0, 'outbox emptied', 10000);
    assert.equal(fromBot(local, alice).length, 1, 'one reply, the original one');
    assert.equal(fromBot(local, alice)[0].content, 'Balance (Alice): 2,100.5 sats');
    assert.ok(!(first.output() + second.output()).includes('[no-network]'));
    assert.equal((await stop(second)).code, 0);
  },
);

test(
  'the real process announces an incoming payment over a local relay, then stops on SIGTERM',
  { timeout: 60000 },
  async (t) => {
    const dir = tempDir(t, 'cli-notify');
    const local = await relay();
    defer(t, () => local.close());
    const lnbits = await localLNbits(t);
    walletFile(dir);
    const bot = await startBot(t, dir, local, lnbits);
    await until(
      () => /Payment notifications for npub1\S+ started/.test(bot.output()),
      'baseline',
      10000,
    );
    await until(() => lnbits.open(ALICE_KEY) === 1, 'payment socket', 10000);
    lnbits.settle(ALICE_KEY, { sats: 42, memo: 'from the cli test' });
    await until(() => fromBot(local, alice).length === 1, 'notification', 10000);
    assert.match(
      fromBot(local, alice)[0].content,
      /^Received \(Alice\): \+42 sats .* from the cli test$/,
    );
    const stopped = await stop(bot);
    assert.equal(stopped.code, 0, stopped.output);
    assert.ok(stopped.ms < 5000, `shutdown took ${stopped.ms} ms`);
    await until(() => lnbits.open(ALICE_KEY) === 0, 'socket closed', 5000);
    assert.ok(!bot.output().includes(ALICE_KEY), 'the key is not printed');
    assert.ok(!bot.output().includes('api/v1/ws'), 'the socket URL is not printed');
    assert.ok(!bot.output().includes('[no-network]'));
  },
);
