// Who is linked to which wallet right now, in database mode. It has the interface the bot
// uses for wallets.json (wallets.js), plus connections that can be added and revoked while
// the bot runs.
//
// Wallet work holds a lease instead of a key. lease.valid() is true only while that exact
// connection is still in force, and lease.signal cancels its requests when it is revoked. A
// revocation can only happen between awaits, so checking valid() in the same synchronous step
// as a write means nothing is queued for a wallet that was disconnected in the meantime.
// A reconnected wallet is a new connection with a new ref: old leases and menus stay dead.
//
// Revocation order: ledger, database, memory, then the bot's own cleanup. A crash in between
// is repaired by load(), which always moves toward more revoked.
//
// A ledger that cannot be read or fails its checks while running suspends every wallet: nothing
// is used, and nothing is forgotten, because nothing was revoked. Every check tries again, so a
// passing fault (a permission slip, a full disk) ends by itself. Damage that stays also stops
// the next start.
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools';
import { Keyring, KeyringError, credentialAAD } from './keyring.js';
import { Ledger, LedgerError, reconcile } from './ledger.js';
import { DB_FILE, newId, Store, StoreError } from './store.js';
import { ConfigurationError } from './vendor/runtime.js';

export const DEFAULT_MAX_CONNECTIONS = 5;
const POLL_MS = 2000;
const isBusy = (error) => (error?.errcode & 0xff) === 5; // SQLITE_BUSY

// What identifies a wallet for "one wallet, one person".
const walletIdentity = (kind, secret) =>
  kind === 'nwc'
    ? `${secret.walletPubkey}:${getPublicKey(Buffer.from(secret.clientSecret, 'hex'))}`
    : secret.invoiceKey;

// The encrypted credential and duplicate check for a connection row.
export function seal(keyring, { id, owner, kind, origin, secret }) {
  return {
    fingerprint: keyring.fingerprint(origin, walletIdentity(kind, secret)),
    box: keyring.encrypt(secret, credentialAAD({ id, owner, kind, origin })),
  };
}

export class Registry {
  #secrets = new Map();
  #connections = new Map();
  #refs = new Map();
  #owners = new Map();
  #suspended = new Map();
  constructor({
    store,
    keyring,
    ledger,
    maxPerOwner = DEFAULT_MAX_CONNECTIONS,
    maxTotal = Infinity,
    log = () => {},
    clientFor,
    // People may manage their own wallets from chat (/wallets, /disconnect).
    manageable = true,
    // Why this configuration does not allow a connection, if so: it is switched off, for good
    // while the bot runs, whenever it is loaded.
    disallowed = () => undefined,
  }) {
    this.manageable = manageable;
    this.disallowed = disallowed;
    this.store = store;
    this.keyring = keyring;
    this.ledger = ledger;
    this.maxPerOwner = maxPerOwner;
    this.maxTotal = maxTotal;
    this.log = log;
    this.clientFor = clientFor;
    this.listener = {};
    this.broken = false;
    this.load();
  }
  // Fails closed: a missing keyring, unknown key or untrusted ledger stops startup.
  static open({ dataDir, secretsDir, ...options }) {
    const keyring = Keyring.load(secretsDir, { dataDir });
    const store = new Store(join(dataDir, DB_FILE), {
      backup: (version, opened) =>
        opened.backupTo(join(dataDir, `${DB_FILE}.pre-v${version + 1}-${Date.now()}`)),
    });
    try {
      const ledger = Ledger.open(secretsDir, keyring, { storeId: store.getMeta('store_id') });
      return new Registry({ store, keyring, ledger, ...options });
    } catch (error) {
      store.close();
      throw error;
    }
  }
  close() {
    this.stopWatching();
    this.store.close();
  }
  toJSON() {
    return { wallets: this.size };
  }

  // ---- Reading the database --------------------------------------------------------------

  // Brings the ledger, database and memory in line. Reports what changed to the listener.
  load() {
    this.ledger.refresh();
    const { revoke, record } = reconcile(this.ledger, this.store.all());
    for (const row of record)
      this.ledger.append({
        connection: row.id,
        ref: row.ref,
        actor: row.revoked_by ?? 'system',
        at: row.revoked_at ?? undefined,
      });
    for (const id of revoke) this.store.revoke(id, 'system', { detail: 'in the ledger' });

    const added = [];
    for (const row of this.store.active()) {
      if (this.#connections.has(row.id)) continue;
      const known = this.#read(row);
      if (!known) continue;
      this.#secrets.set(row.id, known);
      const connection = this.#view(row);
      // A switch-off from before a suspension still holds.
      connection.disabled =
        this.disallowed(connection, known) ?? this.#suspended.get(row.id)?.disabled;
      this.#connections.set(row.id, connection);
      this.#refs.set(row.ref, connection);
      added.push(connection);
    }
    // Listeners below see the owners as they are now.
    this.#owners = new Map(
      this.store.owners().map((o) => [o.pubkey, { since: o.linked_since, active: o.active }]),
    );
    const live = new Set(this.store.active().map((row) => row.id));
    for (const connection of [...this.#connections.values()])
      if (!live.has(connection.id)) this.#forget(connection);
    // Revoked while suspended: nothing above saw it go, so the bot's cleanup has not run. It
    // runs before anything can be sent again.
    for (const connection of this.#suspended.values())
      if (!live.has(connection.id)) this.listener.revoked?.(connection);
    this.#suspended.clear();
    if (this.loaded) for (const connection of added) this.listener.added?.(connection);
    this.loaded = true;
    this.unfinished = false;
    this.lastVersion = this.store.dataVersion;
    this.lastLedger = this.ledger.entries.length;
    this.listener.changed?.();
  }
  // An unknown key is almost always the wrong keyring: refusing keeps that recoverable. A
  // known key that fails means this row is damaged or was moved: only that row is revoked.
  #read(row) {
    try {
      return this.keyring.decrypt(
        { kid: row.kid, nonce: row.nonce, secret: row.secret },
        credentialAAD(row),
      );
    } catch (error) {
      if (!(error instanceof KeyringError) || error.code === 'unknown_kid')
        throw new ConfigurationError(
          `A connection needs key ${row.kid}, which is not in the keyring. Check SECRETS_DIR.`,
        );
      this.log(
        `A stored connection could not be decrypted and was revoked (${row.id.slice(0, 8)}).`,
      );
      this.ledger.append({ connection: row.id, ref: row.ref, actor: 'system' });
      this.store.revoke(row.id, 'system', { detail: 'could not be decrypted' });
      return undefined;
    }
  }
  #view(row) {
    return {
      id: row.id,
      owner: row.owner,
      ref: row.ref,
      kind: row.kind,
      source: row.source,
      label: row.label,
      origin: row.origin,
      abort: new AbortController(),
      disabled: undefined,
    };
  }
  // Memory first in the synchronous step: nothing can use the connection after this.
  #forget(connection) {
    this.#connections.delete(connection.id);
    this.#refs.delete(connection.ref);
    this.#secrets.delete(connection.id);
    connection.abort.abort();
    this.listener.revoked?.(connection);
  }

  // The operator's CLI writes to the database while the bot runs; the bot notices here.
  check() {
    try {
      this.ledger.refresh();
      if (this.ledger.storeId !== this.store.getMeta('store_id'))
        throw new LedgerError('corrupt', 'revocations.log belongs to another store.');
      if (
        !this.broken &&
        !this.unfinished &&
        this.store.dataVersion === this.lastVersion &&
        this.ledger.entries.length === this.lastLedger
      )
        return;
      const recovered = this.broken;
      this.load();
      // Only now: until the cleanup of anything revoked meanwhile is done, nothing may go out.
      this.broken = false;
      if (recovered) this.log('revocations.log can be read again: wallets are back in use.');
    } catch (error) {
      if (isBusy(error)) {
        this.unfinished = true;
        return;
      }
      if (!(error instanceof LedgerError)) throw error;
      if (!this.broken) this.log(error.message);
      this.#suspend();
    }
  }
  // Nothing can use a wallet after this, as after a revocation, but no one is told it was one.
  #suspend() {
    this.broken = true;
    for (const connection of [...this.#connections.values()]) {
      this.#connections.delete(connection.id);
      this.#refs.delete(connection.ref);
      this.#secrets.delete(connection.id);
      connection.abort.abort();
      this.#suspended.set(connection.id, connection);
      this.listener.suspended?.(connection);
    }
    this.#owners.clear();
    this.listener.changed?.();
  }
  startWatching(onError = () => {}) {
    this.timer ??= setInterval(() => {
      try {
        this.check();
      } catch (error) {
        onError(error);
      }
    }, POLL_MS);
    this.timer.unref?.();
  }
  stopWatching() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---- The interface the bot uses --------------------------------------------------------

  get size() {
    return this.#connections.size;
  }
  owners() {
    return [...this.#owners.keys()];
  }
  linked(pubkey) {
    return this.#owners.has(pubkey);
  }
  linkedSince(pubkey) {
    return this.#owners.get(pubkey)?.since;
  }
  #active(pubkey) {
    return this.#connections.get(this.#owners.get(pubkey)?.active);
  }
  has(pubkey) {
    const connection = this.#active(pubkey);
    return Boolean(connection && !connection.disabled);
  }
  keyFor(pubkey) {
    return this.has(pubkey) ? this.#secret(this.#active(pubkey)) : undefined;
  }
  label(pubkey) {
    return this.#active(pubkey)?.label ?? '';
  }
  #secret(connection) {
    const secret = this.#secrets.get(connection.id);
    return connection.kind === 'lnbits' ? secret.invoiceKey : secret;
  }
  // Switched off for this run (LNbits reports an admin key). A connection id or a person.
  disable(target, reason) {
    const connection = this.#connections.get(target) ?? this.#active(target);
    if (connection) connection.disabled = reason;
  }
  // Every wallet in force, for notifications and link checks.
  ids() {
    return [...this.#connections.keys()];
  }
  connection(id) {
    return this.#connections.get(id);
  }
  refs() {
    return [...this.#connections.values()].filter((c) => !c.disabled).map((c) => c.ref);
  }
  #lease(connection) {
    return {
      id: connection.id,
      owner: connection.owner,
      ref: connection.ref,
      kind: connection.kind,
      label: connection.label,
      source: connection.source,
      spends: this.#secrets.get(connection.id)?.scope === 'spend',
      key: this.#secret(connection),
      signal: connection.abort.signal,
      client: this.clientFor?.(connection),
      // No longer in force at all (revoked). Switched off is different: the person is told.
      gone: () => this.#connections.get(connection.id) !== connection,
      valid: () => this.#connections.get(connection.id) === connection && !connection.disabled,
    };
  }
  // The person's wallet in use, or (ref) the wallet a menu was made for, if it is theirs.
  lease(pubkey, ref) {
    const connection = ref ? this.#refs.get(ref) : this.#active(pubkey);
    if (!connection || connection.owner !== pubkey || connection.disabled) return undefined;
    return this.#lease(connection);
  }
  leaseById(id) {
    const connection = this.#connections.get(id);
    return connection && !connection.disabled ? this.#lease(connection) : undefined;
  }
  // Why a menu made for ref cannot be used: 'ok', 'off' (switched off) or 'stale' (gone).
  menuState(pubkey, ref) {
    const connection = this.#refs.get(ref);
    if (!connection || connection.owner !== pubkey) return 'stale';
    return connection.disabled ? 'off' : 'ok';
  }
  // A person's wallets, metadata only, oldest first.
  list(pubkey) {
    const active = this.#owners.get(pubkey)?.active;
    return [...this.#connections.values()]
      .filter((c) => c.owner === pubkey)
      .map((c) => ({
        id: c.id,
        ref: c.ref,
        kind: c.kind,
        source: c.source,
        label: c.label,
        origin: c.origin,
        active: c.id === active,
        disabled: c.disabled,
        spends: this.#secrets.get(c.id)?.scope === 'spend',
      }));
  }

  // ---- Changing --------------------------------------------------------------------------

  // Throws StoreError if connect() would refuse this, without changing anything.
  canConnect({ owner, kind, origin, secret }) {
    this.#refuseWhileBroken();
    this.store.checkConnect({
      owner,
      fingerprint: this.keyring.fingerprint(origin, walletIdentity(kind, secret)),
      maxPerOwner: this.maxPerOwner,
      maxTotal: this.maxTotal,
    });
  }
  #refuseWhileBroken() {
    if (this.broken) throw new StoreError('full', 'Wallets are suspended for now.');
  }
  // A new active connection, always with a new random ref (unless migrating an M6 link).
  connect({
    owner,
    kind = 'lnbits',
    source = 'self',
    label = '',
    origin,
    secret,
    actor = 'user',
    ref,
    since,
    id = newId(),
  }) {
    this.#refuseWhileBroken();
    const { fingerprint, box } = seal(this.keyring, { id, owner, kind, origin, secret });
    const row = this.store.connect({
      id,
      ...(ref ? { ref } : {}),
      owner,
      kind,
      source,
      label,
      origin,
      fingerprint,
      box,
      since,
      actor,
      maxPerOwner: this.maxPerOwner,
      maxTotal: this.maxTotal,
    });
    this.#secrets.set(row.id, secret);
    const connection = this.#view(row);
    connection.disabled = this.disallowed(connection, secret);
    this.#connections.set(row.id, connection);
    this.#refs.set(row.ref, connection);
    const saved = this.store.owner(owner);
    this.#owners.set(owner, { since: saved.linked_since, active: saved.active });
    this.listener.added?.(connection);
    this.listener.changed?.();
    return connection;
  }
  // Ledger first; then the database; then memory and the bot's cleanup, in one synchronous
  // step. If the database is busy the ledger still holds it, the next check() finishes the job,
  // and the wallet is out of use either way. Returns the connection, or undefined if not in
  // force.
  revoke(id, actor) {
    const connection = this.#connections.get(id);
    if (!connection) return undefined;
    this.ledger.append({ connection: id, ref: connection.ref, actor });
    try {
      this.store.revoke(id, actor);
    } catch (error) {
      this.unfinished = true;
      this.log(`A revocation will be finished at the next check (${error.code ?? 'busy'}).`);
    }
    const saved = this.store.owner(connection.owner);
    if (saved)
      this.#owners.set(connection.owner, { since: saved.linked_since, active: saved.active });
    else this.#owners.delete(connection.owner);
    this.#forget(connection);
    this.lastLedger = this.ledger.entries.length;
    this.listener.changed?.();
    return connection;
  }
  // Only the person's own active wallet can be selected.
  select(pubkey, id) {
    if (!this.store.select(pubkey, id)) return false;
    this.#owners.get(pubkey).active = id;
    return true;
  }
}
