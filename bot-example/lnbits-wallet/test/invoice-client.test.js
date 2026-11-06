// LNbits client: invoice creation and lookup, and which failures are certain.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LNbitsClient, LNbitsError } from '../lnbits.js';
import { ALICE_KEY, BOB_KEY, defer } from './helpers.js';
import { closedPort, lnbitsServer, payment } from './lnbits-server.js';

async function mock(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'alice', balance: 0, payments: [] },
    [BOB_KEY]: { name: 'bob', balance: 0, payments: [] },
  });
  defer(t, () => server.close());
  return server;
}
const ext = () => `alw-${randomUUID()}`;
const request = (externalId = ext()) => ({ sats: 1000, memo: 'coffee', expiry: 3600, externalId });
const outcome = (definite, code) => (e) =>
  e instanceof LNbitsError && e.definite === definite && (!code || e.code === code);

test('one POST with integers only, the invoice key, and a validated 201 answer', async (t) => {
  const server = await mock(t);
  const lnbits = new LNbitsClient({ url: server.url });
  const externalId = ext();
  const invoice = await lnbits.createInvoice(ALICE_KEY, request(externalId));
  assert.equal(server.posts.length, 1);
  const [post] = server.posts;
  assert.equal(post.path, '/api/v1/payments');
  assert.equal(post.key, ALICE_KEY);
  assert.deepEqual(post.body, {
    out: false,
    amount: 1000,
    unit: 'sat',
    memo: 'coffee',
    expiry: 3600,
    external_id: externalId,
  });
  assert.equal(invoice.amountMsat, 1_000_000);
  assert.equal(invoice.bolt11, server.created[0].bolt11);
  assert.equal(invoice.paymentHash, server.created[0].payment_hash);
  for (const bad of [0, -1, 1.5, '1000', NaN])
    await assert.rejects(lnbits.createInvoice(ALICE_KEY, { ...request(), sats: bad }), RangeError);
  await assert.rejects(
    lnbits.createInvoice(ALICE_KEY, { ...request(), externalId: 'x' }),
    RangeError,
  );
  assert.equal(server.posts.length, 1, 'invalid input never reaches LNbits');
});

test('certain failures: rejected key, 400, 520, refused connection', async (t) => {
  const server = await mock(t);
  const lnbits = new LNbitsClient({ url: server.url });
  await assert.rejects(lnbits.createInvoice('c'.repeat(32), request()), outcome(true, 'rejected'));
  for (const status of [400, 520]) {
    server.create = status;
    await assert.rejects(lnbits.createInvoice(ALICE_KEY, request()), outcome(true, 'refused'));
  }
  const down = new LNbitsClient({ url: await closedPort() });
  await assert.rejects(down.createInvoice(ALICE_KEY, request()), outcome(true, 'unavailable'));
});

test('uncertain outcomes: timeout, dropped connection, server error, redirect, bad body', async (t) => {
  const server = await mock(t);
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 200 });
  for (const [mode, code] of [
    ['hang', 'timeout'],
    ['store-hang', 'timeout'],
    ['store-drop', 'unavailable'],
    [500, 'unavailable'],
  ]) {
    server.create = mode;
    await assert.rejects(
      lnbits.createInvoice(ALICE_KEY, request()),
      outcome(false, code),
      String(mode),
    );
  }
  server.create = 'ok';
  server.next = (record, _req, res) => {
    if (record.method !== 'POST') return undefined;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"amount": 1000000, "bolt11": "not an invoice"}');
    return 'handled';
  };
  await assert.rejects(lnbits.createInvoice(ALICE_KEY, request()), outcome(false, 'bad_response'));
  server.next = (record, _req, res) => {
    if (record.method !== 'POST') return undefined;
    res.writeHead(307, { location: 'http://127.0.0.1:9/api/v1/payments' });
    res.end();
    return 'handled';
  };
  await assert.rejects(lnbits.createInvoice(ALICE_KEY, request()), outcome(false, 'bad_response'));
  server.next = undefined;
  server.create = 'wrong-amount';
  await assert.rejects(lnbits.createInvoice(ALICE_KEY, request()), outcome(false, 'mismatch'));
});

test('lookup matches the external id exactly, per wallet, even when LNbits ignores the filter', async (t) => {
  const server = await mock(t);
  const lnbits = new LNbitsClient({ url: server.url });
  const externalId = ext();
  const created = await lnbits.createInvoice(ALICE_KEY, request(externalId));
  await lnbits.createInvoice(ALICE_KEY, request()); // a different request
  server.wallets[ALICE_KEY].payments.push(payment({ amount: 5000, bolt11: 'lnbc1...' }));
  const found = await lnbits.findInvoices(ALICE_KEY, externalId);
  assert.deepEqual(
    found.map((i) => i.paymentHash),
    [created.paymentHash],
  );
  assert.deepEqual(server.requests.at(-1).query, { external_id: externalId, limit: '10' });
  assert.deepEqual(
    await lnbits.findInvoices(BOB_KEY, externalId),
    [],
    'another wallet sees nothing',
  );
  assert.deepEqual(await lnbits.findInvoices(ALICE_KEY, ext()), []);
  // LNbits drops filters it does not understand and returns every payment.
  server.ignoreFilters = true;
  assert.deepEqual(await lnbits.findInvoices(ALICE_KEY, ext()), [], 'no exact match, no result');
  assert.equal((await lnbits.findInvoices(ALICE_KEY, externalId)).length, 1);
  await assert.rejects(lnbits.findInvoices(ALICE_KEY, 'alw-%'), RangeError);
});
