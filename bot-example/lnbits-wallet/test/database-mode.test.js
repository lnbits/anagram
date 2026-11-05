// The real process in database mode, over a local relay and a local LNbits: migrate from a
// running M6 setup, keep its state, revoke from the CLI while it runs, then roll back.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { now } from '../vendor/runtime.js';
import { walletRef } from '../wallets.js';
import { ALICE_KEY, alice, defer, npub, tempDir } from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';
import { relay, until } from './relay.js';

const BOT = fileURLToPath(new URL('../bot.js', import.meta.url));
const ADMIN = fileURLToPath(new URL('../admin.js', import.meta.url));
const GUARD = fileURLToPath(new URL('./no-network.js', import.meta.url));

function start(t, dir, env) {
  let output = '';
  const child = spawn(process.execPath, ['--import', GUARD, BOT], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  defer(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return {
    output: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      return exited;
    },
  };
}
const admin = (env, ...args) => {
  const result = spawnSync(process.execPath, [ADMIN, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const replies = (local) =>
  [...local.events.values()]
    .filter((e) => e.kind === 1059)
    .flatMap((event) => {
      try {
        return [unwrapEvent(event, alice)];
      } catch {
        return [];
      }
    })
    .filter((m) => m.pubkey !== getPublicKey(alice));

test(
  'the connection page runs only in database mode, on this computer',
  { timeout: 40000 },
  async (t) => {
    const dir = tempDir(t, 'db-page');
    const local = await relay();
    defer(t, () => local.close());
    const common = {
      DATA_DIR: `${dir}/data`,
      LNBITS_URL: 'https://lnbits.test',
      RELAYS: local.url,
      SECRETS_DIR: `${dir}/secrets`,
      CONNECT_PUBLIC_URL: 'https://connect.test',
      CONNECT_PORT: '0',
    };
    const refused = start(t, dir, common);
    await until(() => /needs database mode/.test(refused.output()), 'refusal', 5000);

    admin(common, 'keyring', 'init');
    admin(common, 'connections', 'init');
    const bot = start(t, dir, common);
    await until(
      () => /Connection page listening on 127\.0\.0\.1:\d+/.test(bot.output()),
      'page',
      10000,
    );
    const port = /127\.0\.0\.1:(\d+)/.exec(bot.output())[1];
    const status = (host) =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/c', headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode);
          })
          .on('error', reject);
      });
    assert.equal(await status('connect.test'), 200);
    assert.equal(await status('127.0.0.1'), 421);
    await bot.stop();
  },
);

test(
  'migrate a running M6 setup, revoke from the CLI, then roll back: nothing lost, nothing revived',
  { timeout: 90000 },
  async (t) => {
    const dir = tempDir(t, 'db-process');
    const local = await relay();
    defer(t, () => local.close());
    const lnbits = await lnbitsServer({
      [ALICE_KEY]: { name: 'a', balance: 2_100_000, payments: [] },
    });
    defer(t, () => lnbits.close());
    const walletsFile = `${dir}/wallets.json`;
    writeFileSync(
      walletsFile,
      JSON.stringify({ [npub(alice)]: { label: 'Alice', invoiceKey: ALICE_KEY } }),
      { mode: 0o600 },
    );
    const common = {
      DATA_DIR: `${dir}/data`,
      LNBITS_URL: lnbits.url,
      LNBITS_ALLOW_HTTP: 'true',
      RELAYS: local.url,
    };
    const secrets = { ...common, SECRETS_DIR: `${dir}/secrets` };
    const ref = walletRef(getPublicKey(alice), ALICE_KEY);
    const state = () => JSON.parse(readFileSync(`${dir}/data/state.json`, 'utf8'));

    // M6: wallets.json mode. Baseline, then one message handled.
    const m6 = start(t, dir, { ...common, WALLETS_FILE: walletsFile });
    await until(() => /Payment notifications for .* started/.test(m6.output()), 'm6 start', 10000);
    const botKey = nip19.decode(/: (npub1[a-z0-9]+)/.exec(m6.output())[1]).data;
    const say = (content) =>
      local.emit(
        wrapEvent({ kind: 14, tags: [['p', botKey]], content, created_at: now() }, alice, botKey),
      );
    say('/balance');
    await until(() => replies(local).length === 1, 'm6 reply', 10000);
    await m6.stop();
    const linkedAt = state().authorized.users[getPublicKey(alice)];
    assert.ok(state().payments[ref], 'M6 notification state exists');

    // A payment while the bot is stopped, across the migration.
    lnbits.settle(ALICE_KEY, { sats: 7, memo: 'while migrating' });
    admin(secrets, 'keyring', 'init');
    admin(secrets, 'migrate', walletsFile);
    const db = start(t, dir, secrets);
    await until(() => /LNbits accepted 1 of 1/.test(db.output()), 'db start', 10000);
    assert.doesNotMatch(db.output(), /started; .* baseline/, 'no new baseline: state carried over');
    await until(
      () => replies(local).some((m) => /while migrating/.test(m.content)),
      'the payment made during the migration is announced',
      15000,
    );
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(
      replies(local).filter((m) => /while migrating/.test(m.content)).length,
      1,
      'exactly once',
    );
    assert.equal(
      replies(local).filter((m) => /^Balance/.test(m.content)).length,
      1,
      'old message not answered',
    );
    say('/balance');
    await until(
      () => replies(local).filter((m) => /^Balance \(Alice\)/.test(m.content)).length === 2,
      'database mode answers',
      10000,
    );
    assert.equal(state().authorized.users[getPublicKey(alice)], linkedAt, 'link time kept');

    // Revoked from the CLI while it runs: effective within seconds, no restart.
    const id = /^([a-f0-9]{32})  active/m.exec(admin(secrets, 'connections', 'list'))[1];
    admin(secrets, 'connections', 'revoke', id);
    await until(() => !state().authorized.users[getPublicKey(alice)], 'revocation noticed', 6000);
    const shown = replies(local).length;
    say('/balance');
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(replies(local).length, shown, 'no longer answered');
    assert.match(db.output(), /Ignored a message/);
    await db.stop();

    // Rollback: wallets.json without the revoked wallet.
    admin(secrets, 'rollback', `${dir}/rolled-back.json`);
    assert.deepEqual(JSON.parse(readFileSync(`${dir}/rolled-back.json`, 'utf8')), {});
    const again = start(t, dir, { ...common, WALLETS_FILE: `${dir}/rolled-back.json` });
    await until(() => /0 linked wallet/.test(again.output()), 'M6 mode again', 10000);
    await again.stop();

    const output = m6.output() + db.output() + again.output();
    assert.ok(!output.includes(ALICE_KEY), 'no key in any output');
    assert.ok(!output.includes('[no-network]'));
  },
);
