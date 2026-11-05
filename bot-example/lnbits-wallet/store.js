// The connection database: who is linked to which wallet, with credentials encrypted by the
// keyring. One writer at a time through SQLite's own locking; every change is one transaction.
//
// Revoked rows keep their metadata and lose their credential, so a disconnected wallet's ref
// is never reused. That does not erase older copies of the ciphertext (WAL frames, freed
// pages, backups); see "What a disconnect does" in the README.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { ConfigurationError } from './vendor/runtime.js';

export const DB_FILE = 'connections.db';
const SCHEMA = [
  // v1
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE connections (
     id          TEXT PRIMARY KEY CHECK (length(id) = 32),
     owner       TEXT NOT NULL CHECK (length(owner) = 64),
     kind        TEXT NOT NULL CHECK (kind IN ('lnbits', 'nwc')),
     source      TEXT NOT NULL CHECK (source IN ('operator', 'self')),
     label       TEXT NOT NULL CHECK (length(label) <= 64),
     origin      TEXT NOT NULL,
     ref         TEXT NOT NULL UNIQUE CHECK (length(ref) = 32),
     fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
     status      TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
     kid         TEXT,
     nonce       BLOB,
     secret      BLOB,
     created_at  INTEGER NOT NULL,
     revoked_at  INTEGER,
     revoked_by  TEXT CHECK (revoked_by IN ('operator', 'user', 'system')),
     CHECK ((status = 'active') = (kid IS NOT NULL AND nonce IS NOT NULL AND secret IS NOT NULL))
   ) STRICT;
   CREATE UNIQUE INDEX one_active_wallet ON connections(fingerprint) WHERE status = 'active';
   CREATE INDEX by_owner ON connections(owner, status);
   CREATE TABLE owners (
     pubkey       TEXT PRIMARY KEY CHECK (length(pubkey) = 64),
     linked_since INTEGER NOT NULL,
     active       TEXT REFERENCES connections(id),
     updated_at   INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE audit (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     at         INTEGER NOT NULL,
     owner      TEXT NOT NULL,
     connection TEXT,
     action     TEXT NOT NULL CHECK (action IN
       ('connect','revoke','select','migrate','restore','rotate','rollback','recover')),
     actor      TEXT NOT NULL CHECK (actor IN ('operator','user','system')),
     detail     TEXT CHECK (length(detail) <= 200)
   ) STRICT;`,
];

const seconds = () => Math.floor(Date.now() / 1000);
export const newId = () => randomBytes(16).toString('hex');

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function checkFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new ConfigurationError(`${DB_FILE} must be a regular file.`);
  if (stat.mode & 0o077) throw new ConfigurationError(`${DB_FILE} must be private: chmod 600.`);
}

export class Store {
  // schema: the upgrade steps this code knows. backup(version): called before an upgrade.
  constructor(file, { schema = SCHEMA, backup } = {}) {
    checkFile(file);
    this.file = file;
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;
        PRAGMA secure_delete = ON;`);
      const version = this.version;
      if (version > schema.length)
        throw new ConfigurationError(
          `${DB_FILE} is schema v${version}; this code knows v${schema.length}. Use a matching release or restore a backup.`,
        );
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
        throw new StoreError('damaged', `${DB_FILE} failed its integrity check. Restore a backup.`);
      for (let v = version; v < schema.length; v++) {
        if (v > 0) backup?.(v, this);
        this.transaction(() => {
          this.db.exec(schema[v]);
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
        });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  // A new database file, private from its first byte. Never replaces one.
  static create(file, { storeId, ...options } = {}) {
    if (existsSync(file)) throw new StoreError('exists', `${DB_FILE} already exists.`);
    closeSync(openSync(file, 'wx', 0o600));
    chmodSync(file, 0o600);
    const store = new Store(file, options);
    store.setMeta('store_id', storeId ?? newId());
    store.setMeta('created_at', String(seconds()));
    return store;
  }
  close() {
    this.db.close();
  }
  get version() {
    return this.db.prepare('PRAGMA user_version').get().user_version;
  }
  // Changes when another connection (the operator's CLI) has committed something.
  get dataVersion() {
    return this.db.prepare('PRAGMA data_version').get().data_version;
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  // A consistent copy, safe while the bot runs. Rebuilt, so it has no freed pages either.
  backupTo(file) {
    if (existsSync(file)) throw new StoreError('exists', 'The backup file already exists.');
    this.db.prepare('VACUUM INTO ?').run(file);
    chmodSync(file, 0o600);
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  }
  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // ---- Reading ---------------------------------------------------------------------------

  all() {
    return this.db.prepare('SELECT * FROM connections ORDER BY created_at, rowid').all();
  }
  active() {
    return this.db
      .prepare(`SELECT * FROM connections WHERE status = 'active' ORDER BY created_at, rowid`)
      .all();
  }
  connection(id) {
    return this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  }
  owners() {
    return this.db.prepare('SELECT * FROM owners').all();
  }
  owner(pubkey) {
    return this.db.prepare('SELECT * FROM owners WHERE pubkey = ?').get(pubkey);
  }
  audit() {
    return this.db.prepare('SELECT * FROM audit ORDER BY id').all();
  }
  logAudit({ owner, connection = null, action, actor, detail = null }) {
    this.db
      .prepare(
        'INSERT INTO audit (at, owner, connection, action, actor, detail) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(seconds(), owner, connection, action, actor, detail);
  }

  // ---- Changing --------------------------------------------------------------------------

  // The checks of connect(), for telling someone early. connect() still enforces them.
  checkConnect({ owner, fingerprint, maxPerOwner = Infinity, maxTotal = Infinity }) {
    if (
      this.db
        .prepare(`SELECT 1 FROM connections WHERE fingerprint = ? AND status = 'active'`)
        .get(fingerprint)
    )
      throw new StoreError('duplicate', 'This wallet is already connected.');
    const { n } = this.db
      .prepare(`SELECT count(*) AS n FROM connections WHERE owner = ? AND status = 'active'`)
      .get(owner);
    if (n >= maxPerOwner)
      throw new StoreError('limit', 'This account has reached its connection limit.');
    this.#checkTotal(maxTotal);
  }
  #checkTotal(maxTotal) {
    const { n } = this.db
      .prepare(`SELECT count(*) AS n FROM connections WHERE status = 'active'`)
      .get();
    if (n >= maxTotal) throw new StoreError('full', 'This bot has reached its connection limit.');
  }
  // Adds an active connection, the owner's first or another. Throws StoreError: 'limit' over
  // maxPerOwner, 'duplicate' if this wallet is already active for anyone.
  // since: when the owner was first linked (kept when migrating); a new owner otherwise.
  connect({
    id = newId(),
    ref = newId(),
    owner,
    kind = 'lnbits',
    source = 'self',
    label = '',
    origin,
    fingerprint,
    box,
    since,
    actor = 'user',
    action = 'connect',
    maxPerOwner = Infinity,
    maxTotal = Infinity,
  }) {
    return this.transaction(() => {
      this.#checkTotal(maxTotal);
      const count = this.db
        .prepare(`SELECT count(*) AS n FROM connections WHERE owner = ? AND status = 'active'`)
        .get(owner).n;
      if (count >= maxPerOwner)
        throw new StoreError('limit', 'This account has reached its connection limit.');
      const time = seconds();
      if (!this.owner(owner))
        this.db
          .prepare(
            'INSERT INTO owners (pubkey, linked_since, active, updated_at) VALUES (?, ?, NULL, ?)',
          )
          .run(owner, since ?? time, time);
      try {
        this.db
          .prepare(
            `INSERT INTO connections (id, owner, kind, source, label, origin, ref, fingerprint,
               status, kid, nonce, secret, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          )
          .run(
            id,
            owner,
            kind,
            source,
            label,
            origin,
            ref,
            fingerprint,
            box.kid,
            box.nonce,
            box.secret,
            time,
          );
      } catch (error) {
        if (error.errcode === 2067 || /UNIQUE/.test(error.message))
          throw new StoreError('duplicate', 'This wallet is already connected.');
        throw error;
      }
      // The first wallet is the one commands use until the person chooses another.
      this.db
        .prepare('UPDATE owners SET active = coalesce(active, ?), updated_at = ? WHERE pubkey = ?')
        .run(id, time, owner);
      this.logAudit({ owner, connection: id, action, actor });
      return this.connection(id);
    });
  }
  // Revokes one connection and removes its credential from the live row. Repeating it does
  // nothing. If it was the wallet in use, the owner's oldest other wallet takes over; the
  // owner row goes with their last wallet, so linking again starts a new link time.
  // Returns the revoked row, or undefined if it was not active.
  revoke(id, actor, { at = seconds(), detail = null } = {}) {
    return this.transaction(() => {
      const row = this.connection(id);
      if (row?.status !== 'active') return undefined;
      this.db
        .prepare(`UPDATE owners SET active = NULL WHERE pubkey = ? AND active = ?`)
        .run(row.owner, id);
      this.db
        .prepare(
          `UPDATE connections SET status = 'revoked', revoked_at = ?, revoked_by = ?,
             kid = NULL, nonce = NULL, secret = NULL WHERE id = ?`,
        )
        .run(at, actor, id);
      const next = this.db
        .prepare(
          `SELECT id FROM connections WHERE owner = ? AND status = 'active' ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(row.owner);
      if (!next) this.db.prepare('DELETE FROM owners WHERE pubkey = ?').run(row.owner);
      else
        this.db
          .prepare(
            'UPDATE owners SET active = coalesce(active, ?), updated_at = ? WHERE pubkey = ?',
          )
          .run(next.id, seconds(), row.owner);
      this.logAudit({ owner: row.owner, connection: id, action: 'revoke', actor, detail });
      return row;
    });
  }
  // The wallet the person's new commands use. Only their own, only an active one.
  select(owner, id, actor = 'user') {
    return this.transaction(() => {
      const row = this.connection(id);
      if (row?.status !== 'active' || row.owner !== owner) return false;
      this.db
        .prepare('UPDATE owners SET active = ?, updated_at = ? WHERE pubkey = ?')
        .run(id, seconds(), owner);
      this.logAudit({ owner, connection: id, action: 'select', actor });
      return true;
    });
  }
  // Re-encrypts every active credential in one transaction. encrypt(row) returns its new box.
  rekey(encrypt) {
    return this.transaction(() => {
      const rows = this.active();
      const update = this.db.prepare(
        'UPDATE connections SET kid = ?, nonce = ?, secret = ? WHERE id = ?',
      );
      for (const row of rows) {
        const box = encrypt(row);
        update.run(box.kid, box.nonce, box.secret, row.id);
      }
      return rows.length;
    });
  }
}

export { SCHEMA };
