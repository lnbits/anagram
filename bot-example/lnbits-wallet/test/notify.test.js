// Incoming payment notifications against a local mock LNbits with real WebSockets.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import { LNbitsClient } from '../lnbits.js';
import { Wallets } from '../wallets.js';
import { walletRef } from '../notify.js';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  fakeNet,
  npub,
  repliesFor,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer, payment } from './lnbits-server.js';

const ADMIN_KEY = 'ad000000000000000000000000000003';
const FAST = {
  triggerDelayMs: 10,
  recheckMs: 120,
  periodicMs: 60000,
  backoffMs: [20, 200],
  overlapMs: 60000,
  pingMs: 60000,
  noticeEveryMs: 0,
};

async function mockLNbits(t, extra = {}) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'alice', balance: 0, payments: [] },
    [BOB_KEY]: { name: 'bob', balance: 0, payments: [] },
    [ADMIN_KEY]: { name: 'spendable', balance: 0, payments: [], admin: true },
    ...extra,
  });
  defer(t, () => server.close());
  return server;
}
async function started(t, server, { notifications = {}, timeoutMs = 400, ...options } = {}) {
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs });
  const ctx = setup(t, { lnbits, notifications: { ...FAST, ...notifications }, ...options });
  await ctx.bot.start();
  await ctx.bot.checking;
  return { lnbits, ...ctx };
}
async function waitFor(condition, message, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
// Lets every scheduled scan run (triggers and the re-check after them).
const quiet = (ms = 400) => new Promise((r) => setTimeout(r, ms));
// Notifications for a key, whether still queued or already published by the bot's flush.
const notices = (bot, key) => {
  const queued = repliesFor(bot, key);
  const published = bot.net.sent.flatMap((event) => {
    try {
      const message = unwrapEvent(event, key);
      return message.pubkey === bot.pubkey ? [message] : [];
    } catch {
      return [];
    }
  });
  const unique = new Map([...published, ...queued].map((m) => [m.id, m]));
  return [...unique.values()]
    .filter((m) => !m.tags.some((t) => t[0] === 'e'))
    .sort((a, b) => a.created_at - b.created_at || a.content.localeCompare(b.content));
};
const scans = (server) => server.requests.filter((r) => r.path === '/api/v1/payments/paginated');
const watching = (server, key) => waitFor(() => server.open(key) === 1, 'socket');
// Alice is linked to ALICE_KEY and Bob to BOB_KEY in these tests (see helpers.linked()).
const OWNER = { [ALICE_KEY]: () => getPublicKey(alice), [BOB_KEY]: () => getPublicKey(bob) };
const baseline = (bot, key) => bot.state.payments[walletRef(OWNER[key](), key)];

test('existing payments are the baseline; one new payment is announced once, to its owner', async (t) => {
  const server = await mockLNbits(t);
  server.wallets[ALICE_KEY].payments.push(
    payment({ amount: 5000, memo: 'before the bot', hash: 'aa'.repeat(32) }),
  );
  const { bot, logs, dir } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  assert.ok(logs.some((l) => /started; 1 recent payment\(s\) are the baseline/.test(l)));
  assert.equal(notices(bot, alice).length, 0, 'history is not announced');

  server.settle(ALICE_KEY, { sats: 21, memo: 'coffee' }); // two identical frames
  await waitFor(() => notices(bot, alice).length === 1, 'notification');
  await quiet();
  const [notice] = notices(bot, alice);
  assert.match(
    notice.content,
    /^Received \(Alice test wallet\): \+21 sats · \d{4}-\d\d-\d\d \d\d:\d\d UTC · coffee$/,
  );
  assert.equal(notices(bot, alice).length, 1, 'duplicate frames: still one');
  assert.equal(notices(bot, bob).length, 0, 'nobody else');
  // Not a reply: a plain NIP-17 message addressed to Alice.
  assert.deepEqual(
    notice.tags.filter((t) => t[0] === 'p'),
    [['p', getPublicKey(alice)]],
  );
  assert.ok(!notice.tags.some((t) => t[0] === 'e'), 'a message of its own');
  const state = readFileSync(`${dir}/state.json`, 'utf8');
  for (const secret of [ALICE_KEY, BOB_KEY, 'api/v1/ws'])
    assert.ok(!state.includes(secret) && !logs.join('\n').includes(secret), 'no key or socket URL');
});

test('pending invoices are announced when they settle; outgoing payments never', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  const invoice = payment({
    amount: 7000,
    memo: 'pending one',
    status: 'pending',
    hash: 'bb'.repeat(32),
    time: new Date().toISOString(),
  });
  server.wallets[ALICE_KEY].payments.push(invoice);
  server.push(ALICE_KEY, JSON.stringify({ wallet_balance: 0, payment: invoice }));
  await quiet();
  assert.equal(notices(bot, alice).length, 0, 'pending is not settled');
  server.pay(ALICE_KEY, 50);
  await quiet();
  assert.equal(notices(bot, alice).length, 0, 'outgoing is not announced');
  server.settlePending(ALICE_KEY, invoice);
  await waitFor(() => notices(bot, alice).length === 1, 'settled');
  assert.match(notices(bot, alice)[0].content, /\+7 sats .* pending one$/);
});

test('unexpected, malformed and oversized frames cannot create a notification', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  const claimed = payment({ amount: 999_000_000, memo: 'claimed', hash: 'cc'.repeat(32) });
  server.push(ALICE_KEY, JSON.stringify({ wallet_balance: 999000, payment: claimed }), 3);
  server.push(ALICE_KEY, 'not json at all');
  server.push(ALICE_KEY, 'x'.repeat(70 * 1024)); // over the 64 KB limit: the socket is closed
  await quiet(500);
  assert.equal(notices(bot, alice).length, 0, 'only the history counts');
  assert.equal(bot.stopped, false);
  await watching(server, ALICE_KEY); // reconnected
  server.settle(ALICE_KEY, { sats: 3 });
  await waitFor(() => notices(bot, alice).length === 1, 'real payment after the noise');
});

test('several wallets: each person hears only about their own; disabled links hear nothing', async (t) => {
  const server = await mockLNbits(t);
  const wallets = new Wallets([
    [npub(alice), { label: 'Alice', invoiceKey: ALICE_KEY }],
    [npub(bob), { label: 'Bob', invoiceKey: BOB_KEY }],
    [npub((await import('./helpers.js')).mallory), { label: 'Spendable', invoiceKey: ADMIN_KEY }],
  ]);
  const { bot, logs } = await started(t, server, { wallets });
  await watching(server, ALICE_KEY);
  await watching(server, BOB_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY) && baseline(bot, BOB_KEY), 'baselines');
  assert.equal(server.open(ADMIN_KEY), 0, 'an admin key is never watched');
  assert.ok(logs.some((l) => /Switched off .*admin key/.test(l)));
  server.settle(ALICE_KEY, { sats: 1, memo: 'for alice only' });
  server.settle(BOB_KEY, { sats: 2, memo: 'for bob only' });
  server.settle(ADMIN_KEY, { sats: 3, memo: 'spendable' });
  await waitFor(() => notices(bot, alice).length === 1 && notices(bot, bob).length === 1, 'both');
  await quiet();
  assert.match(notices(bot, alice)[0].content, /^Received \(Alice\): \+1 sat .* for alice only$/);
  assert.match(notices(bot, bob)[0].content, /^Received \(Bob\): \+2 sats .* for bob only$/);
  const mallory = (await import('./helpers.js')).mallory;
  assert.equal(notices(bot, mallory).length, 0);
  assert.ok(
    scans(server).every((r) => r.key !== ADMIN_KEY),
    'admin key never used for history',
  );
  // Switched off while running: the socket closes and later payments are not announced.
  bot.switchOff(getPublicKey(bob));
  await waitFor(() => server.open(BOB_KEY) === 0, 'socket closed');
  server.settle(BOB_KEY, { sats: 4 });
  await quiet();
  assert.equal(notices(bot, bob).length, 1);
});

test('socket outages and LNbits downtime: missed payments are found later, exactly once', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  // The socket drops and cannot reconnect; a payment settles meanwhile (no frame reaches us).
  server.wsRefuse = true;
  server.dropSockets();
  await quiet(100);
  server.settle(ALICE_KEY, { sats: 10, memo: 'while offline' });
  await quiet(200);
  assert.equal(notices(bot, alice).length, 0);
  server.wsRefuse = false; // reconnect -> catch-up scan
  await waitFor(() => notices(bot, alice).length === 1, 'catch-up after reconnect');
  // LNbits' history fails: nothing is announced and nothing is marked handled.
  server.next = (record, _req, res) => {
    if (record.path !== '/api/v1/payments/paginated') return undefined;
    res.writeHead(502);
    res.end('bad gateway');
    return 'handled';
  };
  server.settle(ALICE_KEY, { sats: 11, memo: 'during downtime' });
  await quiet();
  assert.equal(notices(bot, alice).length, 1);
  assert.ok(
    logs.some((l) => /Payment check for npub1\S+ failed \(unavailable 502\); retrying\./.test(l)),
  );
  // Then it hangs past the client timeout.
  server.next = (record) => (record.path === '/api/v1/payments/paginated' ? 'handled' : undefined);
  server.push(ALICE_KEY, '{}');
  await quiet(700);
  assert.equal(notices(bot, alice).length, 1);
  server.next = undefined;
  server.push(ALICE_KEY, '{}');
  await waitFor(() => notices(bot, alice).length === 2, 'after recovery');
  await quiet();
  assert.match(notices(bot, alice)[1].content, /\+11 sats .* during downtime$/);
  assert.equal(notices(bot, alice).length, 2, 'each payment once');
  assert.equal(bot.stopped, false);
});

test('a malformed history row is skipped and reported; it does not block later payments', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  const bad = server.settle(ALICE_KEY, { sats: 5, frames: 0 });
  bad.updated_at = '2026-11-01T01:15:17'; // no time zone: unreadable, so never announced
  server.push(ALICE_KEY, '{}');
  await quiet();
  assert.equal(notices(bot, alice).length, 0);
  assert.ok(logs.some((l) => /Skipped 1 unreadable payment row\(s\) for npub1/.test(l)));
  // A regression check: one bad row once stopped every later notification of the wallet.
  server.settle(ALICE_KEY, { sats: 6, memo: 'after the bad row' });
  await waitFor(() => notices(bot, alice).length === 1, 'later payment');
  assert.match(notices(bot, alice)[0].content, /\+6 sats .* after the bad row$/);
});

test('a restart catches up on payments missed while the bot was down, once', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'notify-restart');
  const first = await started(t, server, { dir });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(first.bot, ALICE_KEY), 'baseline');
  server.settle(ALICE_KEY, { sats: 1, memo: 'seen live' });
  await waitFor(() => notices(first.bot, alice).length === 1, 'live');
  await first.bot.close();
  server.settle(ALICE_KEY, { sats: 2, memo: 'missed one' });
  server.settle(ALICE_KEY, { sats: 3, memo: 'missed two' });
  assert.equal(notices(first.bot, alice).length, 1);
  const earlier = new Set(notices(first.bot, alice).map((m) => m.id));
  const second = await started(t, server, { dir });
  // Only messages the second run created count: the first run's notice may still be in the
  // persisted outbox, and then the second run publishes that same event (same id).
  const created = () => notices(second.bot, alice).filter((m) => !earlier.has(m.id));
  await waitFor(() => created().length === 1, 'catch-up');
  await quiet();
  const texts = created().map((m) => m.content);
  assert.equal(texts.length, 1, 'one combined message, and "seen live" is not announced again');
  assert.match(
    texts[0],
    /^Received 2 payments \(Alice test wallet\):\n\+2 sats .* missed one\n\+3 sats .* missed two$/,
  );
  assert.ok(!second.logs.some((l) => /baseline/.test(l)), 'no new baseline after a restart');
});

test('a crash between finding a payment and saving loses nothing and repeats nothing', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'notify-crash');
  const first = await started(t, server, { dir });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(first.bot, ALICE_KEY), 'baseline');
  // The process "dies" inside announce(), before its single save.
  let found = 0;
  first.bot.announce = async () => {
    found++;
  };
  const settled = server.settle(ALICE_KEY, { sats: 8, memo: 'crash window' });
  await waitFor(() => found > 0, 'found');
  await first.bot.close();
  const saved = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
  assert.equal(
    saved.payments[walletRef(getPublicKey(alice), ALICE_KEY)].known[settled.payment_hash],
    undefined,
  );
  assert.equal(saved.outbox.length, 0);
  const second = await started(t, server, { dir });
  await waitFor(() => notices(second.bot, alice).length === 1, 'recovered');
  await quiet();
  second.bot.watcher.schedule(second.bot.watcher.watchOf(getPublicKey(alice)), 0);
  await quiet();
  assert.equal(notices(second.bot, alice).length, 1, 'exactly once');
});

test('queued notifications survive a restart and are published unchanged', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'notify-outbox');
  const offline = fakeNet();
  offline.fail = true;
  const first = await started(t, server, { dir, net: offline });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(first.bot, ALICE_KEY), 'baseline');
  server.settle(ALICE_KEY, { sats: 9 });
  await waitFor(() => first.bot.state.outbox.length === 1, 'queued');
  const queued = first.bot.state.outbox.map((i) => i.event.id);
  await first.bot.close();
  const online = fakeNet();
  const second = await started(t, server, { dir, net: online });
  for (const item of second.bot.state.outbox) item.retryAt = 0;
  await second.bot.flush();
  await quiet();
  assert.deepEqual(
    online.sent.filter((e) => e.kind === 1059).map((e) => e.id),
    queued,
  );
  assert.equal(second.bot.state.outbox.length, 0, 'not announced again');
});

test('bounded scans: many payments become one summarized message', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'notify-bounded');
  const notifications = { pageSize: 3, maxPages: 2, maxListed: 4 };
  const first = await started(t, server, { dir, notifications });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(first.bot, ALICE_KEY), 'baseline');
  await first.bot.close();
  for (let i = 1; i <= 8; i++) server.settle(ALICE_KEY, { sats: i, frames: 0 });
  const before = scans(server).length;
  const second = await started(t, server, { dir, notifications });
  await waitFor(() => notices(second.bot, alice).length === 1, 'summary');
  const [text] = notices(second.bot, alice).map((m) => m.content);
  assert.match(text, /^Received 4 payments \(Alice test wallet\):/);
  assert.match(text, /…and 2 earlier payments\. See \/history\./);
  assert.match(text, /More payments arrived than I could check at once/);
  // Every scan stops after maxPages pages: no request ever asks beyond page 2 (offset 3).
  const offsets = scans(server)
    .slice(before)
    .map((r) => Number(r.query.offset));
  assert.ok(offsets.length > 0 && offsets.every((o) => o < 2 * 3), `offsets ${offsets}`);
  assert.ok(second.logs.some((l) => /older ones were summarized/.test(l)));
});

test('an old payment whose row is updated later is not announced as new', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, { notifications: { retentionMs: 60000 } });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  // Created long ago (e.g. labels changed now): its updated_at is recent, its time is not.
  server.settle(ALICE_KEY, { sats: 6, createdAt: '2020-01-01T00:00:00+00:00' });
  await quiet();
  assert.equal(notices(bot, alice).length, 0);
});

const future = (ms) => new Date(Date.now() + ms).toISOString();
const toAlice = (bot) => repliesFor(bot, alice).map((m) => m.content);

test('a row dated in the future does not hide later payments', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await waitFor(() => Object.keys(bot.state.payments).length, 'the baseline');
  const hash = 'aa'.repeat(32);
  server.wallets[ALICE_KEY].payments.push(
    payment({ amount: 1000000, hash, time: new Date().toISOString(), updated: future(86400000) }),
  );
  server.push(ALICE_KEY, 'something');
  await waitFor(() => toAlice(bot).some((text) => text.includes('+1,000 sats')), 'the odd row');
  const entry = Object.values(bot.state.payments)[0];
  assert.ok(entry.cursor <= Date.now(), 'the cursor never runs ahead');
  server.settle(ALICE_KEY, { sats: 500 });
  await waitFor(() => toAlice(bot).some((text) => text.includes('+500 sats')), 'a later payment');
  await quiet();
  assert.equal(toAlice(bot).filter((text) => text.includes('+1,000 sats')).length, 1, 'once');
});

test('a cursor saved too far ahead is repaired, and what it hid is announced', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await waitFor(() => Object.keys(bot.state.payments).length, 'the baseline');
  const entry = Object.values(bot.state.payments)[0];
  // What an earlier release could have saved: blind, and paid since.
  const old = 'bb'.repeat(32);
  entry.known[old] = Date.now() + 86400000;
  entry.cursor = entry.known[old];
  server.settle(ALICE_KEY, { sats: 777 });
  await waitFor(
    () => toAlice(bot).some((text) => text.includes('+777 sats')),
    'the hidden payment',
  );
  assert.ok(entry.cursor <= Date.now());
  assert.ok(entry.known[old] <= Date.now());
});

test('notifications wait while the outbox is busy, and are not lost', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, { notifications: { outboxLimit: 3 } });
  await waitFor(() => Object.keys(bot.state.payments).length, 'the baseline');
  await quiet(); // scans started by the socket opening have finished
  const filler = {
    event: { id: 'c'.repeat(64) },
    relays: [],
    queuedAt: Math.floor(Date.now() / 1000),
    retryAt: 2 ** 40,
  };
  bot.state.outbox.push(filler, filler, filler);
  server.settle(ALICE_KEY, { sats: 321 });
  await quiet();
  assert.equal(toAlice(bot).length, 0, 'nothing queued above the limit');
  bot.state.outbox.length = 0;
  server.settle(ALICE_KEY, { sats: 322 });
  const said = (pattern) => toAlice(bot).some((text) => pattern.test(text));
  await waitFor(() => said(/\+321 sats/) && said(/\+322 sats/), 'both payments');
});

test('memos in notifications are sanitized', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  server.settle(ALICE_KEY, { sats: 1, memo: 'claim at https://evil.example\u202E now\n`x`' });
  await waitFor(() => notices(bot, alice).length === 1, 'notice');
  assert.match(notices(bot, alice)[0].content, / · claim at \(link\) now x$/);
});

test('stopping cancels scans and closes sockets promptly', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, { timeoutMs: 10000 });
  await watching(server, ALICE_KEY);
  server.next = (record) => (record.path === '/api/v1/payments/paginated' ? 'handled' : undefined);
  server.push(ALICE_KEY, '{}');
  await quiet(100);
  const begun = Date.now();
  await bot.close();
  assert.ok(Date.now() - begun < 1000, `close took ${Date.now() - begun} ms`);
  await waitFor(() => server.open(ALICE_KEY) === 0, 'socket closed');
  const upgrades = server.upgrades;
  await quiet(300);
  assert.equal(server.upgrades, upgrades, 'no reconnect after stopping');
});

test('a flood of frames costs a few scans, not one per frame', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  await quiet(300);
  const before = scans(server).length;
  server.push(ALICE_KEY, '{}', 500);
  await quiet(100);
  const watch = bot.watcher.watchOf(getPublicKey(alice));
  assert.ok(watch.timers.size <= 2, `pending timers: ${watch.timers.size}`);
  await quiet(500);
  const extra = scans(server).length - before;
  assert.ok(extra >= 1 && extra <= 6, `scans for 500 frames: ${extra}`);
});

test('a row committed with an earlier settlement time is still found, within the overlap', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server);
  await waitFor(() => Object.keys(bot.state.payments).length, 'the baseline');
  await quiet();
  server.settle(ALICE_KEY, { sats: 100 });
  await waitFor(() => notices(bot, alice).length === 1, 'the first payment');
  const earlier = new Date(Date.now() - 30000).toISOString();
  server.wallets[ALICE_KEY].payments.push(
    payment({ amount: 200000, hash: 'dd'.repeat(32), time: earlier, updated: earlier }),
  );
  server.push(ALICE_KEY, 'something');
  await waitFor(() => notices(bot, alice).length === 2, 'the late row');
});

test('a frame that arrives before its row is committed is checked again', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, { notifications: { recheckMs: 200 } });
  await waitFor(() => Object.keys(bot.state.payments).length, 'the baseline');
  await quiet();
  server.push(ALICE_KEY, 'something');
  await new Promise((r) => setTimeout(r, 60)); // the first check found nothing
  const time = new Date().toISOString();
  server.wallets[ALICE_KEY].payments.push(
    payment({ amount: 300000, hash: 'de'.repeat(32), time, updated: time }),
  );
  await waitFor(() => notices(bot, alice).length === 1, 'the re-check');
});

test('handled hashes are bounded in number and in age', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, { notifications: { maxKnown: 3 } });
  const watcher = bot.watcher;
  const entry = { owner: 'a'.repeat(64), baselineAt: 0, cursor: 0, known: {} };
  const row = (n, settledAt) => ({ paymentHash: String(n).repeat(64), settledAt });
  const time = Date.now();
  watcher.remember(
    entry,
    [1, 2, 3, 4, 5].map((n) => row(n, time - 6 + n)),
  );
  assert.deepEqual(
    Object.keys(entry.known).sort(),
    ['3', '4', '5'].map((n) => n.repeat(64)),
  );
  watcher.options.retentionMs = 100;
  watcher.options.maxKnown = 100;
  watcher.remember(entry, [row(6, time)]);
  entry.known[row(7).paymentHash] = time - 1000;
  watcher.remember(entry, []);
  assert.ok(!entry.known[row(7).paymentHash], 'too old');
  assert.ok(entry.known[row(6).paymentHash]);
});

test('a busy wallet gets one notification every so often, listing everything', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, { notifications: { noticeEveryMs: 400 } });
  await waitFor(() => Object.keys(bot.state.payments).length, 'the baseline');
  await quiet();
  for (let n = 1; n <= 6; n++) {
    server.settle(ALICE_KEY, { sats: n * 100 });
    await new Promise((r) => setTimeout(r, 30));
  }
  await waitFor(
    () =>
      [100, 200, 300, 400, 500, 600].every((sats) =>
        notices(bot, alice).some((m) => m.content.includes(`+${sats} sats`)),
      ),
    'all six, none lost',
    4000,
  );
  assert.ok(notices(bot, alice).length <= 3, `${notices(bot, alice).length} notifications`);
});

test('a wallet over its share is not told again of what the cap made it forget', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, {
    notifications: { noticeEveryMs: 0, maxKnownTotal: 25 },
  });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  for (let i = 0; i < 40; i++) server.settle(ALICE_KEY, { sats: 1 + i, frames: 0 });
  const watch = bot.watcher.watchOf(getPublicKey(alice));
  await bot.watcher.scan(watch);
  const told = notices(bot, alice).length;
  assert.equal(told, 1);
  const entry = baseline(bot, ALICE_KEY);
  assert.ok(Object.keys(entry.known).length <= 25, 'the total holds');
  assert.ok(entry.forgottenUpTo > 0);
  for (let scan = 0; scan < 3; scan++) await bot.watcher.scan(watch);
  assert.equal(notices(bot, alice).length, told, 'nothing repeated');
  // A new payment is still news.
  await new Promise((resolve) => setTimeout(resolve, 5));
  server.settle(ALICE_KEY, { sats: 500, frames: 0 });
  await bot.watcher.scan(watch);
  assert.equal(notices(bot, alice).length, told + 1);
  assert.ok(notices(bot, alice).some((m) => /500 sats/.test(m.content)));
});

test('notifications wait when the queue fills during the relay lookup, and per wallet', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await started(t, server, {
    notifications: { noticeEveryMs: 0, queuedPerWallet: 1 },
  });
  await watching(server, ALICE_KEY);
  await waitFor(() => baseline(bot, ALICE_KEY), 'baseline');
  const watch = bot.watcher.watchOf(getPublicKey(alice));
  const received = () => bot.state.outbox.filter((i) => i.connection === watch.lease.id).length;
  const before = received();
  server.settle(ALICE_KEY, { sats: 7, frames: 0 });
  // Filled up while the relays are being looked up: nothing recorded, so it is found later.
  const { inbox } = bot;
  bot.inbox = async function (...args) {
    const relays = await inbox.apply(this, args);
    bot.state.outbox.push(
      ...Array.from({ length: 500 }, () => ({ queuedAt: 0, event: {}, relays: [] })),
    );
    return relays;
  };
  const hashes = () => Object.keys(baseline(bot, ALICE_KEY).known).length;
  const known = hashes();
  await bot.watcher.scan(watch);
  assert.equal(received(), before, 'not queued');
  assert.equal(hashes(), known, 'not recorded as told');
  bot.inbox = inbox;
  bot.state.outbox = bot.state.outbox.filter((i) => i.queuedAt !== 0);
  await bot.watcher.scan(watch);
  assert.equal(received(), before + 1, 'told once there is room');
  // One wallet's own limit.
  server.settle(ALICE_KEY, { sats: 8, frames: 0 });
  await bot.watcher.scan(watch);
  assert.equal(received(), before + 1, 'over its own limit it waits');
});
