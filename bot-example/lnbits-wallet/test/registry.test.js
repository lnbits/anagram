// The runtime registry: leases, revocation order, reload from outside, fail-closed behaviour.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keyring } from '../keyring.js';
import { Ledger, ledgerFile } from '../ledger.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { tempDir } from './helpers.js';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const ORIGIN = 'https://l.example/';
const KEY1 = '11'.repeat(16);
const KEY2 = '22'.repeat(16);

function fixture(t, options = {}) {
  const root = tempDir(t, 'registry');
  const secretsDir = join(root, 'secrets');
  const keyring = Keyring.init(secretsDir);
  const store = Store.create(join(root, DB_FILE));
  Ledger.create(secretsDir, keyring, store.getMeta('store_id'));
  const logs = [];
  const open = (extra = {}) => {
    const again = new Store(store.file);
    const ledger = Ledger.open(secretsDir, keyring);
    const registry = new Registry({
      store: again,
      keyring,
      ledger,
      log: (line) => logs.push(line),
      ...options,
      ...extra,
    });
    t.after(() => registry.stopWatching());
    return registry;
  };
  return { root, secretsDir, keyring, store, logs, open };
}
const add = (registry, owner = ALICE, invoiceKey = KEY1, extra = {}) =>
  registry.connect({ owner, label: 'Wallet', origin: ORIGIN, secret: { invoiceKey }, ...extra });

test('the interface answers for the wallet in use, and only for its owner', (t) => {
  const registry = fixture(t).open();
  assert.equal(registry.size, 0);
  assert.equal(registry.linked(ALICE), false);
  assert.equal(registry.lease(ALICE), undefined);
  const first = add(registry);
  const second = add(registry, ALICE, KEY2, { label: 'Second' });
  assert.equal(registry.linked(ALICE), true);
  assert.equal(registry.keyFor(ALICE), KEY1);
  assert.equal(registry.label(ALICE), 'Wallet');
  assert.equal(registry.lease(ALICE).id, first.id);
  assert.equal(registry.lease(ALICE, second.ref).key, KEY2, 'a menu keeps its own wallet');
  assert.equal(registry.lease(BOB), undefined);
  assert.equal(registry.lease(BOB, first.ref), undefined, "someone else's ref");
  assert.equal(registry.menuState(BOB, first.ref), 'stale');
  assert.equal(registry.menuState(ALICE, first.ref), 'ok');
  assert.deepEqual(registry.list(BOB), []);
  assert.deepEqual(
    registry.list(ALICE).map((c) => [c.label, c.active]),
    [
      ['Wallet', true],
      ['Second', false],
    ],
  );
  assert.ok(!JSON.stringify(registry.list(ALICE)).includes(KEY1), 'no key in the list');
  assert.ok(!JSON.stringify(registry).includes(KEY1));
});

test('credentials are encrypted on disk and come back after reopening', (t) => {
  const { store, open } = fixture(t);
  const registry = open();
  add(registry);
  const row = store.active()[0];
  assert.ok(!Buffer.from(row.secret).toString('latin1').includes(KEY1));
  assert.equal(open().keyFor(ALICE), KEY1);
});

test('selecting changes new commands, not leases already taken', (t) => {
  const registry = fixture(t).open();
  const first = add(registry);
  const second = add(registry, ALICE, KEY2);
  const lease = registry.lease(ALICE);
  assert.equal(registry.select(ALICE, second.id), true);
  assert.equal(lease.key, KEY1);
  assert.equal(lease.valid(), true, 'the wallet is still connected');
  assert.equal(registry.lease(ALICE).id, second.id);
  assert.equal(registry.select(BOB, first.id), false);
  assert.equal(registry.select(ALICE, 'f'.repeat(32)), false);
});

test('revoking ends the lease at once, cancels its requests and reports once', (t) => {
  const { store, secretsDir, keyring, open } = fixture(t);
  const registry = open();
  const seen = [];
  registry.listener.revoked = (connection) => seen.push(connection.id);
  const wallet = add(registry);
  const lease = registry.lease(ALICE);
  const aborted = new Promise((resolve) => lease.signal.addEventListener('abort', resolve));

  assert.equal(registry.revoke(wallet.id, 'user').id, wallet.id);
  assert.equal(lease.valid(), false);
  assert.ok(lease.signal.aborted);
  assert.equal(registry.lease(ALICE), undefined);
  assert.equal(registry.linked(ALICE), false);
  assert.equal(registry.keyFor(ALICE), undefined);
  assert.deepEqual(seen, [wallet.id]);
  assert.equal(registry.revoke(wallet.id, 'user'), undefined, 'a second revoke does nothing');
  assert.deepEqual(seen, [wallet.id]);

  assert.equal(store.connection(wallet.id).secret, null);
  assert.ok(Ledger.open(secretsDir, keyring).connections.has(wallet.id));
  return aborted;
});

test('a reconnected wallet is a new connection: old leases and menus stay dead', (t) => {
  const registry = fixture(t).open();
  const old = add(registry);
  const lease = registry.lease(ALICE);
  registry.revoke(old.id, 'user');
  const again = add(registry);
  assert.notEqual(again.ref, old.ref);
  assert.equal(lease.valid(), false);
  assert.equal(registry.menuState(ALICE, old.ref), 'stale');
  assert.equal(registry.lease(ALICE, old.ref), undefined);
  assert.equal(registry.lease(ALICE).key, KEY1);
});

test('limits and duplicates are refused and change nothing', (t) => {
  const registry = fixture(t, { maxPerOwner: 1 }).open();
  add(registry);
  assert.throws(
    () => add(registry, ALICE, KEY2),
    (e) => e.code === 'limit',
  );
  assert.throws(
    () => add(registry, BOB, KEY1),
    (e) => e.code === 'duplicate',
  );
  assert.equal(registry.size, 1);
  assert.equal(registry.linked(BOB), false);
});

test('a revocation by the operator CLI is picked up without a restart', (t) => {
  const { secretsDir, keyring, store, open } = fixture(t);
  const registry = open();
  const seen = [];
  registry.listener.revoked = (connection) => seen.push(connection.id);
  const wallet = add(registry);
  const lease = registry.lease(ALICE);
  registry.check();
  assert.equal(lease.valid(), true, 'nothing changed');

  const cli = Ledger.open(secretsDir, keyring);
  cli.append({ connection: wallet.id, ref: wallet.ref, actor: 'operator' });
  new Store(store.file).revoke(wallet.id, 'operator');

  registry.check();
  assert.equal(lease.valid(), false);
  assert.equal(registry.linked(ALICE), false);
  assert.deepEqual(seen, [wallet.id]);
});

test('a connection added from outside appears; its owner gets a link time', (t) => {
  const { open } = fixture(t);
  const registry = open();
  const seen = [];
  registry.listener.added = (connection) => seen.push(connection.owner);
  const other = open();
  add(other, BOB, KEY2);
  registry.check();
  assert.deepEqual(seen, [BOB]);
  assert.equal(registry.keyFor(BOB), KEY2);
  assert.ok(registry.linkedSince(BOB) > 0);
});

test('crash repairs: the ledger ahead revokes; the database ahead is recorded', (t) => {
  const { secretsDir, keyring, store, open } = fixture(t);
  const first = open();
  const a = add(first);
  const b = add(first, BOB, KEY2);

  // Crash after the ledger line, before the database commit.
  Ledger.open(secretsDir, keyring).append({ connection: a.id, ref: a.ref, actor: 'user' });
  // A database revoke whose ledger line never landed.
  store.revoke(b.id, 'operator');

  const second = open();
  assert.equal(second.linked(ALICE), false);
  assert.equal(store.connection(a.id).status, 'revoked');
  assert.equal(store.connection(a.id).secret, null);
  assert.ok(Ledger.open(secretsDir, keyring).connections.has(b.id));
});

test('a broken ledger at startup fails closed; while running it stops every wallet', (t) => {
  const { secretsDir, open, logs } = fixture(t);
  const registry = open();
  const lease = (add(registry), registry.lease(ALICE));
  writeFileSync(ledgerFile(secretsDir), 'tampered\n');

  registry.check();
  assert.equal(lease.valid(), false, 'no wallet stays in use');
  assert.equal(registry.linked(ALICE), false);
  assert.match(logs.join('\n'), /cannot be trusted/);
  assert.throws(
    () => open(),
    (error) => error.code === 'corrupt',
    'startup refuses',
  );
  rmSync(ledgerFile(secretsDir));
  assert.throws(
    () => open(),
    (error) => error.code === 'missing',
  );
});

test('an unknown key refuses startup; a damaged row is revoked alone', (t) => {
  const { store, keyring, secretsDir, open, logs } = fixture(t);
  const registry = open();
  const good = add(registry, ALICE, KEY1);
  const bad = add(registry, BOB, KEY2);
  store.db
    .prepare(`UPDATE connections SET secret = ? WHERE id = ?`)
    .run(Buffer.alloc(40, 7), bad.id);
  const next = open();
  assert.equal(next.keyFor(ALICE), KEY1);
  assert.equal(next.linked(BOB), false);
  assert.equal(store.connection(bad.id).status, 'revoked');
  assert.ok(Ledger.open(secretsDir, keyring).connections.has(bad.id));
  assert.match(logs.join('\n'), /could not be decrypted/);

  store.db.prepare(`UPDATE connections SET kid = 'k9' WHERE id = ?`).run(good.id);
  assert.throws(() => open(), /not in the keyring/);
});

test('disabling switches off one wallet for this run', (t) => {
  const registry = fixture(t).open();
  const wallet = add(registry);
  const lease = registry.lease(ALICE);
  registry.disable(ALICE, 'admin key');
  assert.equal(registry.has(ALICE), false);
  assert.equal(registry.linked(ALICE), true);
  assert.equal(registry.keyFor(ALICE), undefined);
  assert.equal(lease.valid(), false);
  assert.equal(lease.gone(), false, 'switched off, not disconnected');
  assert.equal(registry.menuState(ALICE, wallet.ref), 'off');
  assert.deepEqual(registry.refs(), []);
});

test('a ledger that cannot be read suspends wallets, and they come back as they were', (t) => {
  const { open, secretsDir } = fixture(t);
  const registry = open();
  const connection = add(registry);
  const events = { revoked: 0, suspended: 0, added: 0 };
  registry.listener = {
    revoked: () => events.revoked++,
    suspended: () => events.suspended++,
    added: () => events.added++,
  };
  const old = registry.lease(ALICE);
  chmodSync(ledgerFile(secretsDir), 0o644);
  registry.check();
  assert.equal(registry.broken, true);
  assert.equal(old.gone(), true, 'nothing can use it now');
  assert.ok(old.signal.aborted);
  assert.equal(registry.linked(ALICE), false);
  assert.equal(registry.menuState(ALICE, connection.ref), 'stale');
  assert.deepEqual(events, { revoked: 0, suspended: 1, added: 0 }, 'not treated as a revocation');
  assert.throws(
    () => add(registry, BOB, KEY2),
    (error) => error.code === 'full',
    'nothing new while the history is unknown',
  );
  chmodSync(ledgerFile(secretsDir), 0o600);
  registry.check();
  assert.equal(registry.broken, false);
  assert.equal(registry.linked(ALICE), true);
  assert.equal(registry.lease(ALICE).ref, connection.ref, 'the same connection, menus and all');
  assert.equal(registry.menuState(ALICE, connection.ref), 'ok');
  assert.equal(events.added, 1);
  assert.equal(old.gone(), true, 'a lease from before stays dead');
});

test('a wallet revoked while the ledger could not be read stays revoked', (t) => {
  const { open, secretsDir, keyring, store } = fixture(t);
  const registry = open();
  const connection = add(registry);
  chmodSync(ledgerFile(secretsDir), 0o644);
  registry.check();
  chmodSync(ledgerFile(secretsDir), 0o600);
  Ledger.open(secretsDir, keyring).append({
    connection: connection.id,
    ref: connection.ref,
    actor: 'operator',
  });
  registry.check();
  assert.equal(registry.linked(ALICE), false);
  assert.equal(store.connection(connection.id).status, 'revoked');
  assert.equal(store.connection(connection.id).secret, null);
});

test('a ledger of another store is not trusted while running', (t) => {
  const { open, secretsDir, keyring } = fixture(t);
  const registry = open();
  add(registry);
  rmSync(ledgerFile(secretsDir));
  Ledger.create(secretsDir, keyring, 'c'.repeat(32));
  registry.check();
  assert.equal(registry.broken, true);
  assert.equal(registry.linked(ALICE), false);
});

test('a revocation the busy database refused is finished by the next check', (t) => {
  const { open, store } = fixture(t);
  const registry = open();
  const connection = add(registry);
  const other = new DatabaseSync(store.file);
  other.exec('BEGIN IMMEDIATE');
  registry.store.db.exec('PRAGMA busy_timeout = 20');
  registry.revoke(connection.id, 'user');
  assert.equal(registry.lease(ALICE), undefined, 'out of use at once');
  assert.equal(registry.connection(connection.id), undefined);
  // Still busy: the check neither throws nor gives up.
  registry.check();
  assert.equal(store.connection(connection.id).status, 'active');
  other.exec('ROLLBACK');
  other.close();
  registry.check();
  const row = store.connection(connection.id);
  assert.equal(row.status, 'revoked');
  assert.equal(row.secret, null);
  assert.equal(registry.linked(ALICE), false);
});
