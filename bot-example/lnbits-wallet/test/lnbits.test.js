// The LNbits client against a local mock server: shapes, failures and what errors reveal.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LNbitsClient, LNbitsError } from '../lnbits.js';
import { ALICE_KEY, BOB_KEY, defer } from './helpers.js';
import { closedPort, lnbitsServer, payment } from './lnbits-server.js';

const ADMIN_KEY = 'ad000000000000000000000000000003';
const THIRD_KEY = 'c0ffee00000000000000000000000004';
async function mock(t, extra = {}) {
  const server = await lnbitsServer({
    [ALICE_KEY]: {
      name: 'alice',
      balance: 2_100_500,
      payments: [
        payment({ amount: 2_100_000, memo: 'older', time: '2026-10-30T10:00:00+00:00' }),
        payment({ amount: -7_000, fee: -1_000, memo: 'newer', time: '2026-10-31T10:00:00+00:00' }),
        payment({ amount: 50_000, memo: 'pending', status: 'pending' }),
        payment({ amount: 9_000, memo: 'failed', status: 'failed' }),
      ],
    },
    [BOB_KEY]: { name: 'bob', balance: 0, payments: [] },
    [ADMIN_KEY]: { name: 'admin', balance: 1000, payments: [], admin: true },
    ...extra,
  });
  defer(t, () => server.close());
  return server;
}
const client = (server, options = {}) =>
  new LNbitsClient({ url: server.url, timeoutMs: 1000, ...options });
const code = (expected) => (error) => error instanceof LNbitsError && error.code === expected;

test('balance and history use the invoice key header, fixed paths and a bounded query', async (t) => {
  const server = await mock(t);
  const lnbits = client(server);
  assert.deepEqual(await lnbits.wallet(ALICE_KEY), { balanceMsat: 2_100_500 });
  const history = await lnbits.payments(ALICE_KEY, 5);
  assert.deepEqual(
    history.map((p) => [p.amountMsat, p.feeMsat, p.memo]),
    [
      [-7_000, 1_000, 'newer'],
      [2_100_000, 0, 'older'],
    ],
  );
  assert.equal(history[0].time, Date.parse('2026-10-31T10:00:00+00:00') / 1000);
  assert.deepEqual(Object.keys(history[0]).sort(), ['amountMsat', 'feeMsat', 'memo', 'time']);
  assert.deepEqual(await lnbits.payments(BOB_KEY, 20), []);
  assert.deepEqual(
    server.requests.map((r) => [r.method, r.path, r.key]),
    [
      ['GET', '/api/v1/wallet', ALICE_KEY],
      ['GET', '/api/v1/payments', ALICE_KEY],
      ['GET', '/api/v1/payments', BOB_KEY],
    ],
  );
  assert.deepEqual(server.requests[1].query, {
    limit: '5',
    sortby: 'time',
    direction: 'desc',
    status: 'success',
  });
  await assert.rejects(lnbits.payments(ALICE_KEY, 21), RangeError);
  await assert.rejects(lnbits.payments(ALICE_KEY, 0), RangeError);
});

test('an admin key is detected from the wallet response and refused', async (t) => {
  const server = await mock(t);
  await assert.rejects(client(server).wallet(ADMIN_KEY), code('admin_key'));
});

test('unknown, reset and refused keys are "rejected"; malformed keys are never sent', async (t) => {
  const server = await mock(t);
  const lnbits = client(server);
  await assert.rejects(
    lnbits.wallet('c'.repeat(32)),
    (e) => code('rejected')(e) && e.status === 404,
  );
  server.next = (_r, _req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"detail":"Invalid adminkey."}');
    return 'handled';
  };
  await assert.rejects(lnbits.wallet(ALICE_KEY), (e) => code('rejected')(e) && e.status === 403);
  server.next = undefined;
  const before = server.requests.length;
  for (const key of ['', 'short', ALICE_KEY.toUpperCase(), `${ALICE_KEY}\r\nX-Evil: 1`, undefined])
    await assert.rejects(lnbits.wallet(key), code('rejected'));
  assert.equal(server.requests.length, before, 'nothing malformed reached the server');
});

test('timeouts, refused connections, dropped connections and server errors are classified', async (t) => {
  const server = await mock(t);
  server.next = (_r, _req, res) => {
    setTimeout(() => res.destroyed || res.end('{}'), 3000);
    return 'handled';
  };
  const started = Date.now();
  await assert.rejects(client(server, { timeoutMs: 200 }).wallet(ALICE_KEY), code('timeout'));
  assert.ok(Date.now() - started < 1500);
  await assert.rejects(
    new LNbitsClient({ url: await closedPort() }).wallet(ALICE_KEY),
    code('unavailable'),
  );
  server.next = (_r, req) => {
    req.socket.destroy();
    return 'handled';
  };
  await assert.rejects(client(server).wallet(ALICE_KEY), code('unavailable'));
  for (const status of [500, 502, 429]) {
    server.next = (_r, _req, res) => {
      res.writeHead(status);
      res.end('internal details that must not leak');
      return 'handled';
    };
    await assert.rejects(
      client(server).wallet(ALICE_KEY),
      (e) => code('unavailable')(e) && e.status === status,
    );
  }
});

test('redirects are never followed, so the key cannot be forwarded', async (t) => {
  const other = await mock(t);
  const server = await mock(t);
  server.next = (_r, _req, res) => {
    res.writeHead(302, { location: `${other.url}api/v1/wallet` });
    res.end();
    return 'handled';
  };
  await assert.rejects(
    client(server).wallet(ALICE_KEY),
    (e) => code('bad_response')(e) && e.status === 302,
  );
  assert.equal(other.requests.length, 0, 'the other server never saw the key');
});

test('malformed, oversized and unexpected bodies are rejected; extra fields are ignored', async (t) => {
  const server = await mock(t);
  const lnbits = client(server);
  const respond = (body, type = 'application/json') => {
    server.next = (_r, _req, res) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
      return 'handled';
    };
  };
  for (const body of [
    'not json',
    '',
    '[]',
    'null',
    '{"name":"x"}',
    '{"name":"x","balance":"100"}',
    '{"name":"x","balance":-1}',
    '{"name":"x","balance":1.5}',
    '{"name":"x","balance":90071992547409930}',
  ]) {
    respond(body);
    await assert.rejects(lnbits.wallet(ALICE_KEY), code('bad_response'), body);
  }
  respond('{"name":"x","balance":5,"currency":"USD","unexpected":{"nested":true}}');
  assert.deepEqual(await lnbits.wallet(ALICE_KEY), { balanceMsat: 5 });
  respond(`{"name":"x","balance":5,"pad":"${'x'.repeat(300 * 1024)}"}`);
  await assert.rejects(lnbits.wallet(ALICE_KEY), code('bad_response'));
  for (const body of [
    '{"data":[]}',
    '[null]',
    JSON.stringify([{ ...payment({ amount: 1000 }), amount: '1000' }]),
    JSON.stringify([{ ...payment({ amount: 1000 }), time: 'yesterday' }]),
    JSON.stringify([{ ...payment({ amount: 1000 }), memo: { html: '<b>' } }]),
    JSON.stringify([{ ...payment({ amount: 1000 }), payment_hash: 'zz' }]),
  ]) {
    respond(body);
    await assert.rejects(lnbits.payments(ALICE_KEY, 5), code('bad_response'), body);
  }
  // A server that ignores the limit is cut down to it.
  respond(
    JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({
        ...payment({ amount: 1000 + i }),
        surprise: 'field',
      })),
    ),
  );
  assert.equal((await lnbits.payments(ALICE_KEY, 3)).length, 3);
});

test('errors never contain the key, the URL or server text', async (t) => {
  const server = await mock(t);
  const errors = [];
  const capture = (promise) => promise.catch((e) => errors.push(e));
  await capture(client(server).wallet('c'.repeat(32)));
  await capture(client(server).wallet(ADMIN_KEY));
  server.next = (_r, _req, res) => {
    res.writeHead(500);
    res.end(`trace with ${ALICE_KEY}`);
    return 'handled';
  };
  await capture(client(server).wallet(ALICE_KEY));
  await capture(new LNbitsClient({ url: await closedPort() }).wallet(ALICE_KEY));
  assert.equal(errors.length, 4);
  for (const error of errors) {
    const shown = `${error.message} ${error.stack} ${JSON.stringify(error)} ${String(error.cause ?? '')}`;
    for (const secret of [ALICE_KEY, ADMIN_KEY, 'c'.repeat(32), server.url, '127.0.0.1', 'trace'])
      assert.ok(!shown.includes(secret), `${error.code} reveals ${secret}`);
  }
  assert.ok(!JSON.stringify(client(server)).includes(server.url));
});

test('at most maxConcurrent requests run at once; excess waiters are refused; abort works', async (t) => {
  const server = await mock(t);
  let inFlight = 0,
    peak = 0;
  server.next = (_r, _req, res) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"name":"x","balance":1}');
    }, 100);
    return 'handled';
  };
  const lnbits = client(server, { maxConcurrent: 2, maxWaiting: 3 });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => lnbits.wallet(ALICE_KEY)),
  );
  assert.equal(peak, 2);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
  assert.ok(code('busy')(results.find((r) => r.status === 'rejected').reason));
  assert.equal(lnbits.active, 0, 'every slot was released');

  server.next = () => 'handled'; // never answers
  const controller = new AbortController();
  const pending = lnbits.wallet(ALICE_KEY, { signal: controller.signal });
  const waiting = lnbits.wallet(BOB_KEY, { signal: controller.signal });
  const third = lnbits.wallet(BOB_KEY, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  for (const promise of [pending, waiting, third])
    await assert.rejects(promise, code('unavailable'));
  assert.ok(Date.now() - started < 500, 'aborted promptly');
  assert.equal(lnbits.active, 0);
  assert.equal(lnbits.waiting.length, 0);
});

test('only settled incoming rows count, even when LNbits ignores the filters', async (t) => {
  const now = new Date().toISOString();
  const rows = [
    payment({ amount: 1000, memo: 'paid', hash: 'a1'.repeat(32), time: now }),
    payment({ amount: 2000, status: 'pending', hash: 'a2'.repeat(32), time: now }),
    payment({ amount: 3000, status: 'failed', hash: 'a3'.repeat(32), time: now }),
    payment({ amount: -4000, hash: 'a4'.repeat(32), time: now }),
  ];
  const server = await mock(t, { [THIRD_KEY]: { name: 'third', balance: 0, payments: rows } });
  server.ignoreFilters = true;
  const { payments, rows: count } = await client(server).incoming(THIRD_KEY);
  assert.equal(count, 4, 'LNbits returned all of them');
  assert.deepEqual(
    payments.map((p) => p.paymentHash),
    ['a1'.repeat(32)],
  );
});
