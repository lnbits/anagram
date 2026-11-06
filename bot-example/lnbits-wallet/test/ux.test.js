// The Custom invoice button, /menu, /cancel, and buttons on payment notifications.
import './no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getEventHash, getPublicKey } from 'nostr-tools';
import { menuKeyboard } from '../buttons.js';
import { helpText } from '../commands.js';
import { Keyring } from '../keyring.js';
import { Ledger } from '../ledger.js';
import { LNbitsClient } from '../lnbits.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import {
  BOT_CONTROL_KIND,
  keyboardFromTags,
  parseKeyboard,
} from '../vendor/botKeyboardProtocol.ts';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  defer,
  dm,
  repliesFor,
  sendDM,
  settle,
  setup,
  tempDir,
} from './helpers.js';
import { lnbitsServer } from './lnbits-server.js';

const ORIGIN = 'https://lnbits.test/';
const SECOND_KEY = 'c0ffee00000000000000000000000004';
const A = getPublicKey(alice);

async function fixture(t, { limits = {}, ...options } = {}) {
  const server = await lnbitsServer({
    [ALICE_KEY]: { name: 'a', balance: 2_100_000, payments: [] },
    [SECOND_KEY]: { name: 'c', balance: 7_000, payments: [] },
    [BOB_KEY]: { name: 'b', balance: 42_000, payments: [] },
  });
  defer(t, () => server.close());
  const root = tempDir(t, 'ux');
  const secrets = join(root, 'secrets');
  const keyring = Keyring.init(secrets);
  const db = Store.create(join(root, DB_FILE));
  const ledger = Ledger.create(secrets, keyring, db.getMeta('store_id'));
  const registry = new Registry({ store: db, keyring, ledger });
  const link = (key, invoiceKey, label) =>
    registry.connect({ owner: getPublicKey(key), label, origin: ORIGIN, secret: { invoiceKey } });
  const main = link(alice, ALICE_KEY, 'Main');
  const lnbits = new LNbitsClient({ url: server.url, timeoutMs: 2000 });
  const ctx = setup(t, { wallets: registry, lnbits, limits, ...options });
  defer(t, () => db.close());
  return { server, registry, main, link, ...ctx };
}
function press(bot, key, card, data, { view } = {}) {
  const request = {
    op: 'request',
    id: randomBytes(16).toString('hex'),
    target: { type: 'dm', chat: bot.pubkey, root: card.id, version: card.id, bot: bot.pubkey },
    data,
    expires: Math.floor(Date.now() / 1000) + 300,
    ...(view ? { view } : {}),
  };
  const message = {
    kind: BOT_CONTROL_KIND,
    pubkey: getPublicKey(key),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', bot.pubkey],
      ['anagram-bot', '1', JSON.stringify(request)],
    ],
    content: '',
  };
  message.id = getEventHash(message);
  bot.buttonRequest(message);
  return settle(bot);
}
const buttons = (m) => keyboardFromTags(m.tags).inline_keyboard.flat();
const answer = (bot, key = alice) =>
  repliesFor(bot, key)
    .filter((r) => r.kind === BOT_CONTROL_KIND)
    .at(-1);
const lastMessage = (bot, key = alice) =>
  repliesFor(bot, key)
    .filter((r) => r.kind === 14)
    .at(-1);
const menu = async (bot, key = alice) => {
  await sendDM(bot, key, '/menu');
  return lastMessage(bot, key);
};

test('/menu offers everything; Custom replaces the big preset; keyboards stay valid', async (t) => {
  const { bot } = await fixture(t);
  const card = await menu(bot);
  assert.equal(card.content, 'What would you like to do? (Main)');
  assert.deepEqual(
    buttons(card).map((b) => b.text),
    [
      'Refresh balance',
      'History',
      '⚡ 1,000 sats',
      '⚡ 5,000 sats',
      '⚡ Custom',
      'Invoices',
      'Wallets',
    ],
  );
  for (const presets of [[], [1], [1, 2, 3], [1, 2, 3, 4]]) {
    const keyboard = menuKeyboard(presets, { manageable: true });
    assert.ok(parseKeyboard(keyboard), `${presets.length} presets stay valid`);
    assert.ok(keyboard.inline_keyboard.every((row) => row.length <= 4));
    assert.equal(
      keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'inv:custom'),
      presets.length > 0,
      'with invoice buttons off there is no Custom either',
    );
  }
  assert.match(helpText('', {}), /\/menu — /);
  assert.match(helpText('', {}), /\/cancel — /);
  assert.match(helpText('', {}), /I cannot send payments/);
  assert.ok(!/\/send/.test(helpText('', {})));
  assert.match(helpText('', { sending: true }), /\/send <invoice>/);
  assert.ok(!/receive only/.test(helpText('', { sending: true })), 'never claims what is not true');
});

test('Custom asks for an amount; the next message makes one invoice, with its note', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  assert.match(answer(bot).content, /^How many sats\?/);
  assert.match(answer(bot).content, /for Main/);
  assert.match(answer(bot).content, /\/cancel/);
  assert.deepEqual(
    buttons(answer(bot)).map((b) => b.callback_data),
    ['inv:cancel'],
  );
  assert.equal(server.posts.length, 0);

  await sendDM(bot, alice, '2100 coffee and cake');
  assert.match(lastMessage(bot).content, /^Invoice for 2,100 sats/);
  assert.match(lastMessage(bot).content, /Memo: coffee and cake/);
  assert.equal(server.posts.length, 1);
  assert.equal(server.posts[0].body.amount, 2100);
  assert.equal(server.posts[0].key, ALICE_KEY);

  // Answered: the next number is an ordinary message again.
  await sendDM(bot, alice, '5000');
  assert.equal(server.posts.length, 1);
  assert.match(lastMessage(bot).content, /Commands:/);
});

test('anything but a whole number is refused, and it keeps waiting', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  for (const text of ['abc', '1.5', '1e3', '-5', '0', '007', '1,000', 'twenty sats']) {
    await sendDM(bot, alice, text);
    assert.match(lastMessage(bot).content, /whole number of sats/, text);
  }
  assert.equal(server.posts.length, 0);
  await sendDM(bot, alice, '100001');
  assert.match(lastMessage(bot).content, /from 1 to 100,000/);
  assert.equal(server.posts.length, 0);
  await sendDM(bot, alice, '/cancel');
  await sendDM(bot, alice, '7');
  assert.equal(server.posts.length, 0);
});

test('an amount over the limit can be corrected without pressing Custom again', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, '100001');
  assert.match(lastMessage(bot).content, /from 1 to 100,000\. Send another amount, or \/cancel/);
  assert.equal(server.posts.length, 0, 'nothing created for the refused amount');
  assert.equal(bot.awaiting.has(A), true, 'still waiting');

  await sendDM(bot, alice, '500');
  assert.match(lastMessage(bot).content, /^Invoice for 500 sats/);
  assert.equal(server.posts.length, 1);
  assert.equal(server.posts[0].body.amount, 500);
  assert.equal(bot.awaiting.has(A), false, 'answered: the question is over');
  await sendDM(bot, alice, '600');
  assert.equal(server.posts.length, 1, 'a later number is an ordinary message');
  assert.match(lastMessage(bot).content, /Commands:/);
});

test('a note that is too long can be corrected too, and its first try creates nothing', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, `500 ${'x'.repeat(101)}`);
  assert.match(lastMessage(bot).content, /at most 100 characters.*Send another amount/s);
  assert.equal(server.posts.length, 0);
  assert.equal(bot.state.invoices.length, 0, 'no record either');
  await sendDM(bot, alice, '500 short note');
  assert.match(lastMessage(bot).content, /^Invoice for 500 sats/);
  assert.match(lastMessage(bot).content, /Memo: short note/);
  assert.equal(server.posts.length, 1);
});

test('retrying does not extend the five minutes, and nothing is created after them', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  const { at } = bot.awaiting.get(A);
  for (const text of ['abc', '100001', `5 ${'x'.repeat(101)}`]) {
    await sendDM(bot, alice, text);
    assert.equal(bot.awaiting.get(A).at, at, `${text.slice(0, 8)} does not restart the clock`);
  }
  bot.awaiting.get(A).at = at - 301;
  await sendDM(bot, alice, '500');
  assert.equal(server.posts.length, 0);
  assert.equal(bot.awaiting.has(A), false);
  assert.match(lastMessage(bot).content, /Commands:/);
});

test('/cancel and other commands still end it after a refused amount', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, '100001');
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /^Cancelled\. No invoice/);
  assert.equal(bot.awaiting.has(A), false);

  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, '100001');
  await sendDM(bot, alice, '/balance');
  assert.match(lastMessage(bot).content, /^Balance/);
  assert.equal(bot.awaiting.has(A), false);
  assert.equal(server.posts.length, 0);
});

test('retries count against the hourly limit: past it, nothing is answered or created', async (t) => {
  const { bot, server } = await fixture(t, { limits: { requestsPerHour: 3 } });
  await press(bot, alice, await menu(bot), 'inv:custom'); // /menu and the press: two of three
  await sendDM(bot, alice, '100001'); // the third
  assert.match(lastMessage(bot).content, /Send another amount/);
  await sendDM(bot, alice, '100001');
  assert.match(lastMessage(bot).content, /reached the hourly limit/);
  const answered = repliesFor(bot, alice).length;
  await sendDM(bot, alice, '500');
  assert.equal(repliesFor(bot, alice).length, answered, 'silence after the one notice');
  assert.equal(server.posts.length, 0);
});

test('retries cannot get around the limit on invoices', async (t) => {
  const { bot, server } = await fixture(t, { limits: { invoicesPerHour: 1 } });
  await sendDM(bot, alice, '/invoice 10');
  assert.equal(server.posts.length, 1);
  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, '100001');
  await sendDM(bot, alice, '500');
  assert.match(lastMessage(bot).content, /asked for 1 invoices in the last hour/);
  assert.equal(server.posts.length, 1);
});

test('a resent message is handled once, refused or not', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  const refused = dm(alice, '100001', bot);
  await bot.directMessage(refused, { tags: [] });
  await settle(bot);
  const answers = repliesFor(bot, alice).length;
  await bot.directMessage(refused, { tags: [] });
  await settle(bot);
  assert.equal(repliesFor(bot, alice).length, answers, 'a refused message is not answered twice');

  const good = dm(alice, '500', bot);
  await bot.directMessage(good, { tags: [] });
  await settle(bot);
  await bot.directMessage(good, { tags: [] });
  await settle(bot);
  assert.equal(server.posts.length, 1, 'one invoice, whatever a relay resends');
  assert.equal(bot.state.invoices.length, 1);
});

test('cancel by button or /cancel; a command replaces the question', async (t) => {
  const { bot, server } = await fixture(t);
  const card = await menu(bot);
  await press(bot, alice, card, 'inv:custom');
  await press(bot, alice, card, 'inv:cancel', { view: answer(bot).id });
  assert.match(answer(bot).content, /^Cancelled\. No invoice was created/);
  assert.ok(
    buttons(answer(bot)).some((b) => b.callback_data === 'bal'),
    'back to the menu',
  );
  await sendDM(bot, alice, '500');
  assert.equal(server.posts.length, 0);

  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /^Cancelled\. No invoice/);
  await sendDM(bot, alice, '/cancel');
  assert.match(lastMessage(bot).content, /nothing to cancel/);

  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, alice, '/balance');
  assert.match(lastMessage(bot).content, /^Balance/);
  await sendDM(bot, alice, '500');
  assert.equal(server.posts.length, 0, 'the question is gone');
});

test('it waits five minutes at most, and older messages are not answers', async (t) => {
  const { bot, server } = await fixture(t);
  await press(bot, alice, await menu(bot), 'inv:custom');
  const asked = bot.awaiting.get(A);
  const written = asked.at - 120;
  await bot.directMessage(dm(alice, '700', bot, [], written), { tags: [] });
  await settle(bot);
  assert.equal(server.posts.length, 0, 'written before the question');

  await press(bot, alice, await menu(bot), 'inv:custom');
  bot.awaiting.get(A).at -= 301;
  await sendDM(bot, alice, '700');
  assert.equal(server.posts.length, 0);
  assert.equal(bot.awaiting.has(A), false);
});

test('the amount goes to the wallet the menu was for, even after switching', async (t) => {
  const { bot, server, link, registry } = await fixture(t);
  const second = link(alice, SECOND_KEY, 'Second');
  await press(bot, alice, await menu(bot), 'inv:custom');
  assert.equal(registry.select(A, second.id), true);
  await sendDM(bot, alice, '300');
  assert.equal(server.posts[0].key, ALICE_KEY, 'not the wallet selected afterwards');
  await sendDM(bot, alice, '/invoice 400');
  assert.equal(server.posts[1].key, SECOND_KEY, 'new commands use the one in use');
});

test('disconnected while waiting: nothing is created in any wallet', async (t) => {
  const { bot, server, link, registry, main } = await fixture(t);
  link(alice, SECOND_KEY, 'Second');
  await press(bot, alice, await menu(bot), 'inv:custom');
  registry.revoke(main.id, 'user');
  await sendDM(bot, alice, '300');
  assert.equal(server.posts.length, 0);
  assert.match(lastMessage(bot).content, /no longer linked/);
});

test('it is per person, and a key pasted as the answer is still refused', async (t) => {
  const { bot, server, link } = await fixture(t);
  link(bob, BOB_KEY, 'Bob');
  await press(bot, alice, await menu(bot), 'inv:custom');
  await sendDM(bot, bob, '300');
  assert.equal(server.posts.length, 0, "Bob's number is not Alice's answer");
  await sendDM(bot, alice, `300 ${ALICE_KEY}`);
  assert.match(lastMessage(bot).content, /looks like it contains a wallet key/);
  assert.equal(server.posts.length, 0);
});

test('a preset keeps the menu a menu and sends the invoice as its own message', async (t) => {
  const { bot, server } = await fixture(t);
  const card = await menu(bot);
  await press(bot, alice, card, 'inv:1000');
  assert.match(answer(bot).content, /invoice for 1,000 sats is in the message below/);
  assert.ok(buttons(answer(bot)).some((b) => b.callback_data === 'bal'));
  const invoice = lastMessage(bot);
  assert.match(invoice.content, /^Invoice for 1,000 sats/);
  assert.ok(buttons(invoice).some((b) => b.text === 'Copy invoice'));
  assert.ok(buttons(invoice).some((b) => b.text === 'Check status'));
  assert.equal(server.posts.length, 1);
});

test('pressing a preset again from the menu it left behind shows the same invoice', async (t) => {
  const { bot, server } = await fixture(t);
  const card = await menu(bot);
  await press(bot, alice, card, 'inv:1000');
  const first = lastMessage(bot);
  const bolt11 = server.created[0].bolt11;
  assert.ok(first.content.includes(bolt11));
  // The answer's own buttons are a new view of the same menu.
  const view = answer(bot).id;
  assert.ok(buttons(answer(bot)).some((b) => b.callback_data === 'inv:1000'));
  await press(bot, alice, card, 'inv:1000', { view });
  assert.equal(server.posts.length, 1, 'no second invoice');
  assert.ok(answer(bot).content.includes(bolt11), 'the same one, shown again');
  assert.ok(buttons(answer(bot)).some((b) => b.text === 'Copy invoice'));
  assert.equal(bot.state.invoices.length, 1);
  assert.equal(lastMessage(bot).id, first.id, 'no new message either');

  // Pressing again from the original menu is the same button too.
  await press(bot, alice, card, 'inv:1000');
  assert.equal(server.posts.length, 1);

  // Another amount, or another menu, is another invoice.
  await press(bot, alice, card, 'inv:5000');
  assert.equal(server.posts.length, 2);
  const other = await menu(bot);
  await press(bot, alice, other, 'inv:1000');
  assert.equal(server.posts.length, 3);
});

test('after it is paid or expired, the same preset makes a new invoice', async (t) => {
  const { bot, server } = await fixture(t);
  const card = await menu(bot);
  await press(bot, alice, card, 'inv:1000');
  const view = answer(bot).id;
  server.created[0].status = 'success';
  await press(bot, alice, card, 'inv:1000', { view });
  assert.equal(server.posts.length, 2, 'the first was paid');
  const again = answer(bot).id;
  bot.state.invoices.at(-1).expiresAt -= 3601;
  await press(bot, alice, card, 'inv:1000', { view: again });
  assert.equal(server.posts.length, 3, 'the second expired');
});

test('payment notifications offer Refresh balance and History, for their own wallet', async (t) => {
  const { bot, server, registry, main, link } = await fixture(t, {
    notifications: { periodicMs: 30, triggerDelayMs: 5, recheckMs: 10, backoffMs: [20, 40] },
  });
  const second = link(alice, SECOND_KEY, 'Second');
  await bot.start();
  bot.flush = async () => {};
  for (let i = 0; i < 300 && !bot.state.payments[main.ref]; i++)
    await new Promise((r) => setTimeout(r, 5));
  server.settle(ALICE_KEY, { sats: 9, memo: 'hello' });
  for (let i = 0; i < 300 && !lastMessage(bot); i++) await new Promise((r) => setTimeout(r, 5));
  const notice = lastMessage(bot);
  assert.match(notice.content, /^Received \(Main\): \+9 sats/);
  assert.deepEqual(
    buttons(notice).map((b) => b.text),
    ['Refresh balance', 'History'],
  );

  registry.select(A, second.id);
  await press(bot, alice, notice, 'bal');
  assert.match(answer(bot).content, /Balance \(Main\)/, 'its own wallet, not the one in use');
  await press(bot, alice, notice, 'hist:0');
  assert.match(answer(bot).content, /hello/);

  // A notification still waiting for a relay goes with its wallet; the card is dead too.
  registry.revoke(main.id, 'user');
  await press(bot, alice, notice, 'bal');
  assert.match(answer(bot).content, /no longer linked/);
});
