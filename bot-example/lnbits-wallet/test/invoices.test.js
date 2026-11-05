// /invoice end to end through the bot, against a local mock LNbits: one creation request per
// message, ever; uncertain outcomes are looked up, never retried.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { LNbitsClient } from '../lnbits.js';
import { Wallets } from '../wallets.js';
import { externalId, Invoices } from '../invoices.js';
import { review } from '../review.js';
import { State } from '../vendor/runtime.js';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  last,
  npub,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { closedPort, fakeBolt11, lnbitsServer, payment } from './lnbits-server.js';

const ADMIN_KEY = 'ad000000000000000000000000000003';
const FAST = [0.05, 0.05, 0.05]; // seconds between lookups in tests

async function mockLNbits(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'alice', balance: 0, payments: [] },
    [BOB_KEY]: { name: 'bob', balance: 0, payments: [] },
    [ADMIN_KEY]: { name: 'spendable', balance: 0, payments: [], admin: true },
  });
  defer(t, () => server.close());
  return server;
}
function invoiceBot(t, server, { timeoutMs = 300, ...options } = {}) {
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs });
  return { lnbits, ...setup(t, { lnbits, checkDelays: FAST, ...options }) };
}
// Waits for timers and lanes: lookups run on timers, then in the person's lane.
async function idle(bot, ms = 600) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await settle(bot);
    if (!bot.timers.size) return settle(bot);
    await new Promise((r) => setTimeout(r, 20));
  }
  return settle(bot);
}
const records = (bot) => bot.state.invoices.map((r) => r.state);
const bolt11Of = (text) => /^(ln[0-9a-z]+)$/m.exec(text)?.[1];
function noLeaks(bot, logs, dir, server) {
  const state = readFileSync(`${dir}/state.json`, 'utf8');
  const log = logs.join('\n');
  for (const invoice of server.created) {
    assert.ok(
      !state.includes(invoice.bolt11) && !log.includes(invoice.bolt11),
      'invoice text kept out',
    );
    assert.ok(!log.includes(invoice.payment_hash), 'payment hash not logged');
  }
  for (const secret of [ALICE_KEY, BOB_KEY, ADMIN_KEY])
    assert.ok(!state.includes(secret) && !log.includes(secret), 'key kept out');
  assert.ok(!state.includes('secret memo text'), 'memo not stored');
  assert.ok(!log.includes('secret memo text'), 'memo not logged');
}

test('/invoice creates exactly one invoice with the sender’s key and returns BOLT11 text', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs, dir } = invoiceBot(t, server);
  await sendDM(bot, alice, '/invoice 1000 secret memo text');
  const reply = last(bot, alice).content;
  assert.equal(server.posts.length, 1);
  const [post] = server.posts;
  assert.equal(post.key, ALICE_KEY);
  assert.deepEqual(
    { ...post.body, external_id: undefined },
    {
      out: false,
      amount: 1000,
      unit: 'sat',
      memo: 'secret memo text',
      expiry: 3600,
      external_id: undefined,
    },
  );
  assert.equal(post.body.external_id, externalId(bot.state.invoices[0]));
  assert.equal(
    reply,
    `Invoice for 1,000 sats (valid for 60 minutes):\n${server.created[0].bolt11}\nMemo: secret memo text`,
  );
  assert.deepEqual(records(bot), ['created']);
  assert.equal(bot.state.invoices[0].paymentHash, server.created[0].payment_hash);
  // The invoice went only to Alice (and the bot's own copy), never to Bob.
  assert.equal(repliesFor(bot, bob).length, 0);
  noLeaks(bot, logs, dir, server);
  await sendDM(bot, bob, '/invoice 21');
  assert.equal(server.posts[1].key, BOB_KEY, 'Bob uses his own wallet');
  assert.match(last(bot, bob).content, /^Invoice for 21 sats/);
});

test('invalid amounts and memos are refused before anything is stored or sent', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server, { limits: { maxInvoiceSats: 5000 } });
  for (const text of [
    '/invoice',
    '/invoice 0',
    '/invoice -5',
    '/invoice 1.5',
    '/invoice 1e3',
    '/invoice 1,000',
    '/invoice 007',
    '/invoice abc',
    '/invoice 1000000000',
  ]) {
    await sendDM(bot, alice, text);
    assert.match(last(bot, alice).content, /^Usage: \/invoice/, text);
  }
  await sendDM(bot, alice, '/invoice 5001');
  assert.equal(
    last(bot, alice).content,
    'The amount must be a whole number of sats from 1 to 5,000.',
  );
  await sendDM(bot, alice, `/invoice 10 ${'x'.repeat(101)}`);
  assert.match(last(bot, alice).content, /at most 100 characters/);
  await sendDM(bot, alice, `/invoice 10 ${'é'.repeat(100)}${'€'.repeat(1)}`);
  assert.match(last(bot, alice).content, /at most 100 characters/);
  assert.equal(server.posts.length, 0);
  assert.deepEqual(bot.state.invoices, []);
  // Control and direction characters become spaces; the memo is sent as written otherwise.
  await sendDM(bot, alice, '/invoice 10 tea‮ for\ttwo\n');
  assert.equal(server.posts[0].body.memo, 'tea for two');
});

test('the same Nostr message never creates a second invoice, even if seen is forgotten', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  const message = dm(alice, '/invoice 500', bot);
  await Promise.all([
    bot.directMessage(message, { tags: [] }),
    bot.directMessage(message, { tags: [] }),
  ]);
  await settle(bot);
  delete bot.state.seen[message.id]; // as after the 48-hour dedupe window
  await bot.directMessage(message, { tags: [] });
  await settle(bot);
  assert.equal(server.posts.length, 1);
  assert.equal(repliesFor(bot, alice).length, 1);
});

test('concurrent requests are serialized per person; an unsettled one blocks the next', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server, { timeoutMs: 150 });
  server.create = 'store-later'; // LNbits stores it only after the bot gave up waiting
  server.storeDelayMs = 250;
  const first = dm(alice, '/invoice 100', bot);
  const second = dm(alice, '/invoice 200', bot);
  const forBob = dm(bob, '/invoice 300', bot);
  await Promise.all([first, second, forBob].map((m) => bot.directMessage(m, { tags: [] })));
  await settle(bot);
  const replies = repliesFor(bot, alice).map((r) => r.content);
  assert.match(replies[0], /did not confirm whether it created your invoice for 100 sats/);
  assert.match(replies[1], /still checking your previous invoice request for 100 sats/);
  assert.equal(server.posts.filter((p) => p.key === ALICE_KEY).length, 1, 'second never sent');
  // Bob's request ran at the same time in his own lane, with his own key.
  assert.equal(server.posts.filter((p) => p.key === BOB_KEY).length, 1);
  server.create = 'ok';
  await idle(bot, 1500);
  const late = repliesFor(bot, alice).at(-1).content;
  assert.match(late, /^LNbits has now confirmed your invoice for 100 sats/);
  assert.equal(bolt11Of(late), server.created.find((i) => i.amount === 100_000).bolt11);
  // Settled: a new request is accepted again.
  await sendDM(bot, alice, '/invoice 200');
  assert.match(last(bot, alice).content, /^Invoice for 200 sats/);
  assert.equal(server.posts.filter((p) => p.key === ALICE_KEY).length, 2);
});

test('uncertain outcomes are found by external id, never resent', async (t) => {
  for (const mode of ['store-hang', 'store-drop']) {
    const server = await mockLNbits(t);
    const { bot, logs, dir } = invoiceBot(t, server);
    server.create = mode;
    await sendDM(bot, alice, '/invoice 777 secret memo text');
    assert.match(last(bot, alice).content, /will not create a second one/, mode);
    await idle(bot);
    const reply = last(bot, alice).content;
    assert.match(reply, /^LNbits has now confirmed your invoice for 777 sats/, mode);
    assert.equal(bolt11Of(reply), server.created[0].bolt11);
    assert.equal(server.posts.length, 1, `${mode}: exactly one POST`);
    assert.deepEqual(records(bot), ['created']);
    noLeaks(bot, logs, dir, server);
  }
});

test('never found after every check: failed, the person told, and able to ask again', async (t) => {
  for (const mode of ['hang', 500]) {
    const server = await mockLNbits(t);
    const { bot, logs } = invoiceBot(t, server);
    server.create = mode;
    await sendDM(bot, alice, '/invoice 50');
    await idle(bot);
    assert.deepEqual(records(bot), ['failed'], String(mode));
    assert.match(last(bot, alice).content, /no invoice for your request for 50 sats/);
    assert.equal(bot.state.invoices[0].checks, FAST.length);
    assert.equal(bot.state.invoices[0].error, 'not_found');
    assert.ok(!logs.some((l) => /npm run review/.test(l)), 'the operator is not needed');
    server.create = 'ok';
    await sendDM(bot, alice, '/invoice 60');
    assert.deepEqual(records(bot), ['failed', 'created']);
    assert.equal(server.posts.length, 2, 'the failed request itself was not sent again');
    assert.match(last(bot, alice).content, /Invoice for 60 sats/);
  }
});

test('more than one invoice for a request: review, operator told, new invoices blocked', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs } = invoiceBot(t, server);
  server.create = 'hang';
  await sendDM(bot, alice, '/invoice 50');
  const record = bot.state.invoices[0];
  const twin = () =>
    payment({
      amount: 50000,
      status: 'pending',
      hash: randomBytes(32).toString('hex'),
      bolt11: fakeBolt11(50),
      external_id: externalId(record),
    });
  server.wallets[ALICE_KEY].payments.push(twin(), twin());
  await idle(bot);
  assert.deepEqual(records(bot), ['review']);
  assert.match(last(bot, alice).content, /operator has been asked to check/);
  assert.ok(
    logs.some((l) => l.includes(`external id ${externalId(record)}`) && /npm run review/.test(l)),
  );
  server.create = 'ok';
  await sendDM(bot, alice, '/invoice 60');
  assert.match(last(bot, alice).content, /needs a check by the bot operator/);
  assert.equal(server.posts.length, 1, 'still exactly one POST');
});

test('an invoice confirmed only after it expired is not shown as payable', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  server.create = 'hang';
  await sendDM(bot, alice, '/invoice 50');
  const record = bot.state.invoices[0];
  record.expiresAt -= 2 * 3600; // an outage outlasted the invoice
  const invoice = payment({
    amount: 50000,
    status: 'pending',
    hash: 'ee'.repeat(32),
    bolt11: fakeBolt11(50),
    external_id: externalId(record),
  });
  server.wallets[ALICE_KEY].payments.push(invoice);
  await idle(bot);
  assert.deepEqual(records(bot), ['created']);
  const text = last(bot, alice).content;
  assert.match(text, /too late to pay it/);
  assert.ok(!text.includes(invoice.bolt11), 'an invoice that cannot be paid is not offered');
});

test('a person held in review by an earlier release is let go at the next start', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs } = await restartWith(t, server, (first, record) => {
    first.invoices.move(record, 'sending');
    first.invoices.move(record, 'uncertain', { error: 'timeout', checks: 3 });
    // A transition this release no longer makes, as it stands in an old state.json.
    Object.assign(record, { state: 'review', error: 'not_found' });
  });
  assert.deepEqual(records(bot), ['failed']);
  assert.match(last(bot, alice).content, /no invoice for your request/);
  assert.ok(!logs.some((l) => /npm run review/.test(l)));
  assert.equal(server.posts.length, 0);
});

test('reviews an operator must decide stay in review across a restart', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs } = await restartWith(t, server, (first, record) => {
    first.invoices.move(record, 'sending');
    first.invoices.move(record, 'uncertain', { error: 'mismatch' });
    first.invoices.move(record, 'review', { error: 'mismatch' });
  });
  assert.deepEqual(records(bot), ['review']);
  assert.ok(logs.some((l) => /npm run review/.test(l)));
});

test('an /invoice over an hour old is not acted on, as after an older state is put back', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  const message = dm(alice, '/invoice 70', bot, [], Math.floor(Date.now() / 1000) - 3700);
  bot.state.startedAt = 0;
  bot.state.authorized.users[getPublicKey(alice)] = 0;
  await bot.directMessage(message, { tags: [] });
  await settle(bot);
  assert.equal(server.posts.length, 0);
  assert.deepEqual(records(bot), []);
  assert.match(last(bot, alice).content, /over an hour old/);
});

test('a lookup that returns other payments (filter ignored) is not mistaken for a match', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  await sendDM(bot, alice, '/invoice 10'); // a real invoice already in the wallet
  server.create = 'hang';
  server.ignoreFilters = true;
  await sendDM(bot, alice, '/invoice 20');
  await idle(bot);
  assert.deepEqual(records(bot), ['created', 'failed']);
  assert.ok(!last(bot, alice).content.includes(server.created[0].bolt11), 'old invoice not resent');
});

test('certain LNbits failures: nothing created, nothing looked up, person told', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  server.create = 520;
  await sendDM(bot, alice, '/invoice 10');
  assert.match(last(bot, alice).content, /refused to create this invoice.*Nothing was created/);
  server.create = 400;
  await sendDM(bot, alice, '/invoice 11');
  assert.deepEqual(records(bot), ['failed', 'failed']);
  // No invoice lookup (by external id); notification scans use the same endpoint.
  assert.ok(!server.requests.some((r) => r.query.external_id !== undefined));
  server.create = 'ok';
  await sendDM(bot, alice, '/invoice 12');
  assert.match(last(bot, alice).content, /^Invoice for 12 sats/, 'a failure does not block');

  const down = setup(t, { lnbits: new LNbitsClient({ url: await closedPort() }) });
  await sendDM(down.bot, alice, '/invoice 10');
  assert.match(last(down.bot, alice).content, /not reachable right now.*Nothing was created/);
});

test('wrong key, admin key and a wallet that answers for another amount', async (t) => {
  const server = await mockLNbits(t);
  const wallets = new Wallets([
    [npub(alice), { label: 'Alice', invoiceKey: ADMIN_KEY }],
    [npub(bob), { label: 'Bob', invoiceKey: 'c'.repeat(32) }],
  ]);
  const { bot } = invoiceBot(t, server, { wallets });
  await sendDM(bot, alice, '/invoice 10');
  assert.match(last(bot, alice).content, /key that can spend.*Nothing was created/);
  await sendDM(bot, bob, '/invoice 10');
  assert.match(last(bot, bob).content, /did not accept the key.*Nothing was created/);
  assert.equal(server.posts.length, 0, 'the key check failed first');

  const other = await mockLNbits(t);
  const mismatched = invoiceBot(t, other);
  other.create = 'wrong-amount';
  await sendDM(mismatched.bot, alice, '/invoice 10');
  assert.deepEqual(records(mismatched.bot), ['review']);
  assert.ok(!last(mismatched.bot, alice).content.includes(other.created[0].bolt11), 'not shown');
});

test('cross-wallet attempts only ever use the sender’s own key', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  await sendDM(bot, alice, `/invoice 10 for ${npub(bob)}`);
  await sendDM(bot, alice, `/invoice 10 ${BOB_KEY}`);
  assert.match(last(bot, alice).content, /never accept keys in chat/);
  assert.ok(server.requests.every((r) => r.key === ALICE_KEY));
  assert.equal(server.posts.length, 1);
});

test('the hourly limit counts invoices that may exist', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server, { limits: { invoicesPerHour: 2 } });
  for (const amount of [1, 2, 3]) await sendDM(bot, alice, `/invoice ${amount}`);
  assert.match(last(bot, alice).content, /asked for 2 invoices in the last hour/);
  assert.equal(server.posts.length, 2);
});

// Restarts: the records written before and after the LNbits request decide what happens.
async function restartWith(t, server, prepare) {
  const dir = tempDir(t, 'invoice-restart');
  const first = invoiceBot(t, server, { dir });
  const message = dm(alice, '/invoice 4242', first.bot);
  const record = first.bot.invoices.add({
    requester: getPublicKey(alice),
    messageId: message.id,
    sats: 4242,
  });
  await prepare(first.bot, record);
  first.bot.state.seen[message.id] = Math.floor(Date.now() / 1000);
  first.bot.save();
  await first.bot.close();
  const second = invoiceBot(t, server, { dir });
  await second.bot.start();
  await idle(second.bot);
  return { bot: second.bot, logs: second.logs, message };
}

test('restart before the request was sent: failed, person told, nothing sent', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await restartWith(t, server, () => {});
  assert.deepEqual(records(bot), ['failed']);
  assert.match(last(bot, alice).content, /was not sent to LNbits because the bot restarted/);
  assert.equal(server.posts.length, 0);
});

test('restart after sending: found by external id and delivered, never resent', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await restartWith(t, server, async (first, record) => {
    first.invoices.move(record, 'sending');
    // LNbits received it before the crash.
    server.wallets[ALICE_KEY].payments.push(
      payment({
        amount: 4_242_000,
        status: 'pending',
        hash: 'ab'.repeat(32),
        bolt11: fakeBolt11(4242),
        external_id: externalId(record),
      }),
    );
  });
  assert.deepEqual(records(bot), ['created']);
  const replies = repliesFor(bot, alice).map((r) => r.content);
  assert.match(replies.at(-2), /did not confirm whether it created/);
  assert.match(replies.at(-1), /^LNbits has now confirmed your invoice for 4,242 sats/);
  assert.equal(server.posts.length, 0, 'no second creation request');
});

test('restart after sending when LNbits has nothing: failed, never resent', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = await restartWith(t, server, (first, record) => {
    first.invoices.move(record, 'sending');
  });
  assert.deepEqual(records(bot), ['failed']);
  assert.equal(server.posts.length, 0);
});

test('restart with a created invoice changes nothing; an uncertain one is checked again', async (t) => {
  const server = await mockLNbits(t);
  const created = await restartWith(t, server, (first, record) => {
    first.invoices.move(record, 'sending');
    first.invoices.move(record, 'created', { paymentHash: 'cd'.repeat(32) });
  });
  assert.deepEqual(records(created.bot), ['created']);
  assert.equal(repliesFor(created.bot, alice).length, 0);
  // No invoice lookup (by external id); notification scans use the same endpoint.
  assert.ok(!server.requests.some((r) => r.query.external_id !== undefined));
  const uncertain = await restartWith(t, server, (first, record) => {
    first.invoices.move(record, 'sending');
    first.invoices.move(record, 'uncertain', { error: 'timeout', checks: 1 });
  });
  assert.deepEqual(records(uncertain.bot), ['failed']);
  assert.equal(uncertain.bot.state.invoices[0].checks, FAST.length);
  assert.equal(server.posts.length, 0);
});

test('stopping during the creation request leaves it uncertain for the next start', async (t) => {
  const server = await mockLNbits(t);
  server.create = 'store-hang';
  const dir = tempDir(t, 'invoice-stop');
  const { bot } = invoiceBot(t, server, { dir, timeoutMs: 10000 });
  await bot.directMessage(dm(alice, '/invoice 99', bot), { tags: [] });
  await new Promise((r) => setTimeout(r, 100));
  const started = Date.now();
  await bot.close();
  assert.ok(Date.now() - started < 1000, 'closes promptly');
  const saved = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
  assert.deepEqual(
    saved.invoices.map((r) => r.state),
    ['uncertain'],
  );
  const next = invoiceBot(t, server, { dir });
  await next.bot.start();
  await idle(next.bot);
  assert.deepEqual(records(next.bot), ['created']);
  assert.equal(server.posts.length, 1);
});

test('the review tool lists open requests and resolves only those in review', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'invoice-review');
  const { bot } = invoiceBot(t, server, { dir });
  server.create = 'wrong-amount';
  await sendDM(bot, alice, '/invoice 50');
  await idle(bot);
  await bot.close();
  const store = new State(dir);
  defer(t, () => store.close());
  const lines = [];
  review(store.data, [], (l) => lines.push(l));
  const [record] = store.data.invoices;
  assert.ok(lines[0].includes(record.op) && lines[0].includes(externalId(record)));
  assert.throws(() => review(store.data, ['created', 'nope'], () => {}), /No request in review/);
  assert.throws(() => review(store.data, ['delete', record.op], () => {}), /Use: review/);
  review(store.data, ['failed', record.op], () => {});
  assert.equal(record.state, 'failed');
  assert.throws(() => review(store.data, ['created', record.op], () => {}), /No request in review/);
});

test('the record is on disk before LNbits is asked, and so is the message', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'invoice-durable');
  const { bot } = invoiceBot(t, server, { dir });
  const message = dm(alice, '/invoice 88', bot);
  let onDisk;
  server.next = (record) => {
    if (record.method === 'POST') onDisk = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
  };
  await bot.directMessage(message, { tags: [] });
  await settle(bot);
  assert.deepEqual(
    onDisk.invoices.map((r) => r.state),
    ['sending'],
  );
  assert.ok(onDisk.seen[message.id], 'a restart cannot run this message again');
});

test('a lookup that finds another amount is never shown or settled as this invoice', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = invoiceBot(t, server);
  server.create = 'hang';
  await sendDM(bot, alice, '/invoice 50');
  const wrong = payment({
    amount: 51000,
    status: 'pending',
    hash: 'ef'.repeat(32),
    bolt11: fakeBolt11(51),
    external_id: externalId(bot.state.invoices[0]),
  });
  server.wallets[ALICE_KEY].payments.push(wrong);
  await idle(bot);
  assert.deepEqual(records(bot), ['review']);
  assert.ok(!repliesFor(bot, alice).some((m) => m.content.includes(wrong.bolt11)));
});

test('old finished records go, open ones never do', () => {
  const time = 2_000_000_000;
  const invoices = new Invoices({}, () => time);
  const add = (state, age) => {
    const record = invoices.add({
      requester: 'a'.repeat(64),
      messageId: randomBytes(32).toString('hex'),
      sats: 1,
    });
    Object.assign(record, { state, updatedAt: time - age, createdAt: time - age });
    return record;
  };
  const year = 365 * 86400;
  const open = add('review', year);
  const old = add('failed', year);
  const recent = add('created', 3600);
  invoices.prune();
  assert.ok(invoices.all.includes(open));
  assert.ok(!invoices.all.includes(old));
  assert.ok(invoices.all.includes(recent));
});
