// Inline buttons end to end: presses arrive as gift-wrapped kind 21118 requests (the same
// unwrap and sender check as DMs), against a local mock LNbits.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools';
import { LNbitsClient } from '../lnbits.js';
import { Wallets } from '../wallets.js';
import { Buttons } from '../buttons.js';
import { externalId } from '../invoices.js';
import { invoicePresets, loadConfig } from '../config.js';
import { now, State, wrap } from '../vendor/runtime.js';
import { WalletBot } from '../bot.js';
import {
  BOT_CONTROL_KIND,
  COMMAND_TAG,
  CONTROL_TAG,
  KEYBOARD_TAG,
  keyboardFromTags,
  parseControl,
} from '../vendor/botKeyboardProtocol.ts';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  fakeNet,
  last,
  linked,
  mallory,
  npub,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer, payment } from './lnbits-server.js';

const OTHER_KEY = 'c0ffee00000000000000000000000004';
const FAST = [0.05, 0.05, 0.05];

async function mockLNbits(t) {
  const server = await lnbitsServer({
    [ALICE_KEY]: {
      name: 'alice',
      balance: 2_100_500,
      payments: [
        payment({
          amount: 1_000,
          memo: 'newest',
          time: '2026-10-31T18:00:00+00:00',
          hash: 'a1'.repeat(32),
        }),
        payment({
          amount: 2_000,
          memo: 'middle',
          time: '2026-10-30T18:00:00+00:00',
          hash: 'a2'.repeat(32),
        }),
        payment({
          amount: 3_000,
          memo: 'oldest',
          time: '2026-10-29T18:00:00+00:00',
          hash: 'a3'.repeat(32),
        }),
      ],
    },
    [BOB_KEY]: { name: 'bob', balance: 42_000, payments: [] },
    [OTHER_KEY]: { name: 'other', balance: 7_000, payments: [] },
  });
  defer(t, () => server.close());
  return server;
}
function buttonBot(t, server, { timeoutMs = 400, limits = {}, ...options } = {}) {
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs });
  return {
    lnbits,
    ...setup(t, {
      lnbits,
      checkDelays: FAST,
      limits: { historyDefault: 1, ...limits },
      ...options,
    }),
  };
}
const calls = (server, path) => server.requests.filter((r) => r.path === path).length;

// What the bot queued for a person: cards (kind 14 with a keyboard) and private answers.
const cards = (bot, key) =>
  repliesFor(bot, key).filter((m) => m.kind === 14 && keyboardFromTags(m.tags));
const answers = (bot, key) => repliesFor(bot, key).filter((m) => m.kind === BOT_CONTROL_KIND);
const buttonsOf = (event) => keyboardFromTags(event.tags).inline_keyboard.flat();
const data = (event) => buttonsOf(event).flatMap((b) => (b.callback_data ? [b.callback_data] : []));
const copyText = (event) => buttonsOf(event).find((b) => b.copy_text)?.copy_text.text;
const bolt11Of = (text) => /^(ln[0-9a-z]+)$/m.exec(text)?.[1];

// A press as Anagram sends it: an unsigned kind 21118 rumor, sealed by the sender.
function pressRumor(sender, bot, card, callback, options = {}) {
  const created = options.created ?? now();
  const request = {
    op: 'request',
    id: options.id ?? randomBytes(16).toString('hex'),
    target: options.target ?? {
      type: 'dm',
      chat: bot.pubkey,
      root: card.id,
      version: card.id,
      bot: bot.pubkey,
    },
    data: callback,
    expires: options.expires ?? created + 300,
    ...(options.view ? { view: options.view } : {}),
  };
  const event = {
    kind: BOT_CONTROL_KIND,
    pubkey: getPublicKey(sender),
    created_at: created,
    tags: options.tags ?? [
      ['p', bot.pubkey],
      [CONTROL_TAG, '1', JSON.stringify(request)],
    ],
    content: options.content ?? '',
  };
  return { ...event, id: getEventHash(event) };
}
// Through the bot's relay path: gift wrap -> seal -> rumor, like any incoming event.
async function deliver(bot, message, sealer) {
  bot.receive(wrap(message, sealer, bot.pubkey), bot.key);
  await settle(bot);
  return message;
}
const press = (bot, sender, card, callback, options) =>
  deliver(bot, pressRumor(sender, bot, card, callback, options), sender);
const answerTo = (bot, key, message) => {
  const id = parseControl(message.tags).id;
  return answers(bot, key).filter((a) => parseControl(a.tags).id === id);
};

// The answer the protocol requires: one recipient, the same id, target and expiry, made
// before the request expired, with a valid keyboard.
function checkAnswer(bot, key, message) {
  const found = answerTo(bot, key, message);
  assert.equal(found.length, 1, 'exactly one answer');
  const [answer] = found;
  const request = parseControl(message.tags);
  const control = parseControl(answer.tags);
  assert.deepEqual(
    answer.tags.filter((t) => t[0] === 'p'),
    [['p', getPublicKey(key)]],
  );
  assert.equal(control.op, 'answer');
  assert.deepEqual(
    { id: control.id, target: control.target, expires: control.expires },
    { id: request.id, target: request.target, expires: request.expires },
  );
  assert.ok(answer.created_at <= request.expires, 'answered in time');
  assert.ok(keyboardFromTags(answer.tags), 'valid keyboard');
  assert.equal(answer.pubkey, bot.pubkey);
  return answer;
}

function noSecrets(bot, logs, dir, server) {
  const state = readFileSync(`${dir}/state.json`, 'utf8');
  const log = logs.join('\n');
  const everything = [
    state,
    log,
    ...repliesFor(bot, alice).map((m) => JSON.stringify(m)),
    ...repliesFor(bot, bob).map((m) => JSON.stringify(m)),
  ].join('\n');
  for (const secret of [ALICE_KEY, BOB_KEY, OTHER_KEY])
    assert.ok(!everything.includes(secret), 'invoice key never in state, logs or messages');
  for (const invoice of server.created)
    assert.ok(
      !state.includes(invoice.bolt11) && !log.includes(invoice.bolt11),
      'no invoice text kept',
    );
}

test('replies carry buttons; the text is unchanged for apps without them', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server);
  const balance = await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  assert.equal(card.content, 'Balance (Alice test wallet): 2,100.5 sats');
  assert.deepEqual(data(card), ['bal', 'hist:0', 'inv:1000', 'inv:5000', 'inv:custom', 'iv:0']);
  assert.deepEqual(
    card.tags.find((t) => t[0] === COMMAND_TAG),
    [COMMAND_TAG, '1', balance.id],
  );
  assert.deepEqual(
    card.tags.find((t) => t[0] === 'e'),
    ['e', balance.id, '', 'reply'],
  );

  await sendDM(bot, alice, '/help');
  const help = last(bot, alice);
  assert.ok(keyboardFromTags(help.tags), 'help offers the menu');
  assert.ok(!help.tags.some((t) => t[0] === COMMAND_TAG), 'help is never folded away');

  // Failures and usage messages have no buttons.
  await sendDM(bot, alice, '/history 99');
  assert.ok(!last(bot, alice).tags.some((t) => t[0] === KEYBOARD_TAG));
  server.next = (record, req, res) => {
    res.writeHead(500).end();
    return 'handled';
  };
  await sendDM(bot, alice, '/balance');
  assert.match(last(bot, alice).content, /unexpected response|not reachable/);
  assert.ok(!last(bot, alice).tags.some((t) => t[0] === KEYBOARD_TAG));

  // Only the two successful cards are registered: what a press may refer to.
  assert.equal(Object.keys(bot.state.cards).length, 2);
});

test('Refresh balance answers privately with the current balance and the menu', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs, dir } = buttonBot(t, server);
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  server.wallets[ALICE_KEY].balance = 5_000_000;
  const before = calls(server, '/api/v1/wallet');
  const request = await press(bot, alice, card, 'bal');
  const answer = checkAnswer(bot, alice, request);
  assert.equal(answer.content, 'Balance (Alice test wallet): 5,000 sats');
  assert.deepEqual(data(answer), data(card));
  assert.equal(calls(server, '/api/v1/wallet'), before + 1);
  assert.ok(
    server.requests.every((r) => r.key === ALICE_KEY),
    'only Alice’s own key',
  );
  // The answer is not a chat message: no reply tag, no command tag.
  assert.ok(!answer.tags.some((t) => ['e', COMMAND_TAG].includes(t[0])));
  // Its buttons are a valid view of the card: pressing them works too.
  const again = await press(bot, alice, card, 'bal', { view: answer.id });
  checkAnswer(bot, alice, again);
  noSecrets(bot, logs, dir, server);
});

test('History pages through older payments with Older and Newer', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server);
  await sendDM(bot, alice, '/history');
  const card = last(bot, alice);
  assert.match(card.content, /^Last 1 settled payment .*\n\+1 sat · .* · newest$/);
  assert.deepEqual(data(card).slice(0, 1), ['hist:1']);
  const older = checkAnswer(bot, alice, await press(bot, alice, card, 'hist:1'));
  assert.match(older.content, /^Settled payments 2–2, newest first .*\n\+2 sats · .* · middle$/);
  assert.deepEqual(data(older).slice(0, 2), ['hist:2', 'hist:0']);
  const oldest = checkAnswer(
    bot,
    alice,
    await press(bot, alice, card, 'hist:2', { view: older.id }),
  );
  assert.match(oldest.content, /oldest$/);
  assert.ok(!data(oldest).includes('hist:3'), 'no Older on the last page');
  const newer = checkAnswer(
    bot,
    alice,
    await press(bot, alice, card, 'hist:1', { view: oldest.id }),
  );
  assert.match(newer.content, /middle$/);
  assert.deepEqual(
    server.requests.filter((r) => r.path === '/api/v1/payments').map((r) => r.query.offset),
    [undefined, '1', '2', '1'],
  );
});

test('a retried request gets the identical answer; nothing is asked or done twice', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server);
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  const request = pressRumor(alice, bot, card, 'bal');
  await deliver(bot, request, alice);
  const first = checkAnswer(bot, alice, request);
  const sentBefore = bot.state.outbox.map((item) => item.event.id);
  const lnbitsBefore = server.requests.length;
  // A relay resends it while the answer is still queued: nothing new.
  await deliver(bot, request, alice);
  assert.deepEqual(
    bot.state.outbox.map((item) => item.event.id),
    sentBefore,
  );
  // The answer was published, then the app retries: the same encrypted event again.
  const stored = bot.state.callbacks[`${getPublicKey(alice)}:${parseControl(request.tags).id}`];
  bot.state.outbox = [];
  await deliver(bot, request, alice);
  assert.deepEqual(
    bot.state.outbox.map((item) => item.event.id),
    [stored.delivery.event.id],
  );
  assert.equal(server.requests.length, lnbitsBefore, 'LNbits not asked again');
  assert.equal(answerTo(bot, alice, request)[0].id, first.id);
  // The same request id with different contents is refused: no answer at all, not even
  // the stored one.
  bot.state.outbox = [];
  const altered = pressRumor(alice, bot, card, 'hist:0', { id: parseControl(request.tags).id });
  await deliver(bot, altered, alice);
  assert.equal(bot.state.outbox.length, 0);
  assert.equal(server.requests.length, lnbitsBefore);
});

test('presses that fail any check get no answer and never reach LNbits', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs } = buttonBot(t, server);
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  await sendDM(bot, bob, '/balance');
  const bobCard = last(bot, bob);
  const lnbitsBefore = server.requests.length;
  const outboxBefore = bot.state.outbox.length;
  const time = now();
  const target = (fields) => ({
    type: 'dm',
    chat: bot.pubkey,
    root: card.id,
    version: card.id,
    bot: bot.pubkey,
    ...fields,
  });
  const other = getPublicKey(generateSecretKey());
  const refused = [
    ['expired', { created: time, expires: time }],
    ['valid longer than five minutes', { created: time, expires: time + 301 }],
    ['written long ago', { created: time - 301, expires: time + 10 }],
    ['written in the future', { created: time + 120 }],
    ['not empty', { content: 'hi' }],
    ['another bot', { target: target({ bot: other, chat: other }) }],
    ['an edited card version', { target: target({ version: 'ee'.repeat(32) }) }],
    ['an unknown card', { target: target({ root: 'cd'.repeat(32), version: 'cd'.repeat(32) }) }],
    ['an unknown view', { view: 'ab'.repeat(32) }],
  ];
  for (const [why, options] of refused) {
    await press(bot, alice, card, 'bal', options);
    assert.equal(bot.state.outbox.length, outboxBefore, why);
  }
  // A button the card does not have, and malformed or doubled tags.
  await press(bot, alice, card, 'inv:999');
  await press(bot, alice, card, 'bal', { tags: [['p', bot.pubkey]] });
  await press(bot, alice, card, 'bal', {
    tags: [
      ['p', bot.pubkey],
      ['p', other],
      [CONTROL_TAG, '1', JSON.stringify({ op: 'request' })],
    ],
  });
  // Bob's card pressed by Alice; Alice's card pressed by a stranger.
  await press(bot, alice, bobCard, 'bal');
  await press(bot, mallory, card, 'bal');
  // A rumor claiming to be Alice, sealed by someone else: unwrap refuses it.
  await deliver(bot, pressRumor(alice, bot, card, 'bal'), mallory);
  // A request for the private-group or public type is never answered by this DM-only bot.
  await press(bot, alice, card, 'bal', {
    target: {
      type: 'public',
      chat: `34550:${other}:room`,
      root: card.id,
      version: card.id,
      bot: bot.pubkey,
    },
  });
  assert.equal(bot.state.outbox.length, outboxBefore);
  assert.equal(server.requests.length, lnbitsBefore);
  assert.ok(
    logs.some((l) => l.includes(npub(mallory))),
    'the stranger is logged, not answered',
  );
});

test('a relinked or switched-off wallet makes old menus stale', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'relink');
  const first = buttonBot(t, server, { dir });
  await sendDM(first.bot, alice, '/balance');
  const card = last(first.bot, alice);
  await first.bot.close();
  // The operator links another wallet to Alice: her old buttons must not read it.
  const wallets = new Wallets([
    [npub(alice), { label: 'Alice other wallet', invoiceKey: OTHER_KEY }],
    [npub(bob), { label: 'Bob test wallet', invoiceKey: BOB_KEY }],
  ]);
  const second = buttonBot(t, server, { dir, wallets });
  const before = server.requests.length;
  const stale = checkAnswer(second.bot, alice, await press(second.bot, alice, card, 'bal'));
  assert.match(stale.content, /no longer linked to you/);
  assert.deepEqual(keyboardFromTags(stale.tags).inline_keyboard, []);
  assert.equal(server.requests.length, before, 'the new wallet was not read');
  // A fresh menu works with the new wallet.
  await sendDM(second.bot, alice, '/balance');
  const fresh = last(second.bot, alice);
  second.bot.wallets.disable(getPublicKey(alice), 'test');
  const off = checkAnswer(second.bot, alice, await press(second.bot, alice, fresh, 'bal'));
  assert.match(off.content, /switched off/);
});

test('a preset button creates one invoice, shows it again, and never creates a second', async (t) => {
  const server = await mockLNbits(t);
  const { bot, logs, dir } = buttonBot(t, server);
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  const request = await press(bot, alice, card, 'inv:5000');
  // The invoice is a message of its own; the menu says where it went and stays a menu.
  const answer = checkAnswer(bot, alice, request);
  assert.match(answer.content, /invoice for 5,000 sats is in the message below/);
  assert.ok(data(answer).includes('bal'));
  const invoiceCard = repliesFor(bot, alice).findLast((m) => m.kind === 14);
  const bolt11 = bolt11Of(invoiceCard.content);
  assert.match(invoiceCard.content, /^Invoice for 5,000 sats \(valid for 60 minutes\):\nln/);
  assert.equal(copyText(invoiceCard), bolt11, 'Copy invoice copies exactly the invoice');
  assert.ok(!invoiceCard.tags.some((t) => t[0] === 'e'), 'not a reply to anything');
  assert.equal(server.posts.length, 1);
  assert.equal(server.posts[0].key, ALICE_KEY);
  assert.equal(server.posts[0].body.amount, 5000);
  const [record] = bot.state.invoices;
  assert.equal(record.state, 'created');
  assert.equal(record.messageId, request.id);
  assert.match(record.trigger, /^[a-f0-9]{32}$/);
  assert.equal(server.posts[0].body.external_id, externalId(record));
  // The app gives up and the person presses again: a new request id, same button.
  const retry = await press(bot, alice, card, 'inv:5000');
  assert.equal(bolt11Of(checkAnswer(bot, alice, retry).content), bolt11);
  assert.equal(server.posts.length, 1, 'no second invoice');
  // Once paid, the same button makes a new one.
  server.wallets[ALICE_KEY].payments.find((p) => p.bolt11 === bolt11).status = 'success';
  const after = await press(bot, alice, card, 'inv:5000');
  checkAnswer(bot, alice, after);
  assert.notEqual(bolt11Of(repliesFor(bot, alice).findLast((m) => m.kind === 14).content), bolt11);
  assert.equal(server.posts.length, 2);
  // The usual limits apply: one open request at a time, hourly count, maximum amount.
  assert.equal(bot.state.invoices.filter((r) => r.state === 'created').length, 2);
  noSecrets(bot, logs, dir, server);
});

test('Check status reports unpaid, paid and expired invoices from LNbits', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server);
  await sendDM(bot, alice, '/invoice 1000 coffee');
  const card = last(bot, alice);
  assert.equal(copyText(card), bolt11Of(card.content), '/invoice replies have the copy button');
  const status = data(card).find((d) => d.startsWith('st:'));
  assert.match(status, /^st:[a-f0-9]{12}$/);
  const refresh = status.replace('st:', 'iv:0:');
  const unpaid = checkAnswer(bot, alice, await press(bot, alice, card, status));
  assert.match(
    unpaid.content,
    /^Invoice for 1,000 sats \(coffee\): not paid yet\. It can be paid until \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\nStatus: Pending/,
  );
  assert.ok(data(unpaid).includes(refresh), 'can check again');
  assert.equal(copyText(unpaid), bolt11Of(card.content));
  assert.ok(unpaid.content.includes(bolt11Of(card.content)), 'and it is there to read');
  server.created[0].status = 'success';
  const paid = checkAnswer(bot, alice, await press(bot, alice, card, refresh, { view: unpaid.id }));
  assert.match(paid.content, /^Invoice for 1,000 sats \(coffee\): paid\.\nStatus: Paid/);
  assert.ok(!paid.content.includes(bolt11Of(card.content)), 'nothing more to pay');
  assert.equal(copyText(paid), undefined);
  bot.state.invoices[0].payment = undefined;
  server.created[0].status = 'pending';
  bot.state.invoices[0].expiresAt -= 3601;
  const expired = checkAnswer(bot, alice, await press(bot, alice, card, status));
  assert.match(expired.content, /expired without payment/);
  assert.equal(server.posts.length, 1, 'status never creates anything');
  // Every lookup used Alice's key and the request's external id.
  const lookups = server.requests.filter((r) => r.query.external_id);
  assert.ok(lookups.length === 3 && lookups.every((r) => r.key === ALICE_KEY));
});

test('a press too close to its expiry creates nothing; a late invoice becomes a message', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server, { buttonMargin: 30, timeoutMs: 5000 });
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  const soon = await press(bot, alice, card, 'inv:1000', { expires: now() + 10 });
  assert.match(checkAnswer(bot, alice, soon).content, /too late to create an invoice safely/);
  assert.equal(server.posts.length, 0);

  // LNbits answers after the request expired: the app would ignore an answer now, so the
  // invoice arrives as an ordinary message with its buttons, and is recorded as created.
  bot.buttonMargin = 0;
  server.create = 'slow';
  server.storeDelayMs = 3200;
  const late = pressRumor(alice, bot, card, 'inv:1000', { expires: now() + 2 });
  bot.receive(wrap(late, alice, bot.pubkey), bot.key);
  await new Promise((r) => setTimeout(r, 3700));
  await settle(bot);
  assert.equal(answerTo(bot, alice, late).length, 0, 'no answer after expiry');
  const message = last(bot, alice);
  assert.equal(message.kind, 14);
  assert.ok(!message.tags.some((t) => ['e', COMMAND_TAG].includes(t[0])), 'not a reply');
  assert.equal(bolt11Of(message.content), server.created[0].bolt11);
  assert.ok(data(message).some((d) => d.startsWith('st:')));
  assert.equal(bot.state.invoices[0].state, 'created');
  assert.ok(bot.state.cards[message.id], 'the message is a card of its own');
});

test('an uncertain preset invoice is looked up and sent as a message, never created twice', async (t) => {
  const server = await mockLNbits(t);
  // Lookups well after the second press, so it meets the request still unknown.
  const { bot } = buttonBot(t, server, { timeoutMs: 150, checkDelays: [0.5, 0.5, 0.5] });
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  server.create = 'store-hang';
  const request = await press(bot, alice, card, 'inv:1000');
  assert.match(checkAnswer(bot, alice, request).content, /did not confirm whether it created/);
  // Pressing again while it is unknown: told to wait, nothing sent to LNbits.
  const again = await press(bot, alice, card, 'inv:1000');
  assert.match(checkAnswer(bot, alice, again).content, /still checking your previous invoice/);
  for (let i = 0; i < 60 && bot.state.invoices[0].state !== 'created'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await settle(bot);
  }
  assert.equal(bot.state.invoices[0].state, 'created');
  const found = last(bot, alice);
  assert.equal(found.kind, 14);
  assert.ok(!found.tags.some((t) => t[0] === 'e'), 'a message of its own, not a reply');
  assert.equal(bolt11Of(found.content), server.created[0].bolt11);
  assert.equal(copyText(found), server.created[0].bolt11);
  assert.equal(server.posts.length, 1);
});

test('menus, views and answers survive a restart; an interrupted preset is never resent', async (t) => {
  const server = await mockLNbits(t);
  const dir = tempDir(t, 'buttons-restart');
  const first = buttonBot(t, server, { dir });
  await sendDM(first.bot, alice, '/balance');
  const card = last(first.bot, alice);
  const request = await press(first.bot, alice, card, 'hist:0');
  const answer = checkAnswer(first.bot, alice, request);
  const stored =
    first.bot.state.callbacks[`${getPublicKey(alice)}:${parseControl(request.tags).id}`].delivery;
  // A preset whose LNbits request is cut off by the shutdown: "uncertain" on disk.
  server.create = 'store-hang';
  const pending = pressRumor(alice, first.bot, card, 'inv:1000');
  first.bot.receive(wrap(pending, alice, first.bot.pubkey), first.bot.key);
  for (let i = 0; i < 40 && !server.posts.length; i++) await new Promise((r) => setTimeout(r, 10));
  await first.bot.close();
  assert.equal(server.posts.length, 1);

  server.create = 'ok';
  const second = buttonBot(t, server, { dir });
  // The answered request, retried after the restart: the stored answer, not a new one.
  second.bot.state.outbox = [];
  const before = server.requests.length;
  await deliver(second.bot, request, alice);
  assert.deepEqual(
    second.bot.state.outbox.map((i) => i.event.id),
    [stored.event.id],
  );
  assert.equal(server.requests.length, before);
  // The answer's buttons still work after the restart.
  checkAnswer(second.bot, alice, await press(second.bot, alice, card, 'bal', { view: answer.id }));
  // The interrupted preset: looked up by external id at startup, never sent again.
  await second.bot.start();
  for (let i = 0; i < 60 && second.bot.state.invoices[0].state !== 'created'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await settle(second.bot);
  }
  assert.equal(second.bot.state.invoices[0].state, 'created');
  assert.equal(server.posts.length, 1, 'never a second creation request');
  // The app retries the interrupted press with its original request: no new invoice.
  await deliver(second.bot, pending, alice);
  assert.equal(server.posts.length, 1);
});

test('corrupt button state stops startup instead of trusting it', (t) => {
  const dir = tempDir(t, 'buttons-corrupt');
  for (const bad of [
    { cards: { nothex: { owner: 'x' } } },
    {
      cards: {
        ['ab'.repeat(32)]: { owner: getPublicKey(alice), ref: 'zz', at: 1, data: [], views: [] },
      },
    },
    { callbacks: { x: { fingerprint: 'nope', expires: 1, delivery: {} } } },
    { cards: [] },
  ]) {
    const store = new State(dir);
    Object.assign(store.data, { cards: {}, callbacks: {} }, bad);
    try {
      assert.throws(
        () => new WalletBot({ store, net: fakeNet(), wallets: linked(), log: () => {} }),
        /Invalid button records/,
      );
    } finally {
      store.close();
    }
  }
});

test('presses count against the hourly limit', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server, { limits: { requestsPerHour: 2 } });
  await sendDM(bot, alice, '/balance');
  const card = last(bot, alice);
  checkAnswer(bot, alice, await press(bot, alice, card, 'bal'));
  const limited = checkAnswer(bot, alice, await press(bot, alice, card, 'bal'));
  assert.match(limited.content, /hourly limit/);
  const outbox = bot.state.outbox.length;
  await press(bot, alice, card, 'bal');
  assert.equal(bot.state.outbox.length, outbox, 'then silence');
});

test('invoice presets are configurable by the operator', () => {
  const env = { LNBITS_URL: 'https://lnbits.example' };
  assert.deepEqual(loadConfig(env).limits.presets, [1000, 5000]);
  assert.deepEqual(
    loadConfig({ ...env, INVOICE_PRESETS: '100, 2100' }).limits.presets,
    [100, 2100],
  );
  assert.deepEqual(loadConfig({ ...env, INVOICE_PRESETS: 'off' }).limits.presets, []);
  // Defaults above a lower invoice limit are left out; explicit ones are refused.
  assert.deepEqual(invoicePresets({}, 5000), [1000, 5000]);
  for (const bad of ['1000,1000', '0', '1e3', '1,2,3,4,5', '1.5', '200000', 'abc'])
    assert.throws(() => loadConfig({ ...env, INVOICE_PRESETS: bad }), /INVOICE_PRESETS/, bad);
});

test('with presets off the menu has no invoice buttons', async (t) => {
  const server = await mockLNbits(t);
  const { bot } = buttonBot(t, server, { limits: { presets: [] }, wallets: linked() });
  await sendDM(bot, alice, '/balance');
  assert.deepEqual(data(last(bot, alice)), ['bal', 'hist:0', 'iv:0']);
});

test('cards are kept for a month, at most a hundred per person', () => {
  const time = 2_000_000_000;
  let clock = time;
  const state = {};
  const buttons = new Buttons(state, () => clock);
  const keyboard = { inline_keyboard: [[{ text: 'x', callback_data: 'bal' }]] };
  const owner = 'a'.repeat(64);
  const ref = 'b'.repeat(32);
  const id = (n) => n.toString(16).padStart(64, '0');
  for (let n = 0; n < 150; n++) {
    clock = time + n;
    buttons.addCard(id(n), { owner, ref, keyboard });
  }
  assert.equal(Object.keys(state.cards).length, 100);
  assert.ok(state.cards[id(149)], 'the newest stays');
  assert.equal(state.cards[id(0)], undefined, 'the oldest goes');
  buttons.addCard(id(200), { owner: 'c'.repeat(64), ref, keyboard });
  clock += 31 * 86400;
  buttons.prune();
  assert.equal(Object.keys(state.cards).length, 0, 'older than a month');
});
