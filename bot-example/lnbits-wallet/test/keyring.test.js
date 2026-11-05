// The keyring: file checks, encryption bound to its row, rotation and retirement.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { credentialAAD, Keyring } from '../keyring.js';
import { ConfigurationError } from '../vendor/runtime.js';
import { tempDir } from './helpers.js';

const SECRET = 'a11ce000000000000000000000000001';
const ROW = {
  id: 'c'.repeat(32),
  owner: 'a'.repeat(64),
  kind: 'lnbits',
  origin: 'https://l.example/',
};
const aad = (row = ROW) => credentialAAD(row);
const fresh = (t) => {
  const dir = join(tempDir(t, 'keyring'), 'secrets');
  return { dir, keyring: Keyring.init(dir) };
};

test('init creates private files and never replaces a keyring', (t) => {
  const { dir, keyring } = fresh(t);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'keyring.json')).mode & 0o777, 0o400);
  assert.equal(keyring.current, 'k1');
  const before = readFileSync(join(dir, 'keyring.json'));
  assert.throws(() => Keyring.init(dir), /already has a keyring/);
  assert.deepEqual(readFileSync(join(dir, 'keyring.json')), before);
  assert.equal(Keyring.load(dir).current, 'k1');
});

test('load refuses missing, loose or invalid files and a folder inside DATA_DIR', (t) => {
  const { dir } = fresh(t);
  const file = join(dir, 'keyring.json');
  chmodSync(file, 0o644);
  assert.throws(() => Keyring.load(dir), ConfigurationError);
  chmodSync(file, 0o600);
  assert.equal(Keyring.load(dir).current, 'k1', '0600 is accepted');
  chmodSync(dir, 0o755);
  assert.throws(() => Keyring.load(dir), /must be private/);
  chmodSync(dir, 0o700);

  const secret = JSON.parse(readFileSync(file, 'utf8')).keys.k1.key;
  writeFileSync(file, '{"version":1,"current":"k9"}');
  let message = '';
  try {
    Keyring.load(dir);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /not valid/);
  writeFileSync(file, `not json ${secret}`);
  assert.throws(
    () => Keyring.load(dir),
    (error) => !error.message.includes(secret),
    'the file is never echoed',
  );

  const other = tempDir(t, 'keyring-missing');
  assert.throws(() => Keyring.load(join(other, 'nope')), /does not exist/);
  mkdirSync(join(other, 'empty'), { mode: 0o700 });
  assert.throws(
    () => Keyring.load(join(other, 'empty')),
    (error) => error.code === 'missing',
  );

  const data = tempDir(t, 'keyring-data');
  assert.throws(() => Keyring.init(join(data, 'secrets'), { dataDir: data }), /separate folders/);
});

test('a ciphertext decrypts only for its own row and detects tampering', (t) => {
  const { keyring } = fresh(t);
  const box = keyring.encrypt({ invoiceKey: SECRET }, aad());
  assert.ok(!box.secret.toString('latin1').includes(SECRET));
  assert.deepEqual(keyring.decrypt(box, aad()), { invoiceKey: SECRET });
  assert.notDeepEqual(keyring.encrypt({ invoiceKey: SECRET }, aad()).nonce, box.nonce);
  for (const change of [
    { id: 'd'.repeat(32) },
    { owner: 'b'.repeat(64) },
    { kind: 'nwc' },
    { origin: 'https://evil.example/' },
  ])
    assert.throws(
      () => keyring.decrypt(box, aad({ ...ROW, ...change })),
      (error) => error.code === 'decrypt' && !error.message.includes(SECRET),
    );
  const tampered = Buffer.from(box.secret);
  tampered[0] ^= 1;
  assert.throws(
    () => keyring.decrypt({ ...box, secret: tampered }, aad()),
    /could not be decrypted/,
  );
  assert.throws(
    () => keyring.decrypt({ ...box, kid: 'k7' }, aad()),
    (error) => error.code === 'unknown_kid',
  );
});

test('keys never appear when the keyring is logged or serialized', (t) => {
  const { dir, keyring } = fresh(t);
  const saved = JSON.parse(readFileSync(join(dir, 'keyring.json'), 'utf8'));
  for (const text of [JSON.stringify(keyring), inspect(keyring, { depth: 5, showHidden: true })])
    for (const value of [saved.keys.k1.key, saved.fingerprint, saved.ledger])
      assert.ok(!text.includes(value), 'key material printed');
});

test('rotation keeps old ciphertexts readable and leaves fingerprints unchanged', (t) => {
  const { dir, keyring } = fresh(t);
  const old = keyring.encrypt({ invoiceKey: SECRET }, aad());
  const digest = keyring.fingerprint(ROW.origin, SECRET);
  const mac = keyring.ledgerMac('line');
  assert.equal(keyring.addKey(), 'k2');
  assert.equal(keyring.current, 'k2');
  assert.deepEqual(keyring.decrypt(old, aad()), { invoiceKey: SECRET });
  assert.equal(keyring.encrypt({ a: 1 }, aad()).kid, 'k2');

  const reloaded = Keyring.load(dir);
  assert.equal(reloaded.current, 'k2');
  assert.deepEqual(reloaded.kids(), ['k1', 'k2']);
  assert.deepEqual(reloaded.decrypt(old, aad()), { invoiceKey: SECRET });
  assert.equal(reloaded.fingerprint(ROW.origin, SECRET), digest);
  assert.notEqual(reloaded.fingerprint(ROW.origin, `${SECRET}x`), digest);
  assert.equal(reloaded.ledgerMac('line'), mac);
  assert.equal(statSync(join(dir, 'keyring.json')).mode & 0o777, 0o400);
});

test('a crash during a keyring write leaves the old file in force', (t) => {
  const { dir, keyring } = fresh(t);
  const box = keyring.encrypt({ invoiceKey: SECRET }, aad());
  // The temporary file of an interrupted write is ignored, and the next write replaces it.
  writeFileSync(join(dir, 'keyring.json.new'), 'half a fi');
  const reloaded = Keyring.load(dir);
  assert.deepEqual(reloaded.decrypt(box, aad()), { invoiceKey: SECRET });
  assert.equal(reloaded.addKey(), 'k2');
  assert.ok(!existsSync(join(dir, 'keyring.json.new')));
});

test('retiring a key is refused while needed; afterwards its ciphertexts are unreadable', (t) => {
  const { dir, keyring } = fresh(t);
  const old = keyring.encrypt({ invoiceKey: SECRET }, aad());
  assert.throws(() => keyring.retire('k1'), /current key/);
  assert.throws(() => keyring.retire('k9'), /No key/);
  keyring.addKey();
  assert.throws(() => keyring.retire('k1', new Set(['k1'])), /still in use/);
  assert.deepEqual(keyring.decrypt(old, aad()), { invoiceKey: SECRET });

  const leftovers = keyring.retire('k1', new Set(['k2']));
  assert.ok(leftovers.length >= 1, 'the backups that still hold the key are listed');
  assert.throws(
    () => Keyring.load(dir).decrypt(old, aad()),
    (error) => error.code === 'unknown_kid',
  );
});
