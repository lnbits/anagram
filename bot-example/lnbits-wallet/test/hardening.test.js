// Regressions from an independent review: what a hostile relay, wallet or stranger could do.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { WebSocketServer } from 'ws';
import { walletsKeyboard } from '../buttons.js';
import { loadConfig } from '../config.js';
import { BOLT11, LNbitsError } from '../lnbits.js';
import { Origins } from '../net-guard.js';
import { DEFAULTS, PaymentWatcher } from '../notify.js';
import { NwcClient } from '../nwc.js';
import { parseKeyboard } from '../vendor/botKeyboardProtocol.ts';
import { defer } from './helpers.js';
import { relay } from './relay.js';
import { nwcService } from './nwc-server.js';

async function world(t, timeoutMs = 400) {
  const local = await relay();
  defer(t, () => local.close());
  const wallet = await nwcService(local.url);
  defer(t, () => wallet.close());
  return { local, wallet, client: new NwcClient({ timeoutMs, trustedRelays: [local.url] }) };
}

// A relay that answers everything with the given frames.
async function hostileRelay(t, frames) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.on('message', () => {
      for (const frame of frames) socket.send(frame);
    });
  });
  defer(t, () => new Promise((resolve) => wss.close(resolve)));
  return `ws://127.0.0.1:${wss.address().port}/`;
}

test('whatever a relay sends cannot throw out of a socket handler', async (t) => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const url = await hostileRelay(t, [
    'null',
    '7',
    '"x"',
    '{}',
    '[]',
    '[null]',
    '["EVENT"]',
    '["EVENT","r",null]',
    '["EVENT","i",7]',
    'not json',
  ]);
  const client = new NwcClient({ timeoutMs: 150, trustedRelays: [url] });
  const secret = { walletPubkey: 'a'.repeat(64), clientSecret: '1'.repeat(64), relays: [url] };
  await assert.rejects(client.request(secret, 'get_balance'), (e) => e instanceof LNbitsError);
  assert.equal(await client.info(secret, { timeoutMs: 150 }), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(uncaught, []);
});

test('error codes naming built-in properties are just unknown errors', async (t) => {
  const { wallet, client } = await world(t);
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  for (const code of ['toString', 'hasOwnProperty', '__proto__', 'constructor', 'valueOf']) {
    wallet.errors = { get_balance: code };
    await assert.rejects(
      client.request(wallet.secret, 'get_balance'),
      (error) => error instanceof LNbitsError && error.code === 'unavailable',
      code,
    );
  }
  assert.deepEqual(uncaught, []);
});

test('absurd wallet timestamps are malformed rows, and never reach a date or a cursor', async (t) => {
  const { wallet, client } = await world(t);
  const row = (settled_at, created_at = 1) => ({
    type: 'incoming',
    state: 'settled',
    amount: 1000,
    payment_hash: randomBytes(32).toString('hex'),
    created_at,
    settled_at,
  });
  wallet.transactions = [row(9007199254740991), row(1, 9007199254740991), row(-5)];
  const read = await client.incoming(wallet.secret);
  assert.equal(read.malformed, 3);
  assert.deepEqual(read.payments, []);
  await assert.rejects(client.payments(wallet.secret, 5), (e) => e.code === 'bad_response');
  wallet.transactions = [row(Math.floor(Date.now() / 1000))];
  assert.equal((await client.incoming(wallet.secret)).payments.length, 1);
});

test('a request cancelled while waiting for a slot never goes out', async (t) => {
  const { wallet } = await world(t);
  const client = new NwcClient({ timeoutMs: 300, trustedRelays: [wallet.relayUrl] });
  wallet.mode = 'silent';
  // Fill every slot open to routine requests with wallets that never answer.
  const fillers = Array.from({ length: 24 }, () => ({
    ...wallet.secret,
    walletPubkey: getPublicKey(generateSecretKey()),
  }));
  const running = fillers.map((secret) => client.request(secret, 'get_balance').catch(() => {}));
  const abort = new AbortController();
  const queued = client.pay({ ...wallet.secret, scope: 'spend' }, 'lnbc1', {
    signal: abort.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.waiting.length, 1, 'it is waiting');
  abort.abort();
  await assert.rejects(queued, (e) => e.code === 'unavailable' && e.definite);
  assert.equal(client.waiting.length, 0);
  await Promise.all(running);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!wallet.requests.some((r) => r.method === 'pay_invoice'), 'nothing reached the wallet');
  assert.equal(client.active, 0, 'every slot came back');
});

test('one silent wallet cannot use up everyone else’s slots', async (t) => {
  const { wallet } = await world(t);
  const client = new NwcClient({ timeoutMs: 200, trustedRelays: [wallet.relayUrl] });
  wallet.mode = 'silent';
  const held = [1, 2, 3].map(() => client.request(wallet.secret, 'get_balance').catch((e) => e));
  await assert.rejects(
    client.request(wallet.secret, 'get_balance'),
    (e) => e.code === 'busy' && e.definite,
  );
  assert.equal(client.active, 3);
  await Promise.all(held);
  assert.equal(client.perWallet.size, 0, 'counted back down');
});

test('a connection that gains power is noticed by the regular check too, per connection', async (t) => {
  const { wallet, client } = await world(t);
  await client.incoming(wallet.secret);
  const other = new NwcClient({ timeoutMs: 400, trustedRelays: [wallet.relayUrl] });
  wallet.methods = [...wallet.methods, 'pay_invoice'];
  await assert.rejects(other.incoming(wallet.secret), (e) => e.code === 'admin_key');
  const [checked] = client.checked.keys();
  const clientPubkey = getPublicKey(Buffer.from(wallet.clientSecret, 'hex'));
  assert.equal(
    checked,
    `${wallet.walletPubkey}:${clientPubkey}`,
    'per connection, not per service',
  );
});

test('an origin the operator stopped allowing fails like an unreachable server', async () => {
  const origins = new Origins({ defaultUrl: 'https://main.example' });
  const client = origins.client('http://192.168.1.5/');
  await assert.rejects(
    client.wallet('a'.repeat(32)),
    (e) => e instanceof LNbitsError && e.definite,
  );
  await assert.rejects(client.incoming('a'.repeat(32)), (e) => e.code === 'unavailable');
  const open = new Origins({ defaultUrl: 'https://main.example', allowed: '*' });
  await assert.rejects(
    open.client('https://10.0.0.1/').payments('x'),
    (e) => e instanceof LNbitsError,
  );
});

test('the wallets card stays valid at the most wallets allowed, and beyond', () => {
  const env = { LNBITS_URL: 'https://l.example' };
  assert.equal(loadConfig({ ...env, MAX_CONNECTIONS_PER_USER: '7' }).maxConnections, 7);
  assert.throws(() => loadConfig({ ...env, MAX_CONNECTIONS_PER_USER: '8' }), /from 1 to 7/);
  const wallets = Array.from({ length: 12 }, (_, i) => ({
    id: i.toString(16).padStart(32, '0'),
    label: `W${i}`,
    active: i === 0,
  }));
  assert.ok(parseKeyboard(walletsKeyboard(wallets.slice(0, 7), { connectable: true })));
  assert.ok(parseKeyboard(walletsKeyboard(wallets, { connectable: true })));
});

const hostile = async (t, eoses) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const fixture = { url: `ws://127.0.0.1:${server.address().port}/`, events: [] };
  server.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw);
      if (frame[0] === 'REQ')
        for (let i = 0; i < eoses; i++) socket.send(JSON.stringify(['EOSE', frame[1]]));
      if (frame[0] === 'EVENT') fixture.events.push(frame[1].id);
    });
  });
  defer(t, () => {
    for (const socket of server.clients) socket.terminate();
    return new Promise((resolve) => server.close(resolve));
  });
  return fixture;
};
const silentSecret = (relays) => ({
  walletPubkey: getPublicKey(generateSecretKey()),
  clientSecret: Buffer.from(generateSecretKey()).toString('hex'),
  relays,
  scope: 'spend',
});

test('repeated EOSE cannot multiply a request, and an invoice is asked for on one relay', async (t) => {
  const relays = [await hostile(t, 3), await hostile(t, 3), await hostile(t, 3)];
  const urls = relays.map((r) => r.url);
  const client = new NwcClient({ timeoutMs: 300, trustedRelays: urls });
  const counts = () => relays.map((r) => r.events.length);
  await client
    .createInvoice(silentSecret(urls), { sats: 10, memo: '', expiry: 60 })
    .catch(() => {});
  assert.equal(
    counts().reduce((a, b) => a + b),
    1,
    'one invoice, one relay',
  );
  for (const r of relays) r.events.length = 0;
  await client.request(silentSecret(urls), 'get_balance').catch(() => {});
  assert.deepEqual(counts(), [1, 1, 1], 'a read goes on each relay, once');
});

test('silent wallets leave slots for payments, and nobody waits for a slot for ever', async (t) => {
  const relay = await hostile(t, 1);
  const client = new NwcClient({ timeoutMs: 500, trustedRelays: [relay.url] });
  const routine = Array.from({ length: 60 }, () =>
    client.request(silentSecret([relay.url]), 'get_balance').then(
      () => 'answered',
      (error) => error.code,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.active, 24, 'routine requests stop short of every slot');
  assert.equal(client.waiting.length, 36);
  const urgent = client.urgent(() =>
    client.pay(silentSecret([relay.url]), 'lnbc1', { timeoutMs: 300 }).catch((error) => error),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.active, 25, 'a payment goes straight to a free slot');
  const paying = await urgent;
  assert.equal(paying.code, 'timeout', 'it did go out');
  assert.equal(paying.definite, false);
  const results = await Promise.all(routine);
  assert.ok(results.includes('busy'), 'those left waiting are told, certainly and in time');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.active, 0, 'every slot came back');
  assert.equal(client.waiting.length, 0);
});

test('stored notification state is bounded across all wallets, and spares recent payments', () => {
  const [SMALL, FAKE_ONE, FAKE_TWO, BURST] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(32));
  const time = Date.now();
  const WINDOW = DEFAULTS.overlapMs;
  const fill = (payments, ref, count, at) => {
    payments[ref] = { owner: 'a'.repeat(64), baselineAt: 0, cursor: time, known: {} };
    for (let i = 0; i < count; i++) payments[ref].known[randomBytes(32).toString('hex')] = at + i;
  };
  const size = (payments, ref) => Object.keys(payments[ref].known).length;
  const run = (payments, maxKnownTotal, ref) =>
    new PaymentWatcher({ state: { payments } }, { maxKnownTotal }).remember(payments[ref], []);

  // Old hashes go from the heaviest, level by level.
  let payments = {};
  fill(payments, SMALL, 10, time - WINDOW - 5000);
  fill(payments, FAKE_ONE, 40, time - WINDOW - 5000);
  fill(payments, FAKE_TWO, 40, time - WINDOW - 5000);
  const oldest = Object.keys(payments[FAKE_ONE].known)[0];
  run(payments, 50, FAKE_ONE);
  assert.equal(size(payments, SMALL), 10, 'an ordinary history is untouched');
  assert.equal(size(payments, FAKE_ONE), 20);
  assert.equal(size(payments, FAKE_TWO), 20, 'nobody pays for all of it');
  assert.equal(payments[FAKE_ONE].known[oldest], undefined, 'the oldest go first');

  // The heavier wallet comes down, and an equal share is untouched, recent or not.
  payments = {};
  fill(payments, BURST, 60, time - 1000);
  fill(payments, FAKE_ONE, 100, time - WINDOW - 5000);
  run(payments, 120, FAKE_ONE);
  assert.equal(size(payments, BURST), 60);
  assert.equal(size(payments, FAKE_ONE), 60);

  // Fakes holding only recent hashes cannot make an honest wallet pay for them: it loses nothing
  // up to an equal share, old hashes included.
  payments = {};
  fill(payments, SMALL, 60, time - WINDOW - 5000);
  fill(payments, FAKE_ONE, 500, time - 1000);
  fill(payments, FAKE_TWO, 500, time - 1000);
  run(payments, 300, FAKE_ONE);
  assert.equal(size(payments, SMALL), 60);
  assert.equal(size(payments, FAKE_ONE) + size(payments, FAKE_TWO), 240);

  // It is a true total, however many wallets there are.
  payments = {};
  const refs = Array.from({ length: 300 }, () => randomBytes(16).toString('hex'));
  for (const ref of refs) fill(payments, ref, 200, time - 1000);
  run(payments, 50000, refs[0]);
  assert.equal(
    refs.reduce((sum, ref) => sum + size(payments, ref), 0),
    50000,
  );
});

test('an invoice from a server cannot be made enormous', () => {
  const tail = '1'.padEnd(3, 'q') + 'q'.repeat(200);
  assert.ok(BOLT11.test(`lnbc${'1'.repeat(20)}${tail}`));
  assert.ok(!BOLT11.test(`lnbc${'1'.repeat(21)}${tail}`));
  assert.ok(!BOLT11.test(`lnbc${'1'.repeat(255000)}${tail}`));
});

test('the cap on all wallets stays quick, even far over it', () => {
  const payments = {};
  const time = Date.now() - DEFAULTS.overlapMs - 5000;
  for (let i = 0; i < 1000; i++) {
    const ref = randomBytes(16).toString('hex');
    payments[ref] = { owner: 'a'.repeat(64), baselineAt: 0, cursor: Date.now(), known: {} };
    for (let n = 0; n < 55; n++) payments[ref].known[randomBytes(32).toString('hex')] = time + n;
  }
  const started = Date.now();
  const watcher = new PaymentWatcher({ state: { payments } }, { maxKnownTotal: 50000 });
  watcher.remember(Object.values(payments)[0], []);
  const total = Object.values(payments).reduce((sum, e) => sum + Object.keys(e.known).length, 0);
  assert.equal(total, 50000);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('a Refresh is routine: only a payment and its own checks are urgent', () => {
  const source = readFileSync(new URL('../send.js', import.meta.url), 'utf8');
  const uses = [...source.matchAll(/this\.#urgent\(/g)];
  assert.equal(uses.length, 3, 'asking before paying, paying, and the checks after it');
  assert.match(
    source,
    /settled = await this\.#urgent\(bot\.api\(lease\), \(\) => this\.#reconcile/,
  );
});
