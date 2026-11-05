// Regressions from the M5 review: each test fails on the code before its fix.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import { LNbitsClient, LNbitsError } from '../lnbits.js';
import { Wallets } from '../wallets.js';
import { walletRef } from '../notify.js';
import { now } from '../vendor/runtime.js';
import { ConfigurationError } from '../vendor/runtime.js';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  fakeNet,
  npub,
  repliesFor,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer, payment } from './lnbits-server.js';

const FAST = { triggerDelayMs: 10, recheckMs: 120, periodicMs: 60000, backoffMs: [20, 200] };
async function mockLNbits(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'alice', balance: 0, payments: [] },
    [BOB_KEY]: { name: 'bob', balance: 0, payments: [] },
  });
  defer(t, () => server.close());
  return server;
}
const client = (server, options = {}) =>
  new LNbitsClient({ url: server.url, timeoutMs: 400, ...options });
async function waitFor(condition, message, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const quiet = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const notices = (bot, key) => [
  ...new Map(
    [...bot.net.sent, ...bot.state.outbox.map((i) => i.event)].flatMap((event) => {
      try {
        const m = unwrapEvent(event, key);
        return m.pubkey === bot.pubkey && !m.tags.some((t) => t[0] === 'e') ? [[m.id, m]] : [];
      } catch {
        return [];
      }
    }),
  ).values(),
];

test('#1 a public key that is not on the curve is refused at load, not at first send', () => {
  for (const id of ['00'.repeat(32), '11'.repeat(32), 'ff'.repeat(32)])
    assert.throws(
      () => new Wallets([[id, { invoiceKey: ALICE_KEY }]]),
      (e) => e instanceof ConfigurationError && /not a valid Nostr public key/.test(e.message),
    );
  assert.equal(new Wallets([[npub(alice), { invoiceKey: ALICE_KEY }]]).size, 1);
});

test('#2 "created" reaches disk only together with the reply that carries the invoice', async (t) => {
  const server = await mockLNbits(t);
  const { bot, dir } = setup(t, { lnbits: client(server), checkDelays: [0.05] });
  // Hold the relay lookup that precedes the reply; meanwhile something else saves state.
  let release;
  const gate = new Promise((r) => (release = r));
  const inbox = bot.inbox.bind(bot);
  bot.inbox = async (pubkey) => {
    await gate;
    return inbox(pubkey);
  };
  await bot.directMessage(dm(alice, '/invoice 77', bot), { tags: [] });
  await waitFor(() => server.created.length === 1, 'invoice created in LNbits');
  await quiet(50);
  bot.save(); // e.g. the outbox flush or another person's message
  const during = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
  assert.deepEqual(
    during.invoices.map((r) => r.state),
    ['sending'],
    'not "created" without its reply',
  );
  assert.equal(during.outbox.length, 0);
  release();
  await settle(bot);
  const after = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
  assert.deepEqual(
    after.invoices.map((r) => r.state),
    ['created'],
  );
  assert.equal(after.outbox.length, 1, 'the reply is in the same save');
});

test('#3 a wallet moved to another person starts a new baseline for them', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'regress-move');
  const first = setup(t, {
    dir,
    lnbits: client(server),
    notifications: FAST,
    wallets: new Wallets([[npub(alice), { label: 'Alice', invoiceKey: ALICE_KEY }]]),
  });
  await first.bot.start();
  await waitFor(
    () => first.bot.state.payments[walletRef(getPublicKey(alice), ALICE_KEY)],
    'baseline',
  );
  await first.bot.close();
  // Payments Alice received before the wallet was given to Bob.
  for (let i = 1; i <= 3; i++) server.settle(ALICE_KEY, { sats: i, frames: 0 });
  const second = setup(t, {
    dir,
    lnbits: client(server),
    notifications: FAST,
    wallets: new Wallets([[npub(bob), { label: 'Bob', invoiceKey: ALICE_KEY }]]),
  });
  await second.bot.start();
  await waitFor(
    () => second.bot.state.payments[walletRef(getPublicKey(bob), ALICE_KEY)],
    'Bob baseline',
  );
  await quiet();
  assert.equal(notices(second.bot, bob).length, 0, 'Alice’s past payments are not sent to Bob');
  assert.equal(
    second.bot.state.payments[walletRef(getPublicKey(alice), ALICE_KEY)],
    undefined,
    'old entry pruned',
  );
});

test('#4 a shutdown during start leaves no timers behind and saves nothing after the lock', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = setup(t, { lnbits: client(server), notifications: FAST });
  const starting = bot.start();
  await bot.close();
  await starting;
  assert.equal(bot.recheckTimer, undefined, 'no recheck timer');
  assert.equal(bot.watcher.watched.size, 0, 'nothing watched');
  await quiet(200);
  assert.equal(server.upgrades, 0, 'no socket opened after stopping');
});

test('#5 requests that waited for a slot leave no abort listeners behind', async (t) => {
  const server = await mockLNbits(t);
  const lnbits = client(server, { maxConcurrent: 1 });
  const controller = new AbortController();
  for (let round = 0; round < 5; round++)
    await Promise.all(
      Array.from({ length: 6 }, () => lnbits.wallet(ALICE_KEY, { signal: controller.signal })),
    );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('#7 lookups that cannot reach LNbits are not checks: an outage does not force review', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = setup(t, {
    lnbits: client(server, { timeoutMs: 200 }),
    checkDelays: [0.03, 0.03],
  });
  server.create = 'store-hang';
  server.next = (record, _req, res) => {
    if (record.query.external_id === undefined) return undefined;
    res.writeHead(502);
    res.end('down');
    return 'handled';
  };
  await bot.directMessage(dm(alice, '/invoice 31', bot), { tags: [] });
  await quiet(1200); // many lookups fail meanwhile
  assert.deepEqual(
    bot.state.invoices.map((r) => r.state),
    ['uncertain'],
    'still being checked',
  );
  assert.equal(bot.state.invoices[0].checks, 0);
  server.next = undefined;
  await waitFor(() => bot.state.invoices[0].state === 'created', 'found once LNbits answers', 6000);
  assert.equal(server.posts.length, 1);
});

test('#8 a socket that is accepted and closed at once is retried with backoff', async (t) => {
  const server = await mockLNbits(t);
  server.wsCloseOnOpen = true;
  const { bot } = setup(t, {
    lnbits: client(server),
    notifications: { ...FAST, backoffMs: [50, 400] },
  });
  await bot.start();
  await bot.checking;
  await quiet(1500);
  // Two linked wallets, so two sockets. With backoff (50, 100, 200, 400, 400 ms...) that is
  // about 6 attempts each; reset on every open it was one every ~50 ms, about 30 each.
  assert.ok(server.upgrades >= 4 && server.upgrades <= 16, `attempts: ${server.upgrades}`);
});

test('#9 replies relays did not accept for a day are reported when dropped', async (t) => {
  const net = fakeNet();
  net.fail = true;
  const { bot, logs } = setup(t, { net });
  await bot.directMessage(dm(alice, '/help', bot), { tags: [] });
  await settle(bot);
  for (const item of bot.state.outbox) item.queuedAt = now() - 2 * 86400;
  await bot.flush();
  assert.ok(logs.some((l) => /Dropping 1 delivery\(ies\) that relays did not accept/.test(l)));
  assert.equal(bot.state.outbox.length, 0);
});

test('#10 interrupted invoice requests are settled before relay subscriptions start', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'regress-recover');
  const first = setup(t, { dir, lnbits: client(server) });
  const message = dm(alice, '/invoice 5', first.bot);
  first.bot.invoices.add({ requester: getPublicKey(alice), messageId: message.id, sats: 5 });
  first.bot.save();
  await first.bot.close();
  const net = fakeNet();
  const states = [];
  net.watch = () => {
    states.push(JSON.parse(readFileSync(`${dir}/state.json`, 'utf8')).invoices[0].state);
    return () => {};
  };
  const second = setup(t, { dir, net, lnbits: client(server) });
  await second.bot.start();
  assert.ok(states.length > 0 && states.every((s) => s === 'failed'), `states seen: ${states}`);
});

test('#11 a proxy 520 is uncertain (looked up), LNbits’ own 520 is a certain failure', async (t) => {
  const server = await mockLNbits(t);
  const lnbits = client(server);
  const request = () => ({
    sats: 10,
    memo: '',
    expiry: 600,
    externalId: `alw-${crypto.randomUUID()}`,
  });
  server.create = '520-proxy';
  await assert.rejects(
    lnbits.createInvoice(ALICE_KEY, request()),
    (e) => e instanceof LNbitsError && e.status === 520 && e.definite === false,
  );
  server.create = 520;
  await assert.rejects(
    lnbits.createInvoice(ALICE_KEY, request()),
    (e) => e instanceof LNbitsError && e.code === 'refused' && e.definite === true,
  );
  // End to end: the proxy 520 is resolved by lookup, not reported as "nothing created".
  server.create = '520-proxy';
  const { bot } = setup(t, { lnbits, checkDelays: [0.05] });
  await bot.directMessage(dm(alice, '/invoice 12', bot), { tags: [] });
  await waitFor(() => bot.state.invoices[0]?.state === 'created', 'found by external id');
  await settle(bot);
  assert.match(repliesFor(bot, alice).at(-1).content, /^LNbits has now confirmed your invoice/);
});

test('#12 /history never lists unsettled rows, even if LNbits ignores the status filter', async (t) => {
  const server = await mockLNbits(t);
  server.wallets[ALICE_KEY].payments.push(
    payment({ amount: 1000, memo: 'settled', status: 'success', hash: 'aa'.repeat(32) }),
    payment({ amount: 2000, memo: 'still pending', status: 'pending', hash: 'bb'.repeat(32) }),
    payment({ amount: 3000, memo: 'failed one', status: 'failed', hash: 'cc'.repeat(32) }),
  );
  server.next = (record, _req, res) => {
    if (record.path !== '/api/v1/payments') return undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(server.wallets[ALICE_KEY].payments)); // filters ignored
    return 'handled';
  };
  const history = await client(server).payments(ALICE_KEY, 10);
  assert.deepEqual(
    history.map((p) => p.memo),
    ['settled'],
  );
});
