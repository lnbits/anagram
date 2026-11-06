// The pretend wallet for manual testing is a real NIP-47 peer as far as the client can tell. It must
// count every pay_invoice per hash, keep its limit and survive a restart without acting twice.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NwcClient, parseConnection } from '../nwc.js';
import { decodeInvoice } from '../bolt11.js';
import { defer, tempDir } from './helpers.js';
import { startMockWallet } from './mock-wallet.js';
import { relay } from './relay.js';

const SCRIPT = fileURLToPath(new URL('./mock-wallet.js', import.meta.url));
const GUARD = fileURLToPath(new URL('./no-network.js', import.meta.url));
const sha256 = async (hex) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(hex, 'hex'))).toString('hex');

async function world(t, options = {}) {
  const local = await relay();
  defer(t, () => local.close());
  const dir = tempDir(t, 'mock');
  const wallet = await startMockWallet({ dir, relay: local.url, ...options });
  defer(t, () => wallet.close());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [local.url] });
  const secret = () => ({
    ...wallet.secret,
    scope: options.kind === 'receive' ? 'receive' : 'spend',
  });
  const pay = (invoice) => client.pay(secret(), invoice, { timeoutMs: 300 });
  return { local, dir, wallet, client, secret, pay };
}

test('refuses every relay that is not on this computer by number', async (t) => {
  const dir = tempDir(t, 'mock-refuse');
  for (const relayUrl of [
    undefined,
    'wss://relay.damus.io',
    'ws://localhost:7791',
    'ws://192.168.1.10:7791',
    'ws://127.0.0.1:1,ws://127.0.0.1:2',
  ])
    await assert.rejects(startMockWallet({ dir, relay: relayUrl }), Error, String(relayUrl));
});

test('a paid invoice proves itself, and the same hash is never paid twice', async (t) => {
  const { wallet, pay, client, secret } = await world(t);
  const { invoice, paymentHash } = wallet.run('invoice', { sats: 1000 });
  assert.equal(decodeInvoice(invoice).amountMsat, 1_000_000);
  const paid = await pay(invoice);
  assert.equal(await sha256(paid.preimage), paymentHash);
  const found = await client.lookupPayment(secret(), paymentHash);
  assert.equal(found.state, 'settled');
  assert.equal(await sha256(found.preimage), paymentHash);
  assert.equal(found.outgoing, true);
  await assert.rejects(pay(invoice), (e) => e.walletCode === 'PAYMENT_FAILED');
  const status = wallet.run('status');
  assert.equal(status.balanceSats, 100000 - 1001);
  assert.equal(status.usedSats, 1001);
  assert.deepEqual(status.duplicates, [{ hash: paymentHash, requests: 2 }]);
  assert.equal(status.payRequests, 2);
});

test('its limit and balance refuse definitely, and it pays nothing it did not make', async (t) => {
  const { wallet, pay, client, secret } = await world(t, { balance: 3000, budget: 2000 });
  assert.equal((await client.budget(secret())).totalMsat, 2_000_000);
  const over = wallet.run('invoice', { sats: 2000 });
  await assert.rejects(pay(over.invoice), (e) => e.walletCode === 'QUOTA_EXCEEDED');
  assert.equal(wallet.run('status').balanceSats, 3000);
  await pay(wallet.run('invoice', { sats: 1500 }).invoice);
  assert.equal((await client.budget(secret())).usedMsat, 1_501_000);
  const poor = await world(t, { balance: 10, budget: 2000 });
  await assert.rejects(
    poor.pay(poor.wallet.run('invoice', { sats: 100 }).invoice),
    (e) => e.walletCode === 'INSUFFICIENT_BALANCE',
  );
  // Another wallet's invoice: a real one, say. Nothing pays, in any mode.
  await assert.rejects(
    pay(poor.wallet.run('invoice', { sats: 1 }).invoice),
    (e) => e.walletCode === 'OTHER',
  );
  assert.equal(wallet.run('status').balanceSats, 3000 - 1501);
});

test('each failure a manual test needs', async (t) => {
  const { wallet, pay, client, secret } = await world(t);
  const lookup = (hash) => client.lookupPayment(secret(), hash);
  // Paid, and the answer lost: only a lookup can tell.
  wallet.run('mode', { pay: 'lost-paid' });
  const lostPaid = wallet.run('invoice', { sats: 10 });
  await assert.rejects(pay(lostPaid.invoice), (e) => e.code === 'timeout' && !e.definite);
  assert.equal((await lookup(lostPaid.paymentHash)).state, 'settled');
  // Not paid, no answer: unknown until it is settled, either way.
  wallet.run('mode', { pay: 'lost-unpaid' });
  const late = wallet.run('invoice', { sats: 20 });
  await assert.rejects(pay(late.invoice), (e) => e.code === 'timeout');
  assert.equal(await lookup(late.paymentHash), null);
  const used = wallet.run('status').usedSats;
  wallet.run('settle', { hash: late.paymentHash });
  assert.equal(wallet.run('status').usedSats, used + 21);
  assert.equal((await lookup(late.paymentHash)).state, 'settled');
  assert.throws(() => wallet.run('settle', { hash: late.paymentHash }), /No lost payment/);
  const never = wallet.run('invoice', { sats: 30 });
  await assert.rejects(pay(never.invoice), (e) => e.code === 'timeout');
  wallet.run('settle', { hash: never.paymentHash, state: 'failed' });
  assert.equal((await lookup(never.paymentHash)).state, 'failed');
  assert.equal(wallet.run('status').usedSats, used + 21);
  // The ambiguous code, and a wrong proof.
  wallet.run('mode', { pay: 'payment-failed' });
  const ambiguous = wallet.run('invoice', { sats: 40 });
  await assert.rejects(pay(ambiguous.invoice), (e) => e.walletCode === 'PAYMENT_FAILED');
  wallet.run('mode', { pay: 'bad-proof' });
  const forged = wallet.run('invoice', { sats: 50 });
  assert.notEqual(await sha256((await pay(forged.invoice)).preimage), forged.paymentHash);
  // Lookups going unanswered.
  wallet.run('mode', { lookup: 'silent' });
  await assert.rejects(lookup(forged.paymentHash), (e) => e.code === 'timeout');
  assert.throws(() => wallet.run('mode', { pay: 'nonsense' }), /--pay/);
  assert.equal(wallet.run('status').duplicates.length, 0);
});

test('the kinds a connection page must tell apart', async (t) => {
  const inspect = async (kind) => {
    const { client, wallet } = await world(t, { kind });
    const scope = kind === 'receive' ? 'receive' : 'spend';
    return client.inspect({ ...wallet.secret, scope });
  };
  assert.ok((await inspect('spend')).budget.totalMsat > 0);
  assert.ok(await inspect('receive'));
  await assert.rejects(inspect('no-limit'), (e) => e.code === 'budget');
  await assert.rejects(inspect('extra-power'), (e) => e.code === 'spending');
});

test('a restart is the same wallet, and what the relay kept is not acted on again', async (t) => {
  const local = await relay();
  defer(t, () => local.close());
  const dir = tempDir(t, 'mock-restart');
  const first = await startMockWallet({ dir, relay: local.url });
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [local.url] });
  const secret = { ...first.secret, scope: 'spend' };
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { invoice, paymentHash } = first.run('invoice', { sats: 100 });
  first.run('mode', { pay: 'lost-unpaid' });
  await assert.rejects(
    client.pay(secret, invoice, { timeoutMs: 200 }),
    (e) => e.code === 'timeout',
  );
  await first.close();
  await assert.rejects(
    startMockWallet({ dir, relay: local.url, kind: 'receive' }),
    /already holds a wallet/,
  );
  const second = await startMockWallet({ dir, relay: local.url });
  defer(t, () => second.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(second.uri, first.uri);
  const status = second.run('status');
  assert.equal(second.kind, 'spend');
  assert.equal(status.balanceSats, 100000);
  assert.equal(status.payRequests, 1, 'the stored request was not handled again');
  assert.equal(status.mode.pay, 'lost-unpaid');
  second.run('settle', { hash: paymentHash });
  second.run('mode', { pay: 'ok' });
  assert.equal((await client.lookupPayment(secret, paymentHash)).state, 'settled');
});

test('from the command line: the secret stays in a private file, and commands reach the wallet', async (t) => {
  const local = await relay();
  defer(t, () => local.close());
  const dir = tempDir(t, 'mock-cli');
  const cli = (...args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', GUARD, SCRIPT, ...args, '--dir', dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      child.once('exit', (code) => resolve({ code, output }));
    });
  const refused = await cli('serve', '--relay', 'wss://relay.damus.io');
  assert.equal(refused.code, 1);
  assert.match(refused.output, /NWC_LOCAL_TEST_RELAYS may only list/);
  const child = spawn(
    process.execPath,
    ['--import', GUARD, SCRIPT, 'serve', '--relay', local.url, '--dir', dir],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  defer(t, () => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  for (let i = 0; i < 400 && !output.includes('ready'); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(output, /Mock wallet ready/);
  const connection = readFileSync(join(dir, 'connection.txt'), 'utf8').trim();
  const { clientSecret } = parseConnection(connection, { trustedRelays: [local.url] });
  assert.equal(statSync(join(dir, 'connection.txt')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'wallet.json')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const second = await cli('serve', '--relay', local.url);
  assert.match(second.output, /already running/);
  const made = await cli('invoice', '--sats', '25');
  const status = await cli('status');
  assert.equal(JSON.parse(status.output).balanceSats, 100000);
  assert.equal(decodeInvoice(JSON.parse(made.output).invoice).amountMsat, 25000);
  assert.equal((await cli('nonsense')).code, 1);
  for (const shown of [output, made.output, status.output, refused.output, second.output])
    assert.ok(!shown.includes(clientSecret), 'never printed');
  assert.ok(!connection.includes(output.trim()), 'only its path is printed');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
});

test('a request sent while it was stopped still counts toward duplicates, and is not paid', async (t) => {
  const local = await relay();
  defer(t, () => local.close());
  const dir = tempDir(t, 'mock-missed');
  const first = await startMockWallet({ dir, relay: local.url });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [local.url] });
  const secret = { ...first.secret, scope: 'spend' };
  const { invoice, paymentHash } = first.run('invoice', { sats: 100 });
  await client.pay(secret, invoice);
  await first.close();
  await assert.rejects(
    client.pay(secret, invoice, { timeoutMs: 100 }),
    (e) => e.code === 'timeout',
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await startMockWallet({ dir, relay: local.url });
  defer(t, () => second.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  const status = second.run('status');
  assert.equal(status.payRequests, 1);
  assert.equal(status.missedWhileStopped, 1);
  assert.deepEqual(status.duplicates, [{ hash: paymentHash, requests: 2 }]);
  assert.equal(status.usedSats, 101, 'not paid again');
});

test('ready from its first request, and it leaves a folder that is not its own alone', async (t) => {
  const local = await relay();
  defer(t, () => local.close());
  const busy = tempDir(t, 'mock-busy');
  writeFileSync(join(busy, 'notes.txt'), 'mine');
  chmodSync(busy, 0o755);
  await assert.rejects(startMockWallet({ dir: busy, relay: local.url }), /new or empty/);
  assert.equal(statSync(busy).mode & 0o777, 0o755);
  // Nothing happens between the subscription and being able to pay.
  const dir = tempDir(t, 'mock-ready');
  const wallet = await startMockWallet({ dir, relay: local.url });
  defer(t, () => wallet.close());
  const client = new NwcClient({ timeoutMs: 400, trustedRelays: [local.url] });
  const { invoice } = wallet.run('invoice', { sats: 5 });
  await client.pay({ ...wallet.secret, scope: 'spend' }, invoice);
  assert.equal(wallet.run('status').payRequests, 1);
});
