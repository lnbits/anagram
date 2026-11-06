// The revocation ledger: signed lines, fail-closed reading, crash tolerance, two writers.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keyring } from '../keyring.js';
import { Ledger, ledgerFile, reconcile } from '../ledger.js';
import { tempDir } from './helpers.js';

const STORE = 'f'.repeat(32);
const id = () => randomBytes(16).toString('hex');
const entry = (actor = 'user') => ({ connection: id(), ref: id(), actor });
function fresh(t) {
  const dir = join(tempDir(t, 'ledger'), 'secrets');
  const keyring = Keyring.init(dir);
  return { dir, keyring, ledger: Ledger.create(dir, keyring, STORE) };
}
const closed = (code) => (error) => error.code === code && !/[a-f0-9]{64}/.test(error.message);

test('lines survive reopening and are private', (t) => {
  const { dir, keyring, ledger } = fresh(t);
  assert.equal(statSync(ledgerFile(dir)).mode & 0o777, 0o600);
  assert.throws(() => Ledger.create(dir, keyring, STORE), /EEXIST/);
  const one = entry();
  ledger.append(one);
  const again = Ledger.open(dir, keyring, { storeId: STORE });
  assert.equal(again.storeId, STORE);
  assert.ok(again.connections.has(one.connection));
  assert.ok(again.has({ id: 'x', ref: one.ref }), 'found by ref too');
  assert.ok(!again.has({ id: id(), ref: id() }));
  assert.equal(again.entries[0].actor, 'user');
  assert.throws(() => ledger.append({ ...one, actor: 'nobody' }), RangeError);
});

test('a missing, damaged, foreign or loose ledger fails closed', (t) => {
  const { dir, keyring, ledger } = fresh(t);
  ledger.append(entry());
  const file = ledgerFile(dir);
  const good = readFileSync(file, 'utf8');
  const restore = () => {
    chmodSync(file, 0o600);
    writeFileSync(file, good);
  };

  assert.throws(() => Ledger.open(dir, keyring, { storeId: id() }), closed('corrupt'));

  writeFileSync(file, good.replace(/ user /, ' system '));
  assert.throws(() => Ledger.open(dir, keyring), closed('corrupt'), 'an edited line');
  restore();

  writeFileSync(file, good.split('\n').slice(1).join('\n'));
  assert.throws(() => Ledger.open(dir, keyring), closed('corrupt'), 'no header');
  restore();

  writeFileSync(file, '');
  assert.throws(() => Ledger.open(dir, keyring), closed('corrupt'), 'emptied');
  restore();

  chmodSync(file, 0o644);
  assert.throws(() => Ledger.open(dir, keyring), closed('corrupt'), 'loose mode');
  restore();

  const other = Keyring.init(join(tempDir(t, 'ledger-other'), 'secrets'));
  assert.throws(() => Ledger.open(dir, other), closed('corrupt'), 'signed by another keyring');

  rmSync(file);
  assert.throws(() => Ledger.open(dir, keyring), closed('missing'));
});

test('a last line cut short by a crash is ignored and removed by the next append', (t) => {
  const { dir, keyring, ledger } = fresh(t);
  const kept = entry();
  ledger.append(kept);
  appendFileSync(ledgerFile(dir), `v1 ${STORE} ${id()} half-a-li`);

  const reopened = Ledger.open(dir, keyring);
  assert.equal(reopened.entries.length, 1);
  const next = entry();
  reopened.append(next);

  const final = Ledger.open(dir, keyring);
  assert.deepEqual(
    final.entries.map((e) => e.connection),
    [kept.connection, next.connection],
  );
});

test('two processes appending at once never interleave', async (t) => {
  const { dir, keyring } = fresh(t);
  const url = (name) => new URL(`../${name}`, import.meta.url).href;
  const script = `
    import { Keyring } from ${JSON.stringify(url('keyring.js'))};
    import { Ledger } from ${JSON.stringify(url('ledger.js'))};
    import { randomBytes } from 'node:crypto';
    const dir = process.argv[1];
    const ledger = Ledger.open(dir, Keyring.load(dir));
    const id = () => randomBytes(16).toString('hex');
    for (let i = 0; i < 100; i++) ledger.append({ connection: id(), ref: id(), actor: 'operator' });
  `;
  const run = () =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'inherit',
      });
      child.once('exit', (code) => (code === 0 ? done() : fail(new Error(`exit ${code}`))));
    });
  await Promise.all([run(), run()]);
  assert.equal(Ledger.open(dir, keyring).entries.length, 200);
});

test('reconcile moves only toward more revoked', (t) => {
  const { ledger } = fresh(t);
  const gone = entry();
  ledger.append(gone);
  const active = { id: id(), ref: id(), status: 'active' };
  const byId = { id: gone.connection, ref: id(), status: 'active' };
  const byRef = { id: id(), ref: gone.ref, status: 'active' };
  const missing = { id: id(), ref: id(), status: 'revoked' };
  const known = { id: gone.connection, ref: gone.ref, status: 'revoked' };
  const { revoke, record } = reconcile(ledger, [active, byId, byRef, missing, known]);
  assert.deepEqual(revoke.sort(), [byId.id, byRef.id].sort());
  assert.deepEqual(record, [missing]);
});

test('a ledger made with its entries is whole, and takes effect only when it is', (t) => {
  const dir = join(tempDir(t, 'ledger-with'), 'secrets');
  const keyring = Keyring.init(dir);
  const entries = [{ connection: 'a'.repeat(32), ref: 'b'.repeat(32), actor: 'system' }];
  const ledger = Ledger.createWith(dir, keyring, 'c'.repeat(32), entries);
  assert.equal(ledger.storeId, 'c'.repeat(32));
  assert.ok(ledger.has({ id: 'a'.repeat(32), ref: 'z' }));
  assert.equal(Ledger.open(dir, keyring).entries.length, 1);
  rmSync(ledgerFile(dir));
  assert.throws(
    () =>
      Ledger.createWith(dir, keyring, 'c'.repeat(32), [
        { connection: 'x', ref: 'y', actor: 'system' },
      ]),
    RangeError,
  );
  assert.ok(!existsSync(ledgerFile(dir)), 'a bad entry leaves nothing');
});
