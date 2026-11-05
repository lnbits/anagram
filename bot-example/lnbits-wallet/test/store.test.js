// The connection database: file checks, constraints, transactions, versions.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { newId, SCHEMA, Store } from '../store.js';
import { ConfigurationError } from '../vendor/runtime.js';
import { tempDir } from './helpers.js';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const box = () => ({ kid: 'k1', nonce: Buffer.alloc(12, 1), secret: Buffer.from('cipher-text') });
const wallet = (owner = ALICE, extra = {}) => ({
  owner,
  origin: 'https://l.example/',
  fingerprint: newId() + newId(),
  box: box(),
  ...extra,
});
const file = (t) => join(tempDir(t, 'store'), 'connections.db');
const open = (t, options) => {
  const store = Store.create(file(t), options);
  t.after(() => store.close());
  return store;
};

test('a new database is private, versioned and refuses to be created twice', (t) => {
  const store = open(t);
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(store.version, SCHEMA.length);
  assert.equal(store.getMeta('store_id').length, 32);
  assert.ok(store.getMeta('created_at'));
  assert.throws(() => Store.create(store.file), /already exists/);
  const strict = store.db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'`)
    .all();
  assert.ok(
    strict.filter((r) => !r.sql.includes('sqlite_sequence')).every((r) => /STRICT\s*$/.test(r.sql)),
  );
});

test('opening refuses loose modes, non-files and a newer schema', (t) => {
  const path = file(t);
  Store.create(path).close();
  chmodSync(path, 0o644);
  assert.throws(() => new Store(path), ConfigurationError);
  chmodSync(path, 0o600);
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${SCHEMA.length + 1}`);
  raw.close();
  assert.throws(() => new Store(path), /this code knows/);
});

test('a damaged database stops startup', (t) => {
  const path = file(t);
  const store = Store.create(path);
  store.connect(wallet());
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.close();
  const data = readFileSync(path);
  data.fill(0x41, 4096, 8192);
  writeFileSync(path, data);
  assert.throws(() => {
    const again = new Store(path);
    again.all();
    again.close();
  });
});

test('upgrades run in order, each after a backup, and a failure changes nothing', (t) => {
  const path = file(t);
  Store.create(path).close();
  const backups = [];
  const one = new Store(path, {
    schema: [...SCHEMA, 'CREATE TABLE extra (x INTEGER) STRICT;'],
    backup: (version) => backups.push(version),
  });
  assert.equal(one.version, SCHEMA.length + 1);
  assert.deepEqual(backups, [SCHEMA.length]);
  one.close();
  assert.throws(
    () =>
      new Store(path, {
        schema: [
          ...SCHEMA,
          'CREATE TABLE extra (x INTEGER) STRICT;',
          'CREATE TABLE half (x INTEGER) STRICT; CREATE TABLE half (y INTEGER) STRICT;',
        ],
      }),
    /already exists/,
  );
  const two = new Store(path, { schema: [...SCHEMA, 'CREATE TABLE extra (x INTEGER) STRICT;'] });
  assert.equal(two.version, SCHEMA.length + 1);
  assert.equal(
    two.db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'`).get().n,
    0,
  );
  two.close();
});

test('the schema makes inconsistent rows impossible', (t) => {
  const store = open(t);
  const row = store.connect(wallet());
  for (const sql of [
    `UPDATE connections SET secret = NULL WHERE id = '${row.id}'`,
    `UPDATE connections SET status = 'revoked' WHERE id = '${row.id}'`,
    `UPDATE connections SET kind = 'other' WHERE id = '${row.id}'`,
    `UPDATE connections SET ref = 'short' WHERE id = '${row.id}'`,
    `UPDATE owners SET active = 'nope' WHERE pubkey = '${ALICE}'`,
  ])
    assert.throws(() => store.db.exec(sql), /constraint/i, sql);
});

test('one active wallet per fingerprint; a limit per person; both in one transaction', (t) => {
  const store = open(t);
  const shared = wallet();
  store.connect(shared);
  assert.throws(
    () => store.connect({ ...wallet(BOB), fingerprint: shared.fingerprint }),
    (error) => error.code === 'duplicate',
  );
  assert.equal(store.owner(BOB), undefined, 'the failed attempt left no owner behind');
  store.connect(wallet(ALICE, { maxPerOwner: 2 }));
  assert.throws(
    () => store.connect(wallet(ALICE, { maxPerOwner: 2 })),
    (error) => error.code === 'limit',
  );
  assert.equal(store.active().length, 2);
});

test('the first wallet is in use; selecting works only on your own active wallet', (t) => {
  const store = open(t);
  const first = store.connect(wallet());
  const second = store.connect(wallet());
  const theirs = store.connect(wallet(BOB));
  assert.equal(store.owner(ALICE).active, first.id);
  assert.equal(store.select(ALICE, second.id), true);
  assert.equal(store.owner(ALICE).active, second.id);
  assert.equal(store.select(ALICE, theirs.id), false, "someone else's");
  assert.equal(store.select(ALICE, newId()), false, 'unknown');
  store.revoke(first.id, 'user');
  assert.equal(store.select(ALICE, first.id), false, 'revoked');
  assert.equal(store.owner(ALICE).active, second.id);
});

test('revoking removes the credential, is idempotent and moves to the next wallet', (t) => {
  const store = open(t);
  const first = store.connect(wallet());
  const second = store.connect(wallet());
  assert.equal(store.revoke(first.id, 'user').id, first.id);
  const row = store.connection(first.id);
  assert.equal(row.status, 'revoked');
  assert.equal(row.revoked_by, 'user');
  assert.equal(row.secret, null);
  assert.equal(row.nonce, null);
  assert.equal(row.kid, null);
  assert.equal(store.revoke(first.id, 'operator'), undefined, 'a second revoke does nothing');
  assert.equal(store.connection(first.id).revoked_by, 'user');
  assert.equal(store.owner(ALICE).active, second.id);

  const since = store.owner(ALICE).linked_since;
  store.revoke(second.id, 'user');
  assert.equal(store.owner(ALICE), undefined, 'the owner goes with their last wallet');
  store.connect(wallet(ALICE, { since: since + 100 }));
  assert.equal(store.owner(ALICE).linked_since, since + 100, 'linking again starts a new time');
});

test('reconnecting the same wallet makes a new row with a new ref', (t) => {
  const store = open(t);
  const first = wallet();
  const old = store.connect(first);
  store.revoke(old.id, 'user');
  const again = store.connect({ ...first, box: box() });
  assert.notEqual(again.id, old.id);
  assert.notEqual(again.ref, old.ref);
  assert.equal(store.connection(old.id).status, 'revoked');
});

test('the audit log records actions and never a credential', (t) => {
  const store = open(t);
  const one = store.connect(wallet());
  const two = store.connect(wallet());
  store.select(ALICE, two.id);
  store.revoke(one.id, 'operator', { detail: 'asked' });
  assert.deepEqual(
    store.audit().map((a) => [a.action, a.actor]),
    [
      ['connect', 'user'],
      ['connect', 'user'],
      ['select', 'user'],
      ['revoke', 'operator'],
    ],
  );
  assert.ok(!JSON.stringify(store.audit()).includes('cipher-text'));
});

test('rekey replaces every active ciphertext together or not at all', (t) => {
  const store = open(t);
  store.connect(wallet());
  const gone = store.connect(wallet());
  store.revoke(gone.id, 'user');
  store.connect(wallet());
  const next = { kid: 'k2', nonce: Buffer.alloc(12, 2), secret: Buffer.from('new') };
  let calls = 0;
  assert.throws(() =>
    store.rekey(() => {
      if (++calls === 2) throw new Error('disk full');
      return next;
    }),
  );
  assert.ok(
    store.active().every((r) => r.kid === 'k1'),
    'rolled back',
  );
  assert.equal(
    store.rekey(() => next),
    2,
  );
  assert.ok(store.active().every((r) => r.kid === 'k2'));
  assert.equal(store.connection(gone.id).secret, null, 'revoked rows stay empty');
});

test('another connection commits are visible through dataVersion and a backup is consistent', (t) => {
  const store = open(t);
  const before = store.dataVersion;
  store.connect(wallet());
  assert.equal(store.dataVersion, before, 'own commits do not count');
  const other = new Store(store.file);
  other.connect(wallet(BOB));
  other.close();
  assert.notEqual(store.dataVersion, before);

  const copy = `${store.file}.backup`;
  store.backupTo(copy);
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.throws(() => store.backupTo(copy), /already exists/);
  const restored = new Store(copy);
  assert.equal(restored.active().length, 2);
  restored.close();
  assert.ok(existsSync(copy));
});
