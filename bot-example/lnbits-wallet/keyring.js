// The keys that protect stored wallet credentials. They live in SECRETS_DIR, never inside
// DATA_DIR, so a copy or backup of the data folder holds no readable wallet credential. It does
// hold the bot's Nostr key, in state.json.
//
// keyring.json (mode 0400 or 0600, folder 0700):
//   { version: 1, current: "k2", keys: { k1: { key, created }, k2: { key, created } },
//     fingerprint: "<base64>", ledger: "<base64>" }
//
// Credentials use AES-256-GCM under a key derived from keys[current]; the additional data
// names the row, so a ciphertext copied to another row does not decrypt. The fingerprint and
// ledger keys never change, so credential rotation leaves duplicate detection and the
// revocation ledger intact.
//
// Rotation adds a key first and re-encrypts afterwards, so a crash at any point loses nothing.
// Retiring a key is what makes old copies of credentials useless (backups, WAL frames, freed
// pages): they stay readable only while a keyring holds the key that encrypted them.
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { ConfigurationError } from './vendor/runtime.js';

const FILE = 'keyring.json';
const KEY_BYTES = 32;
const KID = /^k[1-9][0-9]{0,5}$/;
const SALT = 'anagram-lnbits-wallet';
const newKey = () => randomBytes(KEY_BYTES).toString('base64');
const seconds = () => Math.floor(Date.now() / 1000);

export class KeyringError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Temporary file, fsync, rename, fsync of the folder: the file is either old or new, whole.
export function writeAtomic(file, text, mode) {
  const temp = `${file}.new`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  renameSync(temp, file);
  const dir = openSync(resolve(file, '..'), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

const inside = (child, parent) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

// SECRETS_DIR must be a real, private folder of this user, apart from DATA_DIR.
export function checkSecretsDir(dir, dataDir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    throw new ConfigurationError('SECRETS_DIR does not exist. Run: npm run keyring -- init');
  }
  if (!stat.isDirectory()) throw new ConfigurationError('SECRETS_DIR must be a real folder.');
  if (stat.mode & 0o077) throw new ConfigurationError('SECRETS_DIR must be private: chmod 700.');
  if (process.getuid && stat.uid !== process.getuid())
    throw new ConfigurationError('SECRETS_DIR must belong to the user running the bot.');
  if (dataDir && existsSync(dataDir)) {
    const [a, b] = [realpathSync(dir), realpathSync(dataDir)];
    if (inside(a, b) || inside(b, a))
      throw new ConfigurationError('SECRETS_DIR and DATA_DIR must be separate folders.');
  }
}

function checkFile(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new KeyringError(
      'missing',
      'keyring.json is missing from SECRETS_DIR. Restore it from its offline backup.',
    );
  }
  if (!stat.isFile()) throw new ConfigurationError('keyring.json must be a regular file.');
  if (stat.mode & 0o077) throw new ConfigurationError('keyring.json must be private: chmod 400.');
}

const b64key = (value) => {
  const key = typeof value === 'string' ? Buffer.from(value, 'base64') : undefined;
  return key?.length === KEY_BYTES && key.toString('base64') === value ? key : undefined;
};

export const credentialAAD = ({ id, owner, kind, origin }) =>
  `alw-credential-v1|${id}|${owner}|${kind}|${origin}`;

export class Keyring {
  #data;
  #derived = new Map();
  constructor(dir, data) {
    this.dir = dir;
    this.file = join(dir, FILE);
    this.#data = data;
    if (
      data?.version !== 1 ||
      !data.keys ||
      typeof data.keys !== 'object' ||
      !Object.hasOwn(data.keys, data.current) ||
      !b64key(data.fingerprint) ||
      !b64key(data.ledger) ||
      !Object.entries(data.keys).every(
        ([kid, entry]) =>
          KID.test(kid) && b64key(entry?.key) && Number.isSafeInteger(entry.created),
      )
    )
      throw new KeyringError('invalid', 'keyring.json is not valid. Restore it from its backup.');
  }
  // Creates a new keyring. Never replaces one: that would lose every credential.
  static init(dir, { dataDir } = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    checkSecretsDir(dir, dataDir);
    const file = join(dir, FILE);
    if (existsSync(file)) throw new KeyringError('exists', 'SECRETS_DIR already has a keyring.');
    const data = {
      version: 1,
      current: 'k1',
      keys: { k1: { key: newKey(), created: seconds() } },
      fingerprint: newKey(),
      ledger: newKey(),
    };
    writeAtomic(file, JSON.stringify(data), 0o400);
    return new Keyring(dir, data);
  }
  static load(dir, { dataDir } = {}) {
    checkSecretsDir(dir, dataDir);
    const file = join(dir, FILE);
    checkFile(file);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Never echo the file: it holds keys.
      throw new KeyringError('invalid', 'keyring.json is not valid. Restore it from its backup.');
    }
    return new Keyring(dir, data);
  }
  toJSON() {
    return { keyring: this.kids() };
  }
  get current() {
    return this.#data.current;
  }
  // When the current key was made, so the bot can remind the operator to rotate.
  get currentCreated() {
    return this.#data.keys[this.current].created;
  }
  kids() {
    return Object.keys(this.#data.keys);
  }
  has(kid) {
    return Object.hasOwn(this.#data.keys, kid);
  }
  #credentialKey(kid) {
    if (!this.has(kid)) throw new KeyringError('unknown_kid', `No key ${kid} in the keyring.`);
    let key = this.#derived.get(kid);
    if (!key) {
      key = Buffer.from(
        hkdfSync('sha256', b64key(this.#data.keys[kid].key), SALT, 'credential/v1', KEY_BYTES),
      );
      this.#derived.set(kid, key);
    }
    return key;
  }
  encrypt(value, aad) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#credentialKey(this.current), nonce);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { kid: this.current, nonce, secret: Buffer.concat([body, cipher.getAuthTag()]) };
  }
  decrypt({ kid, nonce, secret }, aad) {
    const key = this.#credentialKey(kid);
    try {
      const data = Buffer.from(secret);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(data.subarray(-16));
      return JSON.parse(
        Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'),
      );
    } catch {
      throw new KeyringError('decrypt', 'A stored credential could not be decrypted.');
    }
  }
  // Same origin and key give the same digest, which says nothing without the keyring.
  fingerprint(origin, secret) {
    return createHmac('sha256', b64key(this.#data.fingerprint))
      .update(`${origin}\n${secret}`)
      .digest('hex');
  }
  ledgerMac(text) {
    return createHmac('sha256', b64key(this.#data.ledger)).update(text).digest('hex');
  }

  #replace(data) {
    // The previous file stays beside it until the operator has a new offline backup.
    const backup = `${this.file}.bak-${Date.now()}`;
    copyFileSync(this.file, backup);
    chmodSync(backup, 0o400);
    writeAtomic(this.file, JSON.stringify(data), 0o400);
    this.#data = data;
    return backup;
  }
  // Adds a new current key. Rows are re-encrypted afterwards (see rotate in store.js); both
  // keys are present from here on, so a crash loses nothing.
  addKey() {
    const next = Math.max(...this.kids().map((kid) => Number(kid.slice(1)))) + 1;
    const kid = `k${next}`;
    this.#replace({
      ...this.#data,
      current: kid,
      keys: { ...this.#data.keys, [kid]: { key: newKey(), created: seconds() } },
    });
    return kid;
  }
  // Removes a key nothing needs any more. inUse: the kids of live rows and retained backups.
  // Returns the leftover keyring backups that still hold the key, for the operator to delete.
  retire(kid, inUse = new Set()) {
    if (!this.has(kid)) throw new KeyringError('unknown_kid', `No key ${kid} in the keyring.`);
    if (kid === this.current)
      throw new KeyringError('in_use', 'The current key cannot be retired.');
    if (inUse.has(kid)) throw new KeyringError('in_use', `Key ${kid} is still in use.`);
    const { [kid]: _gone, ...keys } = this.#data.keys;
    this.#replace({ ...this.#data, keys });
    this.#derived.delete(kid);
    return readdirSync(this.dir)
      .filter((name) => name.startsWith(`${FILE}.bak-`))
      .filter((name) => {
        try {
          return Object.hasOwn(JSON.parse(readFileSync(join(this.dir, name), 'utf8')).keys, kid);
        } catch {
          return true; // Unreadable: the operator should look at it.
        }
      });
  }
}
