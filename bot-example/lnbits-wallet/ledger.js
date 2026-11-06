// The revocation ledger: SECRETS_DIR/revocations.log, one signed line per disconnected wallet.
//
//   v1 <store id> header <created at> - - <hmac>
//   v1 <store id> <connection id> <ref> <revoked at> <actor> <hmac>
//
// It lives outside DATA_DIR and outside data backups, so restoring old data can never bring
// back an old ledger: it is always the newest record of what was revoked. Every revocation
// is written here first and to the database second, so after a crash the ledger can only be
// ahead, and the database follows it. Nothing that was disconnected comes back.
//
// A missing or damaged ledger means the history cannot be trusted: callers fail closed. The
// only tolerated damage is a last line cut short by a crash. Lines are appended with O_APPEND
// in one small write, so the bot and the operator's CLI cannot interleave. This protects against
// old backups, rollbacks and copied files, not against someone who can write to SECRETS_DIR: each
// line is signed, but a removed line goes unnoticed. Whoever can do that as the bot's user can
// read the keyring there too, and so every stored key, which is worse.
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const FILE = 'revocations.log';
const ID = /^[a-f0-9]{32}$/;
const ACTORS = new Set(['operator', 'user', 'system']);
const seconds = () => Math.floor(Date.now() / 1000);

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const corrupt = () =>
  new LedgerError(
    'corrupt',
    'revocations.log failed its checks, so revocation history cannot be trusted. See "npm run connections -- recover-ledger" in the README.',
  );

const fsyncFolder = (file) => {
  const dir = openSync(resolve(file, '..'), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
};

export const ledgerFile = (dir) => join(dir, FILE);

export class Ledger {
  constructor(file, keyring) {
    this.file = file;
    this.keyring = keyring;
    this.connections = new Set();
    this.refs = new Set();
    this.entries = [];
  }
  // A new ledger. Never replaces one.
  static create(dir, keyring, storeId) {
    const file = ledgerFile(dir);
    const ledger = new Ledger(file, keyring);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(fd, `${ledger.#line(['v1', storeId, 'header', seconds(), '-', '-'])}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncFolder(file);
    ledger.storeId = storeId;
    return ledger;
  }
  // A new ledger that already holds these entries, whole or not at all: a partial one would
  // read as complete, and everything left out of it could come back.
  static createWith(dir, keyring, storeId, entries) {
    const file = ledgerFile(dir);
    const ledger = new Ledger(file, keyring);
    const lines = [
      ledger.#line(['v1', storeId, 'header', seconds(), '-', '-']),
      ...entries.map(({ connection, ref, actor, at = seconds() }) => {
        if (!ID.test(connection) || !ID.test(ref) || !ACTORS.has(actor))
          throw new RangeError('Invalid revocation entry.');
        return ledger.#line(['v1', storeId, connection, ref, at, actor]);
      }),
    ];
    const temp = `${file}.new`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, `${lines.join('\n')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    fsyncFolder(file);
    return ledger.refresh();
  }
  // Throws LedgerError ('missing' or 'corrupt') unless every line checks out.
  static open(dir, keyring, { storeId } = {}) {
    const ledger = new Ledger(ledgerFile(dir), keyring);
    ledger.refresh();
    if (storeId && ledger.storeId !== storeId) throw corrupt();
    return ledger;
  }
  #line(fields) {
    const text = fields.join(' ');
    return `${text} ${this.keyring.ledgerMac(text)}`;
  }
  // Reads the file again: the operator's CLI may have added lines.
  refresh() {
    let stat, text;
    try {
      stat = lstatSync(this.file);
    } catch {
      throw new LedgerError(
        'missing',
        'revocations.log is missing, so revocation history cannot be trusted. See "npm run connections -- recover-ledger" in the README.',
      );
    }
    if (!stat.isFile() || stat.mode & 0o077) throw corrupt();
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      throw corrupt();
    }
    const lines = text.split('\n');
    lines.pop(); // What follows the last newline is empty, or a line cut short by a crash.
    if (!lines.length) throw corrupt();
    const entries = [];
    let storeId;
    for (const [index, line] of lines.entries()) {
      const fields = line.split(' ');
      if (fields.length !== 7) throw corrupt();
      const mac = fields.pop();
      if (this.keyring.ledgerMac(fields.join(' ')) !== mac || fields[0] !== 'v1') throw corrupt();
      if (index === 0) {
        if (fields[2] !== 'header' || !ID.test(fields[1])) throw corrupt();
        storeId = fields[1];
        continue;
      }
      const [, store, connection, ref, at, actor] = fields;
      if (store !== storeId || !ID.test(connection) || !ID.test(ref) || !ACTORS.has(actor))
        throw corrupt();
      entries.push({ connection, ref, at: Number(at), actor });
    }
    this.storeId = storeId;
    this.entries = entries;
    this.connections = new Set(entries.map((e) => e.connection));
    this.refs = new Set(entries.map((e) => e.ref));
    return this;
  }
  has({ id, ref }) {
    return this.connections.has(id) || this.refs.has(ref);
  }
  // Durable when it returns. A second line for the same connection is harmless.
  append({ connection, ref, actor, at = seconds() }) {
    if (!ID.test(connection) || !ID.test(ref) || !ACTORS.has(actor))
      throw new RangeError('Invalid revocation entry.');
    const line = `${this.#line(['v1', this.storeId, connection, ref, at, actor])}\n`;
    const fd = openSync(this.file, constants.O_RDWR | constants.O_APPEND);
    try {
      dropCutLine(fd);
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.entries.push({ connection, ref, at, actor });
    this.connections.add(connection);
    this.refs.add(ref);
  }
}

// A writer that crashed mid-line leaves text without a newline. Left in place, the next line
// would join it and fail its check, so it is removed before appending.
function dropCutLine(fd) {
  const { size } = fstatSync(fd);
  if (!size) return;
  const window = Buffer.alloc(Math.min(size, 1024));
  readSync(fd, window, 0, window.length, size - window.length);
  if (window[window.length - 1] === 10) return;
  const newline = window.lastIndexOf(10);
  if (newline >= 0) ftruncateSync(fd, size - window.length + newline + 1);
}

// What must change so the database and the ledger agree. rows: { id, ref, status }. The
// ledger wins: the direction is always toward more revoked, never fewer.
export function reconcile(ledger, rows) {
  return {
    revoke: rows.filter((r) => r.status === 'active' && ledger.has(r)).map((r) => r.id),
    record: rows.filter((r) => r.status === 'revoked' && !ledger.connections.has(r.id)),
  };
}
