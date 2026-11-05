// Operator tools: migration, rollback, backup, restore, key rotation and recovery.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, nip19 } from 'nostr-tools';
import { run, Tools } from '../admin.js';
import { Keyring } from '../keyring.js';
import { LNbitsError } from '../lnbits.js';
import { plaintextCopies } from '../bot.js';
import { Ledger, ledgerFile } from '../ledger.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { State } from '../vendor/runtime.js';
import { Wallets as FileWallets, walletRef } from '../wallets.js';
import { ALICE_KEY, BOB_KEY, alice, bob, npub, tempDir } from './helpers.js';

const URL_ = 'https://lnbits.test/';
const A = getPublicKey(alice);
const B = getPublicKey(bob);
const ADMIN = fileURLToPath(new URL('../admin.js', import.meta.url));

function fixture(t) {
  const root = tempDir(t, 'admin');
  const dataDir = join(root, 'data');
  const secretsDir = join(root, 'secrets');
  const logs = [];
  // What LNbits says about each key during migrate: an error code, or nothing for a good key.
  const keys = { checked: [], answer: new Map() };
  const tools = new Tools({
    dataDir,
    secretsDir,
    lnbitsUrl: URL_,
    log: (l) => logs.push(l),
    checkKey: async (key) => {
      keys.checked.push(key);
      const code = keys.answer.get(key);
      if (code) throw new LNbitsError(code);
    },
  });
  tools.keyringInit();
  const walletsFile = join(root, 'wallets.json');
  writeFileSync(
    walletsFile,
    JSON.stringify({
      [npub(alice)]: { label: 'Alice', invoiceKey: ALICE_KEY },
      [npub(bob)]: { label: 'Bob', invoiceKey: BOB_KEY },
    }),
    { mode: 0o600 },
  );
  const open = () => {
    const registry = Registry.open({ dataDir, secretsDir });
    t.after(() => {
      try {
        registry.close();
      } catch {
        /* closed by the test */
      }
    });
    return registry;
  };
  return {
    root,
    dataDir,
    secretsDir,
    tools,
    logs,
    keys,
    walletsFile,
    open,
    database: join(dataDir, DB_FILE),
  };
}
const saveState = (dataDir, change) => {
  const state = new State(dataDir);
  change(state.data);
  state.save();
  state.close();
};
const readState = (dataDir) => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
const allOutput = (fx) => [fx.logs.join('\n')].join('\n');

test('migration keeps M6 refs and link times, and encrypts the keys', async (t) => {
  const fx = fixture(t);
  saveState(fx.dataDir, (data) => {
    data.authorized = { users: { [A]: 1000, [B]: 2000 } };
  });
  const before = readFileSync(join(fx.dataDir, 'state.json'), 'utf8');
  assert.equal(await fx.tools.migrate(fx.walletsFile), 2);
  assert.equal(statSync(fx.database).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${fx.database}.tmp`));
  assert.ok(!existsSync(`${fx.database}-wal`), 'the database is complete by itself');
  assert.equal(readFileSync(join(fx.dataDir, 'state.json'), 'utf8'), before, 'state unchanged');

  const raw = readFileSync(fx.database).toString('latin1');
  assert.ok(!raw.includes(ALICE_KEY) && !raw.includes(BOB_KEY), 'no key in the clear');

  const registry = fx.open();
  assert.equal(registry.keyFor(A), ALICE_KEY);
  assert.equal(registry.label(B), 'Bob');
  assert.equal(registry.lease(A).ref, walletRef(A, ALICE_KEY), 'old menus keep working');
  assert.equal(registry.linkedSince(A), 1000);
  assert.equal(registry.linkedSince(B), 2000);
  assert.ok(!allOutput(fx).includes(ALICE_KEY));
  assert.ok(registry.store.getMeta('migrated_from_wallets_json'));
});

test('migration refuses to run twice, and insecure or broken input leaves nothing behind', async (t) => {
  const fx = fixture(t);
  chmodSync(fx.walletsFile, 0o644);
  await assert.rejects(fx.tools.migrate(fx.walletsFile), /must be private/);
  assert.ok(!existsSync(fx.database));
  chmodSync(fx.walletsFile, 0o600);
  await fx.tools.migrate(fx.walletsFile);
  await assert.rejects(fx.tools.migrate(fx.walletsFile), /Already migrated/);
});

test('a migration interrupted before its rename is rebuilt; the bot refuses meanwhile', async (t) => {
  const fx = fixture(t);
  saveState(fx.dataDir, () => {});
  writeFileSync(`${fx.database}.tmp`, 'half a database');
  const bot = spawnSync(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./no-network.js', import.meta.url)),
      fileURLToPath(new URL('../bot.js', import.meta.url)),
    ],
    {
      env: {
        PATH: process.env.PATH,
        DATA_DIR: fx.dataDir,
        LNBITS_URL: URL_,
        RELAYS: 'ws://127.0.0.1:9/',
        SECRETS_DIR: fx.secretsDir,
      },
      encoding: 'utf8',
      timeout: 8000,
    },
  );
  assert.match(bot.stderr, /migration or restore was interrupted/);
  assert.notEqual(bot.status, 0);
  assert.equal(await fx.tools.migrate(fx.walletsFile), 2);
  assert.ok(!existsSync(`${fx.database}.tmp`));
  assert.equal(fx.open().size, 2);
});

test('the bot refuses a database with WALLETS_FILE set, or without SECRETS_DIR', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const start = (extra) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        fileURLToPath(new URL('./no-network.js', import.meta.url)),
        fileURLToPath(new URL('../bot.js', import.meta.url)),
      ],
      {
        env: {
          PATH: process.env.PATH,
          DATA_DIR: fx.dataDir,
          LNBITS_URL: URL_,
          RELAYS: 'ws://127.0.0.1:9/',
          ...extra,
        },
        encoding: 'utf8',
        timeout: 8000,
      },
    );
  assert.match(
    start({ WALLETS_FILE: fx.walletsFile, SECRETS_DIR: fx.secretsDir }).stderr,
    /unset WALLETS_FILE/,
  );
  assert.match(start({}).stderr, /needs SECRETS_DIR/);
});

test('offline tools refuse while the bot holds the lock', async (t) => {
  const fx = fixture(t);
  const running = new State(fx.dataDir);
  try {
    // process.lock holds this process's pid, which is alive, as a running bot's would be.
    for (const work of [
      () => fx.tools.migrate(fx.walletsFile),
      () => fx.tools.rotate(),
      () => fx.tools.retire('k1'),
      () => fx.tools.rollback(join(fx.root, 'out.json')),
      () => fx.tools.restore(fx.root),
      () => fx.tools.recoverLedger(),
    ])
      await assert.rejects(async () => work(), /owns this data directory/);
  } finally {
    running.close();
  }
});

test('re-migrating does not bring back a disconnected wallet unless asked to', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const registry = fx.open();
  const lease = registry.lease(A);
  registry.revoke(lease.id, 'user');
  registry.close();
  const out = join(fx.root, 'out.json');
  fx.tools.rollback(out);
  // The original file still lists Alice: she stays disconnected, and the operator is told.
  assert.equal(await fx.tools.migrate(fx.walletsFile), 1);
  assert.match(fx.logs.join('\n'), /Skipped 1 wallet\(s\)/);
  const without = fx.open();
  assert.equal(without.linked(A), false);
  assert.equal(without.keyFor(B), BOB_KEY);
  without.close();
  // On purpose, it is a new link: the old menus stay dead.
  fx.tools.rollback(join(fx.root, 'out2.json'));
  await fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true });
  const again = fx.open();
  assert.equal(again.keyFor(A), ALICE_KEY);
  assert.notEqual(again.lease(A).ref, walletRef(A, ALICE_KEY));
  assert.equal(again.menuState(A, walletRef(A, ALICE_KEY)), 'stale');
  assert.equal(again.lease(B).ref, walletRef(B, BOB_KEY), 'others keep theirs');
});

test('rollback writes only what is in force, and cleans what M6 could revive', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const registry = fx.open();
  const gone = registry.lease(A);
  const kept = registry.lease(B);
  registry.revoke(gone.id, 'user');
  registry.close();
  saveState(fx.dataDir, (data) => {
    data.cards = {
      c1: { owner: A, ref: gone.ref, at: 1, data: [], views: [] },
      c2: { owner: B, ref: kept.ref, at: 1, data: [], views: [] },
    };
    data.callbacks = {
      x: {
        fingerprint: 'a'.repeat(64),
        expires: 9e9,
        delivery: { event: {}, relays: [] },
        ref: gone.ref,
      },
    };
    data.payments = { [gone.ref]: { owner: A, baselineAt: 1, cursor: 0, known: {} } };
    data.outbox = [
      { event: {}, relays: [], connection: gone.id },
      { event: {}, relays: [], connection: kept.id },
    ];
  });
  const out = join(fx.root, 'out.json');
  assert.equal(fx.tools.rollback(out), 1);

  assert.equal(statSync(out).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(file), [npub(bob)]);
  assert.equal(file[npub(bob)].invoiceKey, BOB_KEY);
  assert.ok(!existsSync(fx.database));
  assert.ok(readdirSync(fx.dataDir).some((n) => n.startsWith(`${DB_FILE}.rolled-back-`)));

  const data = readState(fx.dataDir);
  assert.deepEqual(Object.keys(data.cards), ['c2']);
  assert.deepEqual(data.callbacks, {});
  assert.equal(data.payments[gone.ref], undefined);
  assert.equal(data.outbox.length, 1);
  assert.deepEqual(Object.keys(data.authorized.users), [B]);

  // The M6 code reads this and links only the wallet still in force.
  const m6 = new FileWallets(Object.entries(file));
  assert.equal(m6.keyFor(B), BOB_KEY);
  assert.equal(m6.linked(A), false);
  assert.ok(existsSync(ledgerFile(fx.secretsDir)), 'the ledger stays');
});

test('rollback refuses what M6 cannot express, unless told to disconnect it', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const registry = fx.open();
  registry.maxPerOwner = 5;
  registry.connect({
    owner: A,
    label: 'Extra',
    origin: URL_,
    secret: { invoiceKey: 'c'.repeat(32) },
  });
  registry.connect({
    owner: B,
    label: 'Elsewhere',
    origin: 'https://other.test/',
    secret: { invoiceKey: 'd'.repeat(32) },
  });
  registry.close();
  const out = join(fx.root, 'out.json');
  assert.throws(() => fx.tools.rollback(out), /cannot be expressed/);
  assert.ok(existsSync(fx.database));
  assert.ok(!existsSync(out));
  assert.equal(fx.tools.rollback(out, { revokeUnrepresentable: true }), 2);
  const secrets = Keyring.load(fx.secretsDir);
  assert.equal(Ledger.open(fx.secretsDir, secrets).entries.length, 2);
  assert.equal(JSON.parse(readFileSync(out, 'utf8'))[npub(alice)].invoiceKey, ALICE_KEY);
});

test('a refused rollback disconnects nobody; a damaged backup restores nothing', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const folder = fx.tools.backup(join(fx.root, 'bk'));
  const registry = fx.open();
  registry.maxPerOwner = 5;
  const extra = registry.connect({
    owner: A,
    label: 'X',
    origin: URL_,
    secret: { invoiceKey: 'c'.repeat(32) },
  });
  registry.close();
  const out = join(fx.root, 'out.json');
  writeFileSync(out, 'other', { mode: 0o600 });
  assert.throws(() => fx.tools.rollback(out, { revokeUnrepresentable: true }), /other contents/);
  const after = fx.open();
  assert.ok(after.connection(extra.id), 'nobody was disconnected by a failed rollback');
  after.close();

  writeFileSync(join(folder, 'state.json'), 'not json');
  const before = readFileSync(fx.database);
  assert.throws(() => fx.tools.restore(folder));
  assert.deepEqual(readFileSync(fx.database), before, 'the database was not replaced');
});

test('records written in wallets.json mode work after migrating', async (t) => {
  const fx = fixture(t);
  saveState(fx.dataDir, (data) => {
    data.invoices = [{ connection: A, op: 'x' }];
    data.outbox = [{ event: {}, relays: [], connection: A }];
  });
  await fx.tools.migrate(fx.walletsFile);
  const data = readState(fx.dataDir);
  assert.equal(data.invoices[0].connection, undefined);
  assert.equal(data.outbox[0].connection, undefined);
});

test('rollback can be run again after a crash, and never overwrites another file', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const out = join(fx.root, 'out.json');
  writeFileSync(out, 'something else', { mode: 0o600 });
  assert.throws(() => fx.tools.rollback(out), /other contents/);
  assert.ok(existsSync(fx.database), 'still in database mode');
  rmSync(out);
  assert.equal(fx.tools.rollback(out), 2);
});

test('a backup is consistent and private, and holds no keyring, ledger or clear key', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const registry = fx.open(); // a running bot
  const folder = fx.tools.backup(join(fx.root, 'bk'));
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  const names = readdirSync(folder).sort();
  assert.deepEqual(names, [DB_FILE, 'manifest.json', 'state.json'].sort());
  for (const name of names) assert.equal(statSync(join(folder, name)).mode & 0o777, 0o600);
  const raw = names.map((n) => readFileSync(join(folder, n)).toString('latin1')).join('');
  assert.ok(!raw.includes(ALICE_KEY) && !raw.includes(BOB_KEY));
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.kids, ['k1']);
  assert.equal(manifest.storeId, registry.store.getMeta('store_id'));
  assert.throws(() => fx.tools.backup(folder), /already holds/);
});

test('restoring an old backup keeps everything disconnected since revoked', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const folder = fx.tools.backup(join(fx.root, 'old'));
  const registry = fx.open();
  const gone = registry.lease(A);
  registry.revoke(gone.id, 'user');
  registry.close();

  assert.equal(fx.tools.restore(folder), 1);
  const after = fx.open();
  assert.equal(after.linked(A), false, 'not reactivated');
  assert.equal(after.keyFor(B), BOB_KEY);
  assert.equal(after.store.connection(gone.id).secret, null, 'its credential is gone again');
  assert.equal(after.store.connection(gone.id).status, 'revoked');
  assert.ok(after.store.audit().some((a) => a.action === 'restore'));
});

test('a restore without trustworthy history restores nothing', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const folder = fx.tools.backup(join(fx.root, 'old'));
  const registry = fx.open();
  registry.revoke(registry.lease(A).id, 'user');
  registry.close();
  const stored = readFileSync(fx.database);
  writeFileSync(ledgerFile(fx.secretsDir), 'damaged\n');
  assert.throws(
    () => fx.tools.restore(folder),
    (e) => e.code === 'corrupt',
  );
  rmSync(ledgerFile(fx.secretsDir));
  assert.throws(
    () => fx.tools.restore(folder),
    (e) => e.code === 'missing',
  );
  assert.deepEqual(readFileSync(fx.database), stored, 'nothing changed');
  // The bot refuses too, until the operator chooses to recover.
  assert.throws(
    () => fx.open(),
    (e) => e.code === 'missing',
  );
});

test('recover-ledger disconnects everything: nothing can come back', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const folder = fx.tools.backup(join(fx.root, 'old'));
  writeFileSync(ledgerFile(fx.secretsDir), 'damaged\n');
  assert.equal(fx.tools.recoverLedger(), 2);
  assert.ok(readdirSync(fx.secretsDir).some((n) => n.startsWith('revocations.log.broken-')));
  const registry = fx.open();
  assert.equal(registry.size, 0);
  registry.close();
  assert.throws(() => fx.tools.restore(folder), /another store/, 'an old backup is refused');
  assert.equal(fx.open().size, 0);
});

test('rotation re-encrypts everything; a crash after adding the key loses nothing', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  assert.equal(fx.tools.rotate(), 'k2');
  const registry = fx.open();
  assert.equal(registry.keyFor(A), ALICE_KEY);
  assert.ok(registry.store.active().every((r) => r.kid === 'k2'));
  registry.close();
  // A crash right after the new key went in: rows are still on the older key.
  Keyring.load(fx.secretsDir).addKey();
  const after = fx.open();
  assert.equal(after.keyFor(B), BOB_KEY);
  assert.ok(after.store.active().every((r) => r.kid === 'k2'));
});

test('retire is refused while needed; afterwards a backup from before is unreadable', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const folder = fx.tools.backup(join(fx.root, 'old'));
  const row = new Store(join(folder, DB_FILE)).active()[0];
  // Move the manifest where the tool looks for retained backups.
  fx.tools.backups = join(fx.root);
  fx.tools.rotate();
  assert.throws(() => fx.tools.retire('k1'), /still in use/, 'a retained backup needs it');
  assert.throws(() => fx.tools.retire('k2'), /current key/);
  const before = Keyring.load(fx.secretsDir);
  assert.ok(
    before.decrypt(
      { kid: row.kid, nonce: row.nonce, secret: row.secret },
      `alw-credential-v1|${row.id}|${row.owner}|${row.kind}|${row.origin}`,
    ),
  );

  const leftovers = fx.tools.retire('k1', { afterRetention: true });
  assert.ok(leftovers.length >= 1, 'old keyring copies are listed');
  assert.throws(
    () =>
      Keyring.load(fx.secretsDir).decrypt(
        { kid: row.kid, nonce: row.nonce, secret: row.secret },
        `alw-credential-v1|${row.id}|${row.owner}|${row.kind}|${row.origin}`,
      ),
    (e) => e.code === 'unknown_kid',
    'the old backup is useless without the retired key',
  );
});

test('a lost keyring fails closed and can only be reset by revoking everything', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  rmSync(join(fx.secretsDir, 'keyring.json'));
  assert.throws(
    () => fx.open(),
    (e) => e.code === 'missing',
  );
  assert.equal(fx.tools.resetLostKeyring(), 2);
  const registry = fx.open();
  assert.equal(registry.size, 0);
  assert.equal(registry.store.all().length, 2);
  registry.close();
  assert.throws(() => fx.tools.resetLostKeyring(), /nothing to reset/);
});

test('the CLI revokes while a bot runs, touching only the ledger and the database', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const state = new State(fx.dataDir); // a running bot holds the lock
  const before = readFileSync(join(fx.dataDir, 'state.json'), 'utf8');
  try {
    const registry = fx.open();
    const lease = registry.lease(A);
    const out = spawnSync(process.execPath, [ADMIN, 'connections', 'revoke', lease.id], {
      env: { PATH: process.env.PATH, DATA_DIR: fx.dataDir, SECRETS_DIR: fx.secretsDir },
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Revoked/);
    assert.ok(!out.stdout.includes(ALICE_KEY));
    registry.check();
    assert.equal(lease.valid(), false);
    assert.equal(readFileSync(join(fx.dataDir, 'state.json'), 'utf8'), before);
  } finally {
    state.close();
  }
});

test('commands print ids and counts only, and fail cleanly', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const run = (...args) =>
    spawnSync(process.execPath, [ADMIN, ...args], {
      env: {
        PATH: process.env.PATH,
        DATA_DIR: fx.dataDir,
        SECRETS_DIR: fx.secretsDir,
        LNBITS_URL: URL_,
      },
      encoding: 'utf8',
    });
  const list = run('connections', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(nip19.npubEncode(A)));
  assert.ok(!list.stdout.includes(ALICE_KEY) && !list.stdout.includes(BOB_KEY));
  const keys = run('keyring', 'list');
  assert.match(keys.stdout, /Current: k1/);
  const bad = run('nonsense');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown command/);
  assert.ok(!bad.stderr.includes('    at '), 'no stack trace');
});

test('a refused restore leaves the setup as it was, and the bot can still start', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const backup = fx.tools.backup();
  fx.tools.rotate();
  fx.tools.retire('k1', { afterRetention: true });
  const before = readFileSync(join(fx.dataDir, 'state.json'), 'utf8');
  assert.throws(() => fx.tools.restore(backup), /needs key k1/);
  for (const suffix of ['', '-wal', '-shm'])
    assert.ok(!existsSync(`${fx.database}.tmp${suffix}`), 'nothing temporary left');
  assert.equal(readFileSync(join(fx.dataDir, 'state.json'), 'utf8'), before);
  const registry = fx.open();
  assert.equal(registry.keyFor(A), ALICE_KEY, 'still working');
  registry.close();
});

test('a restored state ignores messages from before the restore, so nothing runs twice', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  saveState(fx.dataDir, (data) => {
    data.startedAt = 1000;
  });
  const backup = fx.tools.backup();
  const before = Math.floor(Date.now() / 1000);
  fx.tools.restore(backup);
  assert.ok(readState(fx.dataDir).startedAt >= before);
});

test('a restore takes the backup, not the current data, and refuses another store', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  saveState(fx.dataDir, (data) => {
    data.marker = 'in the backup';
  });
  const backup = fx.tools.backup();
  saveState(fx.dataDir, (data) => {
    data.marker = 'current';
  });
  fx.tools.restore(backup);
  assert.equal(readState(fx.dataDir).marker, 'in the backup');
  const manifest = join(backup, 'manifest.json');
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...data, storeId: 'c'.repeat(32) }));
  saveState(fx.dataDir, (state) => {
    state.marker = 'current';
  });
  assert.throws(() => fx.tools.restore(backup), /another store/);
  assert.equal(readState(fx.dataDir).marker, 'current');
});

test('a lost host: a backup and an offline keyring restore the identity, all disconnected', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const nsec = readState(fx.dataDir).nsec;
  const backup = fx.tools.backup();
  // The ledger and the data folder's database are gone. The backup and the keyring remain.
  rmSync(ledgerFile(fx.secretsDir));
  rmSync(fx.database);
  for (const suffix of ['-wal', '-shm']) rmSync(fx.database + suffix, { force: true });
  assert.throws(() => fx.tools.recoverLedger(), /--lost-ledger/);
  assert.throws(
    () => fx.tools.restore(backup),
    (error) => error.code === 'missing',
  );
  assert.equal(fx.tools.restore(backup, { lostLedger: true }), 0);
  assert.equal(readState(fx.dataDir).nsec, nsec, 'the same identity');
  const registry = fx.open();
  assert.equal(registry.size, 0, 'nothing comes back unasked');
  registry.close();
  const raw = readFileSync(fx.database).toString('latin1');
  assert.ok(!raw.includes(ALICE_KEY));
  // The operator's own wallets can be linked again, as a new link.
  assert.equal(await fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }), 2);
  const again = fx.open();
  assert.equal(again.keyFor(A), ALICE_KEY);
  assert.notEqual(again.lease(A).ref, walletRef(A, ALICE_KEY), 'old menus stay dead');
  again.close();
});

test('--lost-ledger is refused when a ledger exists, which then decides', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const backup = fx.tools.backup();
  assert.throws(() => fx.tools.restore(backup, { lostLedger: true }), /it decides/);
  assert.ok(!existsSync(`${fx.database}.tmp`));
  const registry = fx.open();
  assert.equal(registry.size, 2, 'nothing was touched');
  registry.close();
});

test('recover-ledger then the documented relink works, with new refs', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  writeFileSync(ledgerFile(fx.secretsDir), 'damaged\n');
  assert.equal(fx.tools.recoverLedger(), 2);
  await assert.rejects(fx.tools.migrate(fx.walletsFile), /Already migrated/);
  assert.equal(await fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }), 2);
  assert.ok(fx.logs.some((line) => /Linked 2 wallet/.test(line)));
  const registry = fx.open();
  assert.equal(registry.keyFor(B), BOB_KEY);
  assert.notEqual(registry.lease(A).ref, walletRef(A, ALICE_KEY));
  registry.close();
  // Run again: already connected, so nothing changes.
  assert.equal(await fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }), 0);
  const again = fx.open();
  assert.equal(again.size, 2);
  again.close();
  assert.ok(!allOutput(fx).includes(ALICE_KEY));
});

test('migration leaves a backup first, and reads every key back', async (t) => {
  const fx = fixture(t);
  saveState(fx.dataDir, (data) => {
    data.marker = 'before';
  });
  await fx.tools.migrate(fx.walletsFile);
  const folder = readdirSync(join(fx.dataDir, 'backups')).find((n) => n.startsWith('pre-migrate'));
  const saved = join(fx.dataDir, 'backups', folder);
  assert.equal(JSON.parse(readFileSync(join(saved, 'state.json'), 'utf8')).marker, 'before');
});

test('migration keeps no plaintext copy of the keys, and leaves wallets.json as it was', async (t) => {
  const fx = fixture(t);
  const original = readFileSync(fx.walletsFile, 'utf8');
  await fx.tools.migrate(fx.walletsFile);
  assert.equal(readFileSync(fx.walletsFile, 'utf8'), original);
  for (const name of readdirSync(join(fx.dataDir, 'backups'))) {
    const folder = join(fx.dataDir, 'backups', name);
    assert.ok(!existsSync(join(folder, 'wallets.json')), name);
    for (const file of readdirSync(folder))
      for (const key of [ALICE_KEY, BOB_KEY])
        assert.ok(!readFileSync(join(folder, file)).includes(key), `${name}/${file}`);
  }
  assert.equal(plaintextCopies(fx.dataDir), 0);
  assert.match(allOutput(fx), /still holds every key in the clear: delete it/);
});

test('copies an earlier release left in the backups are counted, for the startup reminder', (t) => {
  const fx = fixture(t);
  assert.equal(plaintextCopies(fx.dataDir), 0, 'no backups folder at all');
  for (const name of ['pre-migrate-old-1', 'pre-migrate-old-2', 'backup-new']) {
    const folder = join(fx.dataDir, 'backups', name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (name.startsWith('pre-migrate'))
      writeFileSync(join(folder, 'wallets.json'), '{}', { mode: 0o600 });
  }
  assert.equal(plaintextCopies(fx.dataDir), 2);
});

test('an admin key is never stored: it stops the migration before anything is written', async (t) => {
  const fx = fixture(t);
  saveState(fx.dataDir, (data) => {
    data.marker = 'before';
  });
  const state = readFileSync(join(fx.dataDir, 'state.json'), 'utf8');
  fx.keys.answer.set(BOB_KEY, 'admin_key');
  await assert.rejects(fx.tools.migrate(fx.walletsFile), (error) => {
    assert.match(error.message, /Nothing was migrated: LNbits reports an admin key/);
    assert.ok(error.message.includes(npub(bob)), 'names whose entry it is');
    assert.ok(!error.message.includes(BOB_KEY), 'never the key');
    return true;
  });
  assert.deepEqual(
    fx.keys.checked.sort(),
    [ALICE_KEY, BOB_KEY].sort(),
    'every key was asked about',
  );
  assert.ok(!existsSync(fx.database));
  assert.ok(!existsSync(`${fx.database}.tmp`));
  assert.ok(!existsSync(ledgerFile(fx.secretsDir)), 'no ledger either');
  assert.ok(!existsSync(join(fx.dataDir, 'backups')), 'no backup folder');
  assert.equal(readFileSync(join(fx.dataDir, 'state.json'), 'utf8'), state);
  // --unchecked is about keys LNbits could not vouch for: an admin key still stops it.
  await assert.rejects(fx.tools.migrate(fx.walletsFile, { unchecked: true }), /admin key/);
  assert.ok(!existsSync(fx.database));
  // With the invoice key in its place, it goes through.
  fx.keys.answer.delete(BOB_KEY);
  assert.equal(await fx.tools.migrate(fx.walletsFile), 2);
});

test('keys LNbits cannot confirm stop the migration, unless --unchecked says to go on', async (t) => {
  const fx = fixture(t);
  fx.keys.answer.set(ALICE_KEY, 'unavailable');
  await assert.rejects(fx.tools.migrate(fx.walletsFile), (error) => {
    assert.match(
      error.message,
      /Nothing was migrated: LNbits did not confirm 1 key\(s\) \(unavailable\)/,
    );
    assert.match(error.message, /--unchecked/);
    return true;
  });
  assert.ok(!existsSync(fx.database));
  assert.ok(!existsSync(ledgerFile(fx.secretsDir)));
  // As before this check existed: stored, and checked by the bot at every start.
  assert.equal(await fx.tools.migrate(fx.walletsFile, { unchecked: true }), 2);
  assert.match(allOutput(fx), /Migrating 1 key\(s\) LNbits did not confirm \(unavailable\)/);
  const registry = fx.open();
  assert.equal(registry.keyFor(A), ALICE_KEY);
  registry.close();
  assert.ok(!allOutput(fx).includes(ALICE_KEY));
});

test('linking again with --relink-disconnected checks the keys the same way', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const registry = fx.open();
  registry.revoke(registry.lease(A).id, 'user');
  registry.close();
  const before = readFileSync(fx.database);
  fx.keys.answer.set(ALICE_KEY, 'admin_key');
  await assert.rejects(
    fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }),
    /Nothing was migrated: LNbits reports an admin key/,
  );
  assert.ok(readFileSync(fx.database).equals(before), 'the database is unchanged');
  assert.ok(
    !readdirSync(join(fx.dataDir, 'backups')).some((n) => n.startsWith('pre-relink')),
    'nothing was written, not even a backup',
  );
  fx.keys.answer.delete(ALICE_KEY);
  assert.equal(await fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }), 1);
});

test('wallets that will be skipped are not asked about, so a reset old key blocks nobody', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const registry = fx.open();
  registry.revoke(registry.lease(A).id, 'user');
  registry.close();
  fx.tools.rollback(join(fx.root, 'out.json'));
  // Alice's key was reset in LNbits after her disconnect, as the README advises.
  fx.keys.answer.set(ALICE_KEY, 'rejected');
  fx.keys.checked.length = 0;
  assert.equal(await fx.tools.migrate(fx.walletsFile), 1, 'skipped as disconnected');
  assert.deepEqual(fx.keys.checked, [BOB_KEY]);
  // Linking her again on purpose stores her key, so then it is asked about, and refused.
  await assert.rejects(
    fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }),
    /did not confirm 1 key\(s\) \(rejected\)/,
  );
  fx.keys.checked.length = 0;
  fx.keys.answer.delete(ALICE_KEY);
  assert.equal(await fx.tools.migrate(fx.walletsFile, { relinkDisconnected: true }), 1);
  assert.deepEqual(fx.keys.checked, [ALICE_KEY], 'Bob, connected already, was not asked about');
});

test('the tools read LNBITS_TIMEOUT_SECONDS as the bot does', () => {
  assert.throws(
    () => run(['keyring', 'list'], { LNBITS_TIMEOUT_SECONDS: '-5', SECRETS_DIR: '/nonexistent' }),
    /LNBITS_TIMEOUT_SECONDS must be a whole number from 1 to 120/,
  );
});

test('with the bot running, migrate asks LNbits nothing', async (t) => {
  const fx = fixture(t);
  const running = new State(fx.dataDir);
  try {
    await assert.rejects(fx.tools.migrate(fx.walletsFile), /owns this data directory/);
  } finally {
    running.close();
  }
  assert.deepEqual(fx.keys.checked, []);
});

test('a key that does not read back correctly stops the migration before it counts', async (t) => {
  const fx = fixture(t);
  const decrypt = Keyring.prototype.decrypt;
  Keyring.prototype.decrypt = () => ({ invoiceKey: 'f'.repeat(32) });
  t.after(() => {
    Keyring.prototype.decrypt = decrypt;
  });
  await assert.rejects(fx.tools.migrate(fx.walletsFile), /did not read back/);
  assert.ok(!existsSync(fx.database), 'the database never took effect');
});

test('a --lost-ledger restore cut short leaves nothing to mistake for a whole history', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const backup = fx.tools.backup();
  rmSync(ledgerFile(fx.secretsDir));
  rmSync(fx.database);
  for (const suffix of ['-wal', '-shm']) rmSync(fx.database + suffix, { force: true });
  const createWith = Ledger.createWith;
  Ledger.createWith = () => {
    throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => fx.tools.restore(backup, { lostLedger: true }), /no space/);
  } finally {
    Ledger.createWith = createWith;
  }
  assert.ok(!existsSync(ledgerFile(fx.secretsDir)), 'no ledger yet');
  assert.throws(
    () => fx.open(),
    (error) => error.code === 'missing',
    'and so nothing starts',
  );
  // The same command again finishes it.
  assert.equal(fx.tools.restore(backup, { lostLedger: true }), 0);
  const after = fx.open();
  assert.equal(after.size, 0);
  after.close();
});

test('a backup from before a new ledger cannot bring back what only the old ledger knew', async (t) => {
  // A wallet is disconnected after one backup, and a later backup holds that. A new ledger, built
  // from the earlier backup, has never heard of the disconnect in the later one, and vice versa.
  const setup = async (t2) => {
    const fx = fixture(t2);
    await fx.tools.migrate(fx.walletsFile);
    const before = fx.tools.backup();
    const registry = fx.open();
    const gone = registry.lease(A);
    registry.revoke(gone.id, 'user');
    registry.close();
    return { fx, before, gone };
  };
  const stays = (fx, gone) => {
    const registry = fx.open();
    assert.equal(registry.linked(A), false);
    assert.equal(registry.store.connection(gone.id).secret, null);
    registry.close();
  };

  // recover-ledger, then the older backup, with the disconnect only in the lost ledger.
  const first = await setup(t);
  writeFileSync(ledgerFile(first.fx.secretsDir), 'damaged\n');
  first.fx.tools.recoverLedger();
  assert.throws(() => first.fx.tools.restore(first.before), /another store/);
  stays(first.fx, first.gone);

  // --lost-ledger from one backup, then a plain restore of another.
  const second = await setup(t);
  const later = second.fx.tools.backup();
  rmSync(ledgerFile(second.fx.secretsDir));
  second.fx.tools.restore(later, { lostLedger: true });
  assert.throws(() => second.fx.tools.restore(second.before), /another store/);
  stays(second.fx, second.gone);
  // Only --lost-ledger takes it, with everything disconnected.
  rmSync(ledgerFile(second.fx.secretsDir));
  assert.equal(second.fx.tools.restore(second.before, { lostLedger: true }), 0);
  stays(second.fx, second.gone);

  // A backup made after the new ledger works as usual.
  const fresh = second.fx.tools.backup();
  assert.equal(second.fx.tools.restore(fresh), 0);
});

test('a lost keyring also starts a new generation of the store', async (t) => {
  const fx = fixture(t);
  await fx.tools.migrate(fx.walletsFile);
  const backup = fx.tools.backup();
  rmSync(join(fx.secretsDir, 'keyring.json'), { force: true });
  fx.tools.resetLostKeyring();
  assert.throws(() => fx.tools.restore(backup), /another store/);
});
