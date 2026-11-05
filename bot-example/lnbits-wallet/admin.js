// Operator tools for database mode. Every tool but "backup" and "connections revoke" needs the
// bot stopped: it takes the same data-folder lock, so state.json only ever has one writer.
// Each has a single commit point (a rename or a transaction) and can be run again after a
// crash. Output is counts and ids only, never a key.
//
//   npm run keyring -- init | list | rotate | retire <kid> [--after-retention]
//   npm run migrate -- <wallets.json> [--relink-disconnected]
//   npm run rollback -- <new wallets.json> [--revoke-unrepresentable]
//   npm run backup [-- <folder>]
//   npm run restore -- <backup folder> [--lost-ledger]
//   npm run connections -- init | list | revoke <id> | recover-ledger | reset-lost-keyring
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nip19 } from 'nostr-tools';
import { lnbitsURL } from './config.js';
import { Keyring, KeyringError, credentialAAD, writeAtomic } from './keyring.js';
import { Ledger, LedgerError, ledgerFile } from './ledger.js';
import { Registry, seal } from './registry.js';
import { DB_FILE, newId, Store, StoreError } from './store.js';
import { ConfigurationError, State } from './vendor/runtime.js';
import { loadWallets, walletRef } from './wallets.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const DAY = 86400;

const fsyncFolder = (path) => {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
// The commit point of a tool.
function commit(from, to) {
  renameSync(from, to);
  fsyncFolder(dirname(to));
}
// SQLite's own files go with the database, if a crash left any.
function renameDatabase(from, to) {
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
  commit(from, to);
}

export class Tools {
  constructor({
    dataDir,
    secretsDir,
    lnbitsUrl,
    allowHttp = false,
    retentionDays = 30,
    log = console.log,
    nsec = '',
  }) {
    this.dataDir = dataDir;
    this.secretsDir = secretsDir;
    this.lnbitsUrl = lnbitsUrl;
    this.allowHttp = allowHttp;
    this.retentionDays = retentionDays;
    this.log = log;
    this.nsec = nsec;
    this.database = join(dataDir, DB_FILE);
    this.temporary = `${this.database}.tmp`;
    this.backups = join(dataDir, 'backups');
  }
  needSecrets() {
    if (!this.secretsDir) throw new ConfigurationError('Set SECRETS_DIR (see the README).');
  }
  // The bot and every offline tool take this lock.
  locked(work) {
    const state = new State(this.dataDir, { nsec: this.nsec });
    try {
      return work(state);
    } finally {
      state.close();
    }
  }
  backupFolder(name) {
    mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    const folder = join(this.backups, `${name}-${stamp()}-${randomBytes(2).toString('hex')}`);
    mkdirSync(folder, { mode: 0o700 });
    return folder;
  }
  copyPrivate(file, folder, name) {
    const target = join(folder, name);
    copyFileSync(file, target);
    chmodSync(target, 0o600);
  }
  manifest(folder, store, extra = {}) {
    writeAtomic(
      join(folder, 'manifest.json'),
      JSON.stringify({
        version: 1,
        at: Math.floor(Date.now() / 1000),
        ...(store
          ? {
              schema: store.version,
              storeId: store.getMeta('store_id'),
              kids: [...new Set(store.active().map((r) => r.kid))],
            }
          : {}),
        ...extra,
      }),
      0o600,
    );
  }

  // ---- Keyring ---------------------------------------------------------------------------

  keyringInit() {
    this.needSecrets();
    const keyring = Keyring.init(this.secretsDir, { dataDir: this.dataDir });
    this.log(`Created a keyring with key ${keyring.current}. Store keyring.json offline now.`);
  }
  keyringList() {
    this.needSecrets();
    const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
    this.log(`Keys: ${keyring.kids().join(', ')}. Current: ${keyring.current}.`);
    return keyring.kids();
  }
  // The new key goes in first and rows follow in one transaction, so a crash loses nothing.
  rotate() {
    this.needSecrets();
    return this.locked(() => {
      const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
      const kid = keyring.addKey();
      let count = 0;
      if (existsSync(this.database)) {
        const store = new Store(this.database);
        try {
          const clear = new Map(
            store.active().map((row) => [row.id, keyring.decrypt(boxOf(row), credentialAAD(row))]),
          );
          count = store.rekey((row) => keyring.encrypt(clear.get(row.id), credentialAAD(row)));
          for (const row of store.active()) keyring.decrypt(boxOf(row), credentialAAD(row));
          store.logAudit({ owner: '-', action: 'rotate', actor: 'operator', detail: kid });
        } finally {
          store.close();
        }
      }
      this.log(
        `Key ${kid} is now current; ${count} credential(s) re-encrypted. Store keyring.json offline now.`,
      );
      return kid;
    });
  }
  // Refused while live rows or backups within the retention period need the key. Once every
  // copy of a key is gone, every older copy of a credential it encrypted is unreadable.
  retire(kid, { afterRetention = false } = {}) {
    this.needSecrets();
    return this.locked(() => {
      const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
      const inUse = new Set();
      if (existsSync(this.database)) {
        const store = new Store(this.database);
        for (const row of store.active()) inUse.add(row.kid);
        store.close();
      }
      if (!afterRetention)
        for (const manifest of this.manifests())
          if (manifest.at > Date.now() / 1000 - this.retentionDays * DAY)
            for (const used of manifest.kids ?? []) inUse.add(used);
      const leftovers = keyring.retire(kid, inUse);
      this.log(`Key ${kid} removed from the keyring.`);
      if (leftovers.length)
        this.log(`Delete these old keyring copies too: ${leftovers.join(', ')}`);
      return leftovers;
    });
  }
  manifests() {
    if (!existsSync(this.backups)) return [];
    return readdirSync(this.backups).flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(this.backups, name, 'manifest.json'), 'utf8'))];
      } catch {
        return [];
      }
    });
  }

  // ---- Migration and rollback ------------------------------------------------------------

  migrate(walletsFile, { relinkDisconnected = false } = {}) {
    this.needSecrets();
    if (!walletsFile) throw new ConfigurationError('Name the wallets.json to migrate.');
    return this.locked((state) => {
      if (existsSync(this.database)) {
        if (relinkDisconnected) return this.#relink(state, walletsFile);
        throw new ConfigurationError('Already migrated: connections.db exists.');
      }
      const origin = lnbitsURL(this.lnbitsUrl, this.allowHttp);
      const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
      const wallets = loadWallets(walletsFile);
      const ledger = existsSync(ledgerFile(this.secretsDir))
        ? Ledger.open(this.secretsDir, keyring)
        : Ledger.create(this.secretsDir, keyring, newId());
      if (existsSync(this.temporary)) rmSync(this.temporary); // an interrupted earlier run
      for (const suffix of ['-wal', '-shm'])
        if (existsSync(this.temporary + suffix)) rmSync(this.temporary + suffix);

      const folder = this.backupFolder('pre-migrate');
      this.copyPrivate(state.file, folder, 'state.json');
      this.copyPrivate(walletsFile, folder, 'wallets.json');
      this.manifest(folder, undefined, { kind: 'pre-migrate' });

      const store = Store.create(this.temporary, { storeId: ledger.storeId });
      let count = 0;
      let skipped = 0;
      try {
        const saved = state.data.authorized?.users ?? {};
        for (const owner of wallets.owners()) {
          const invoiceKey = wallets.keyFor(owner);
          const id = newId();
          const m6 = walletRef(owner, invoiceKey);
          // Disconnected earlier (this file is older than a rollback): it does not come back
          // unless the operator says so, and even then its old menus stay dead. Otherwise M6
          // menus and notification state carry over.
          const disconnected = ledger.refs.has(m6);
          if (disconnected && !relinkDisconnected) {
            skipped++;
            continue;
          }
          const ref = disconnected ? newId() : m6;
          const secret = { invoiceKey };
          store.connect({
            id,
            ref,
            owner,
            kind: 'lnbits',
            source: 'operator',
            label: wallets.label(owner),
            origin,
            ...seal(keyring, { id, owner, kind: 'lnbits', origin, secret }),
            since: Object.hasOwn(saved, owner) ? saved[owner] : undefined,
            actor: 'operator',
            action: 'migrate',
          });
          count++;
        }
        store.setMeta(
          'migrated_from_wallets_json',
          JSON.stringify({
            at: Math.floor(Date.now() / 1000),
            count,
            sha256: createHash('sha256').update(readFileSync(walletsFile)).digest('hex'),
          }),
        );
        // Read back before anything depends on it.
        for (const row of store.active()) {
          const { invoiceKey } = keyring.decrypt(boxOf(row), credentialAAD(row));
          if (wallets.keyFor(row.owner) !== invoiceKey)
            throw new Error('A migrated credential did not read back correctly.');
        }
      } finally {
        store.close();
      }
      // Written by this code in wallets.json mode, where a person is their own connection id.
      let changed = false;
      const forget = (item) => {
        if (item.connection?.length === 64) {
          delete item.connection;
          changed = true;
        }
      };
      for (const record of state.data.invoices ?? []) forget(record);
      for (const item of state.data.outbox) forget(item);
      for (const entry of Object.values(state.data.callbacks ?? {})) forget(entry.delivery);
      if (changed) state.save();
      renameDatabase(this.temporary, this.database);
      if (skipped)
        this.log(
          `Skipped ${skipped} wallet(s) that were disconnected earlier. To link them again on purpose, use --relink-disconnected.`,
        );
      this.log(
        `Migrated ${count} wallet link(s). Backup: ${folder}. Now unset WALLETS_FILE and start the bot.`,
      );
      this.log('That backup holds wallets.json in the clear: delete it once this has run well.');
      return count;
    });
  }
  // Links operator wallets again in an existing database, as after recover-ledger. Each is a new
  // link: a wallet that was disconnected gets a new ref, so its old menus stay dead, and old
  // messages stay unanswered. A wallet that is connected to anyone is left as it is.
  #relink(state, walletsFile) {
    const origin = lnbitsURL(this.lnbitsUrl, this.allowHttp);
    const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
    const wallets = loadWallets(walletsFile);
    const store = new Store(this.database);
    try {
      const ledger = Ledger.open(this.secretsDir, keyring, { storeId: store.getMeta('store_id') });
      const folder = this.backupFolder('pre-relink');
      store.backupTo(join(folder, DB_FILE));
      this.copyPrivate(state.file, folder, 'state.json');
      this.manifest(folder, store, { kind: 'pre-relink' });
      let count = 0;
      let skipped = 0;
      for (const owner of wallets.owners()) {
        const invoiceKey = wallets.keyFor(owner);
        const id = newId();
        const sealed = seal(keyring, {
          id,
          owner,
          kind: 'lnbits',
          origin,
          secret: { invoiceKey },
        });
        try {
          store.checkConnect({ owner, fingerprint: sealed.fingerprint });
        } catch (error) {
          if (!(error instanceof StoreError) || error.code !== 'duplicate') throw error;
          skipped++;
          continue;
        }
        const m6 = walletRef(owner, invoiceKey);
        store.connect({
          id,
          ref: ledger.refs.has(m6) ? newId() : m6,
          owner,
          kind: 'lnbits',
          source: 'operator',
          label: wallets.label(owner),
          origin,
          ...sealed,
          actor: 'operator',
          action: 'migrate',
        });
        count++;
      }
      if (skipped) this.log(`Left ${skipped} wallet(s) that are connected already.`);
      this.log(`Linked ${count} wallet(s) again. Backup: ${folder}. Now start the bot.`);
      return count;
    } finally {
      store.close();
    }
  }
  // Back to wallets.json. Only what the M6 code can represent, and never anything revoked.
  rollback(walletsFile, { revokeUnrepresentable = false } = {}) {
    this.needSecrets();
    if (!walletsFile) throw new ConfigurationError('Name the wallets.json to write.');
    return this.locked((state) => {
      if (!existsSync(this.database)) throw new ConfigurationError('Nothing to roll back.');
      const origin = lnbitsURL(this.lnbitsUrl, this.allowHttp);
      const registry = Registry.open({
        dataDir: this.dataDir,
        secretsDir: this.secretsDir,
        maxPerOwner: Infinity,
      });
      try {
        const folder = this.backupFolder('pre-rollback');
        registry.store.backupTo(join(folder, DB_FILE));
        this.copyPrivate(state.file, folder, 'state.json');
        this.manifest(folder, registry.store, { kind: 'pre-rollback' });

        const entries = {};
        const refused = [];
        for (const owner of registry.owners()) {
          const inUse = registry.list(owner).find((c) => c.active);
          for (const wallet of registry.list(owner)) {
            const plain =
              wallet.id === inUse?.id &&
              wallet.source === 'operator' &&
              wallet.kind === 'lnbits' &&
              wallet.origin === origin;
            if (plain)
              entries[nip19.npubEncode(owner)] = {
                label: wallet.label,
                invoiceKey: registry.leaseById(wallet.id).key,
              };
            else refused.push(wallet.id);
          }
        }
        if (refused.length && !revokeUnrepresentable)
          throw new ConfigurationError(
            `${refused.length} connection(s) cannot be expressed in wallets.json. Run again with --revoke-unrepresentable to disconnect them.`,
          );
        // Checked before anything is disconnected: this failing must change nothing.
        const text = JSON.stringify(entries, null, 2);
        if (existsSync(walletsFile) && readFileSync(walletsFile, 'utf8') !== text)
          throw new ConfigurationError(`${walletsFile} exists with other contents.`);
        for (const id of refused) registry.revoke(id, 'operator');
        writeAtomic(walletsFile, text, 0o600);

        // M6 reads this state. Menus of anything revoked or with a random ref would never
        // match in M6 anyway; they go, so nothing can revive them later.
        const keep = new Set(
          registry.ids().map((id) => {
            const lease = registry.leaseById(id);
            return lease.ref === walletRef(lease.owner, lease.key) ? lease.ref : undefined;
          }),
        );
        const data = state.data;
        for (const [id, card] of Object.entries(data.cards ?? {}))
          if (!keep.has(card.ref)) delete data.cards[id];
        for (const [key, entry] of Object.entries(data.callbacks ?? {}))
          if (entry.ref && !keep.has(entry.ref)) delete data.callbacks[key];
        for (const ref of Object.keys(data.payments ?? {}))
          if (!keep.has(ref)) delete data.payments[ref];
        const live = new Set(registry.ids());
        data.outbox = data.outbox.filter((item) => !item.connection || live.has(item.connection));
        data.authorized = {
          users: Object.fromEntries(
            registry.owners().map((owner) => [owner, registry.linkedSince(owner)]),
          ),
        };
        state.save();
        registry.store.logAudit({ owner: '-', action: 'rollback', actor: 'operator' });
        registry.close();
        renameDatabase(this.database, `${this.database}.rolled-back-${stamp()}`);
        const count = Object.keys(entries).length;
        this.log(
          `Wrote ${count} wallet link(s) to ${walletsFile}. Set WALLETS_FILE to it and start the previous release.`,
        );
        return count;
      } catch (error) {
        registry.stopWatching();
        try {
          registry.store.close();
        } catch {
          /* already closed */
        }
        throw error;
      }
    });
  }

  // ---- Backup and restore ----------------------------------------------------------------

  // Safe while the bot runs. Never the keyring or the ledger: a data backup alone holds no
  // readable credential, and restoring it cannot bring back an old revocation history.
  backup(target) {
    const store = new Store(this.database);
    try {
      const folder = target ? resolve(target) : this.backupFolder('backup');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      chmodSync(folder, 0o700);
      if (existsSync(join(folder, DB_FILE)))
        throw new ConfigurationError('That folder already holds a backup.');
      store.backupTo(join(folder, DB_FILE));
      this.copyPrivate(join(this.dataDir, 'state.json'), folder, 'state.json');
      this.manifest(folder, store, { kind: 'backup' });
      this.log(
        `Backup written to ${folder}. It includes the bot's Nostr identity: keep it private.`,
      );
      return folder;
    } finally {
      store.close();
    }
  }
  // The current ledger always wins: anything disconnected since the backup stays revoked. If
  // it cannot be read, nothing is restored.
  // lostLedger: the host is gone and so is the ledger, which is never in a backup. What was
  // disconnected since the backup cannot be known, so everything restored starts disconnected:
  // the identity and history survive, people reconnect, and operator wallets are linked again.
  restore(folder, { lostLedger = false } = {}) {
    this.needSecrets();
    if (!folder) throw new ConfigurationError('Name the backup folder.');
    return this.locked((state) => {
      const source = join(folder, DB_FILE);
      const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
      const savedState = JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8'));
      const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
      const present = existsSync(ledgerFile(this.secretsDir));
      if (lostLedger && present)
        throw new ConfigurationError(
          'revocations.log exists, so it decides. Restore without --lost-ledger, or see "recover-ledger" in the README.',
        );
      const ledger = lostLedger ? undefined : Ledger.open(this.secretsDir, keyring);
      if (ledger && manifest.storeId !== ledger.storeId)
        throw new ConfigurationError(
          'That backup belongs to another store. If a new ledger was made after the old one was lost, move it away and use --lost-ledger.',
        );
      this.#dropTemporary();
      let active;
      let store;
      let lostStore;
      // A refused backup must leave the running setup as it was, startable.
      try {
        copyFileSync(source, this.temporary);
        chmodSync(this.temporary, 0o600);
        store = new Store(this.temporary);
        if (lostLedger) {
          const storeId = store.getMeta('store_id');
          if (manifest.storeId !== storeId)
            throw new ConfigurationError('That backup does not match its manifest.');
          active = 0;
          this.#revokeEverything(store, 'ledger lost');
          lostStore = this.#newGeneration(store);
          store.logAudit({ owner: '-', action: 'restore', actor: 'operator', detail: 'no ledger' });
          store.close();
        } else {
          const registry = new Registry({ store, keyring, ledger, maxPerOwner: Infinity });
          active = registry.size;
          registry.store.logAudit({ owner: '-', action: 'restore', actor: 'operator' });
          registry.close();
        }
        store = undefined;
      } catch (error) {
        try {
          store?.close();
        } catch {
          /* already closed */
        }
        this.#dropTemporary();
        throw error;
      }
      if (existsSync(this.database)) {
        const previous = this.backupFolder('before-restore');
        this.copyPrivate(state.file, previous, 'state.json');
        renameDatabase(this.database, join(previous, DB_FILE));
      }
      renameDatabase(this.temporary, this.database);
      // This state knows nothing of messages since the backup, so relays resending them would be
      // answered again and could create a second invoice. Only what is written from now counts.
      state.data = { ...savedState, startedAt: Math.floor(Date.now() / 1000) };
      state.save();
      // Last: until this exists nothing starts, and the same command can simply run again. A
      // ledger beside anything older could read as the whole history.
      if (lostStore) this.#writeLedger(keyring, lostStore);
      this.log(`Restored; ${active} connection(s) in force after applying the ledger.`);
      if (lostLedger)
        this.log(
          'Every connection starts disconnected. People reconnect; link operator wallets with migrate --relink-disconnected. Store keyring.json offline if it is new.',
        );
      this.log(
        'Payments announced since the backup may be announced again, and invoice requests made since are unknown.',
      );
      return active;
    });
  }

  #dropTemporary() {
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(this.temporary + suffix)) rmSync(this.temporary + suffix);
  }

  // ---- Connections -----------------------------------------------------------------------

  // An empty database, for a bot with no wallets.json: people connect their own.
  initStore() {
    this.needSecrets();
    return this.locked(() => {
      if (existsSync(this.database)) throw new ConfigurationError('connections.db already exists.');
      const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
      const ledger = existsSync(ledgerFile(this.secretsDir))
        ? Ledger.open(this.secretsDir, keyring)
        : Ledger.create(this.secretsDir, keyring, newId());
      if (existsSync(this.temporary)) rmSync(this.temporary);
      const store = Store.create(this.temporary, { storeId: ledger.storeId });
      store.close();
      renameDatabase(this.temporary, this.database);
      this.log('Created an empty connection database. Set SECRETS_DIR and start the bot.');
    });
  }
  list() {
    const store = new Store(this.database);
    try {
      const rows = store.all();
      for (const row of rows)
        this.log(
          `${row.id}  ${row.status}  ${row.kind}  ${row.source}  ${nip19.npubEncode(row.owner)}  ${JSON.stringify(row.label)}`,
        );
      if (!rows.length) this.log('No connections.');
      return rows;
    } finally {
      store.close();
    }
  }
  // Safe while the bot runs, and picked up by it within seconds. Touches only the ledger and
  // the database, never state.json.
  revoke(id) {
    this.needSecrets();
    const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
    const store = new Store(this.database);
    try {
      const row = store.connection(id);
      if (row?.status !== 'active') {
        this.log('That connection is not active.');
        return false;
      }
      Ledger.open(this.secretsDir, keyring, { storeId: store.getMeta('store_id') }).append({
        connection: id,
        ref: row.ref,
        actor: 'operator',
      });
      store.revoke(id, 'operator');
      this.log(
        `Revoked ${id}. Reset the wallet's key in LNbits to make the old key useless everywhere.`,
      );
      return true;
    } finally {
      store.close();
    }
  }
  #revokeEverything(store, detail) {
    const rows = store.active();
    for (const row of rows) store.revoke(row.id, 'system', { detail });
    return rows.length;
  }
  // History cannot be trusted any more: everything is disconnected, so nothing that was
  // disconnected can come back. Operator links are migrated again; people reconnect.
  recoverLedger() {
    this.needSecrets();
    return this.locked(() => {
      if (!existsSync(this.database))
        throw new ConfigurationError(
          'There is no connections.db here. To restore a backup without its ledger, use: npm run restore -- <backup folder> --lost-ledger',
        );
      const keyring = Keyring.load(this.secretsDir, { dataDir: this.dataDir });
      const store = new Store(this.database);
      try {
        const count = this.#revokeEverything(store, 'ledger recovery');
        this.#newLedger(keyring, store);
        store.logAudit({ owner: '-', action: 'recover', actor: 'operator', detail: 'ledger' });
        this.log(
          `Revoked ${count} connection(s) and started a new ledger. Link operator wallets again with migrate --relink-disconnected; people reconnect.`,
        );
        return count;
      } finally {
        store.close();
      }
    });
  }
  // No keyring and no backup of it: nothing stored can be read, or trusted.
  resetLostKeyring() {
    this.needSecrets();
    return this.locked(() => {
      const file = join(this.secretsDir, 'keyring.json');
      let readable = false;
      try {
        Keyring.load(this.secretsDir, { dataDir: this.dataDir });
        readable = true;
      } catch (error) {
        if (!(error instanceof KeyringError)) throw error;
      }
      if (readable) throw new ConfigurationError('The keyring is readable: nothing to reset.');
      if (existsSync(file)) renameSync(file, `${file}.lost-${stamp()}`);
      const keyring = Keyring.init(this.secretsDir, { dataDir: this.dataDir });
      const store = new Store(this.database);
      try {
        const count = this.#revokeEverything(store, 'keyring lost');
        this.#newLedger(keyring, store);
        store.logAudit({ owner: '-', action: 'recover', actor: 'operator', detail: 'keyring' });
        this.log(
          `Revoked ${count} connection(s) under a new keyring. Store keyring.json offline now.`,
        );
        return count;
      } finally {
        store.close();
      }
    });
  }
  // A new ledger knows only this database's rows, so what was revoked before it is known only
  // to the old one. The store gets a new id, and backups from before it no longer match: they
  // could hold a wallet this ledger has never heard of, active. --lost-ledger still takes them,
  // with everything disconnected. Returns what #writeLedger needs.
  #newGeneration(store) {
    const storeId = newId();
    store.setMeta('store_id', storeId);
    return {
      storeId,
      entries: store.all().map((row) => ({
        connection: row.id,
        ref: row.ref,
        actor: row.revoked_by ?? 'system',
        at: row.revoked_at ?? undefined,
      })),
    };
  }
  #writeLedger(keyring, { storeId, entries }) {
    const file = ledgerFile(this.secretsDir);
    if (existsSync(file)) renameSync(file, `${file}.broken-${stamp()}`);
    Ledger.createWith(this.secretsDir, keyring, storeId, entries);
  }
  #newLedger(keyring, store) {
    this.#writeLedger(keyring, this.#newGeneration(store));
  }
}

const boxOf = (row) => ({ kid: row.kid, nonce: row.nonce, secret: row.secret });

function fromEnv(env) {
  return new Tools({
    dataDir: env.DATA_DIR?.trim() || resolve(HERE, 'data'),
    secretsDir: env.SECRETS_DIR?.trim() || '',
    lnbitsUrl: env.LNBITS_URL,
    allowHttp: ['true', '1', 'yes'].includes((env.LNBITS_ALLOW_HTTP ?? '').trim().toLowerCase()),
    retentionDays: Number(env.BACKUP_RETENTION_DAYS) || 30,
    nsec: env.NSEC ?? '',
  });
}

export function run(args, env = process.env) {
  const tools = fromEnv(env);
  const [tool, action, ...rest] = args;
  const flag = (name) => rest.includes(name);
  if (tool === 'keyring') {
    if (action === 'init') return tools.keyringInit();
    if (action === 'list') return tools.keyringList();
    if (action === 'rotate') return tools.rotate();
    if (action === 'retire')
      return tools.retire(rest[0], { afterRetention: flag('--after-retention') });
  }
  if (tool === 'migrate')
    return tools.migrate(action, { relinkDisconnected: flag('--relink-disconnected') });
  if (tool === 'rollback')
    return tools.rollback(action, { revokeUnrepresentable: flag('--revoke-unrepresentable') });
  if (tool === 'backup') return tools.backup(action);
  if (tool === 'restore') return tools.restore(action, { lostLedger: flag('--lost-ledger') });
  if (tool === 'connections') {
    if (action === 'init') return tools.initStore();
    if (action === 'list') return tools.list();
    if (action === 'revoke') return tools.revoke(rest[0]);
    if (action === 'recover-ledger') return tools.recoverLedger();
    if (action === 'reset-lost-keyring') return tools.resetLostKeyring();
  }
  throw new ConfigurationError('Unknown command: see the top of admin.js or the README.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const known =
      error instanceof ConfigurationError ||
      error instanceof KeyringError ||
      error instanceof LedgerError;
    console.error(known ? error.message : `Failed: ${error.message}`);
    process.exitCode = 1;
  }
}
