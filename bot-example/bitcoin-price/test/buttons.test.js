// Inline buttons: cards, private answers, replays, expiry and authorization in every chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { PriceBot } from '../bot.js';
import { UNAVAILABLE } from '../commands.js';
import { PriceFeed } from '../price.js';
import { directMessage } from '../direct-messages.js';
import { acceptTicket, privateMessage } from '../private-groups.js';
import { acceptRoom, publicMessage } from '../public-groups.js';
import { now, rumor, sign, State, unwrap, wrap } from '../runtime.js';
import {
  BOT_CONTROL_KIND,
  commandFromTags,
  controlTag,
  keyboardFromTags,
  parseControl,
} from '../botKeyboardProtocol.ts';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });
const PRICES = '{"USD":67123.4,"EUR":58234,"JPY":10123456}';
const button = (code) => ({ text: code, callback_data: `price:${code}`, size: 'small' });
const REFRESH_ROW = [{ text: 'Refresh', callback_data: 'refresh', size: 'small' }];

function setup(t, fetchText = async () => PRICES, options = {}) {
  const dir = mkdtempSync(`${parent}buttons-`);
  const feed = new PriceFeed({ fetchText, log() {}, ...options });
  const net = {
    configured: ['wss://relay.example/'],
    routes: (hints = []) => ['wss://relay.example/', ...hints],
    query: async () => [],
    publish: async () => {},
    close() {},
    watch: () => () => {},
  };
  let bot = new PriceBot({ store: new State(dir), net, feed, cooldown: 0, log() {} });
  t.after(async () => {
    await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get bot() {
      return bot;
    },
    async restart() {
      await bot.close();
      bot = new PriceBot({ store: new State(dir), net, feed, cooldown: 0, log() {} });
      return bot;
    },
  };
}
// What Anagram sends when a button is pressed: a kind 21118 rumor, gift-wrapped to the bot.
function press(user, bot, card, data = 'price:EUR', extra = {}) {
  const id = Buffer.from(generateSecretKey()).toString('hex').slice(0, 32);
  const request = { op: 'request', id, target: card.target, expires: now() + 300, data, ...extra };
  const event = {
    ...rumor(user, [['p', bot.pubkey], controlTag(request)], ''),
    kind: BOT_CONTROL_KIND,
  };
  event.id = getEventHash(event);
  return event;
}
async function deliver(bot, event, user) {
  bot.receive(wrap(event, user, bot.pubkey), bot.key);
  await bot.work;
}
// The bot's personal answers queued for one person, oldest first.
const answers = (bot, user) =>
  bot.state.outbox
    .map((item) => unwrap(item.event, user)?.message)
    .filter((message) => message?.kind === BOT_CONTROL_KIND);
const onlyCard = (bot) => {
  const cards = Object.values(bot.state.cards);
  assert.equal(cards.length, 1);
  return cards[0];
};
function ticket(group, member, epochKey, epoch = 0) {
  const signed = sign(
    group,
    1014,
    [
      ['p', member],
      ['epoch', String(epoch)],
    ],
    Buffer.from(epochKey).toString('hex'),
  );
  const { sig, ...message } = signed;
  return { message, seal: { tags: [['invitation_proof', sig]] }, signed };
}
const room = (owner, bot, extra = [], time = now()) =>
  sign(
    owner,
    34550,
    [
      ['d', 'btc-room'],
      ['name', 'BTC room'],
      ['anagram-room', '1'],
      ['relay', 'wss://relay.example/'],
      ['trusted', bot.pubkey],
      ...extra,
    ],
    '',
    time,
  );

test('dm: a price reply is a card; a press is answered privately in that currency with the same buttons', async (t) => {
  const { bot } = setup(t);
  const user = generateSecretKey(),
    pub = getPublicKey(user);
  const command = rumor(user, [['p', bot.pubkey]], 'price');
  await directMessage(bot, command, { tags: [] });
  const reply = unwrap(bot.state.outbox[0].event, user).message;
  const keyboard = keyboardFromTags(reply.tags);
  assert.deepEqual(keyboard, {
    inline_keyboard: [[button('USD'), button('EUR'), button('JPY')], REFRESH_ROW],
  });
  assert.equal(commandFromTags(reply.tags), command.id, 'Anagram may collapse the command');
  assert.ok(!reply.content.includes('callback_data'), 'other clients see only the text');
  const card = onlyCard(bot);
  assert.deepEqual(card, {
    target: { type: 'dm', chat: bot.pubkey, root: reply.id, version: reply.id, bot: bot.pubkey },
    recipient: pub,
    keyboard,
    currency: 'USD',
    at: card.at,
    views: {},
  });

  const request = press(user, bot, card, 'price:EUR');
  await deliver(bot, request, user);
  const [answer] = answers(bot, user);
  assert.equal(answer.content, 'BTC: €58,234 EUR');
  assert.equal(answer.pubkey, bot.pubkey);
  assert.deepEqual(answer.tags[0], ['p', pub]);
  assert.ok(!answer.tags.some((tag) => tag[0] === 'e'), 'an answer is not a timeline reply');
  const { id, expires } = parseControl(request.tags);
  assert.deepEqual(parseControl(answer.tags), { op: 'answer', id, target: card.target, expires });
  assert.deepEqual(keyboardFromTags(answer.tags), keyboard, 'the next press works from the answer');
  assert.deepEqual(card.views[pub], [{ id: answer.id, currency: 'EUR' }]);
  assert.equal(bot.state.outbox.length, 3, 'two copies of the reply and one personal answer');

  // Pressing on the personal answer names it as the view; an unknown view is refused.
  await deliver(bot, press(user, bot, card, 'price:JPY', { view: answer.id }), user);
  assert.equal(answers(bot, user)[1].content, 'BTC: ¥10,123,456 JPY');
  await deliver(bot, press(user, bot, card, 'price:USD', { view: 'a'.repeat(64) }), user);
  assert.equal(answers(bot, user).length, 2);
  // The original card keeps working too (another device shows no personal view).
  await deliver(bot, press(user, bot, card, 'price:USD'), user);
  assert.equal(answers(bot, user)[2].content, 'BTC: $67,123 USD');
  assert.equal(card.views[pub].length, 3);
});

test('Refresh asks again for the currency shown, and a currency the provider dropped is reported', async (t) => {
  let prices = PRICES;
  const { bot } = setup(t, async () => prices, { cacheSeconds: 0 });
  const user = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price JPY'), { tags: [] });
  const card = onlyCard(bot);
  assert.equal(card.currency, 'JPY');
  prices = '{"USD":70000,"EUR":60000,"JPY":11000000}';
  await deliver(bot, press(user, bot, card, 'refresh'), user);
  const [first] = answers(bot, user);
  assert.equal(
    first.content,
    'BTC: ¥11,000,000 JPY',
    'the card shows JPY, so Refresh asks for JPY',
  );
  await deliver(bot, press(user, bot, card, 'price:EUR', { view: first.id }), user);
  const [, eur] = answers(bot, user);
  assert.equal(eur.content, 'BTC: €60,000 EUR');
  prices = '{"USD":71000,"EUR":61000,"JPY":11100000}';
  await deliver(bot, press(user, bot, card, 'refresh', { view: eur.id }), user);
  assert.equal(answers(bot, user)[2].content, 'BTC: €61,000 EUR', 'a view keeps its currency');
  prices = '{"USD":72000}';
  await deliver(bot, press(user, bot, card, 'price:JPY'), user);
  const dropped = answers(bot, user)[3];
  assert.equal(dropped.content, 'Unsupported currency JPY. Available: USD.');
  assert.deepEqual(keyboardFromTags(dropped.tags), card.keyboard, 'the buttons stay as they were');
  await deliver(bot, press(user, bot, card, 'refresh', { view: dropped.id }), user);
  assert.equal(answers(bot, user)[4].content, 'Unsupported currency JPY. Available: USD.');
  await deliver(bot, press(user, bot, card, 'refresh', { view: 'e'.repeat(64) }), user);
  assert.equal(answers(bot, user).length, 5, 'Refresh from an unknown view is refused too');
});

test('a repeated press gets the stored answer again, also after a restart; a reused id with other data gets nothing', async (t) => {
  const fixture = setup(t);
  let bot = fixture.bot;
  const user = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price'), { tags: [] });
  const card = onlyCard(bot);
  const request = press(user, bot, card, 'price:EUR');
  await deliver(bot, request, user);
  await deliver(bot, request, user);
  assert.equal(answers(bot, user).length, 1, 'a duplicate delivery is not answered twice');
  const [answer] = answers(bot, user);
  const [stored] = bot.state.outbox.filter(
    (item) => unwrap(item.event, user)?.message.kind === BOT_CONTROL_KIND,
  );
  await bot.flush();
  assert.equal(bot.state.outbox.length, 0);
  await deliver(bot, request, user);
  assert.equal(bot.state.outbox.length, 1, 'a retry after delivery resends the same answer');
  assert.equal(bot.state.outbox[0].event.id, stored.event.id);
  assert.equal(answers(bot, user)[0].id, answer.id);
  await bot.flush();

  // Same operation id, different contents: refused rather than answered again.
  const control = parseControl(request.tags);
  const altered = {
    ...rumor(user, [['p', bot.pubkey], controlTag({ ...control, data: 'price:JPY' })], ''),
    kind: BOT_CONTROL_KIND,
  };
  altered.id = getEventHash(altered);
  await deliver(bot, altered, user);
  assert.equal(bot.state.outbox.length, 0);

  bot = await fixture.restart();
  assert.ok(bot.state.cards[card.target.root], 'cards survive a restart');
  await deliver(bot, request, user);
  assert.equal(bot.state.outbox[0].event.id, stored.event.id, 'the stored answer survives too');
  await deliver(bot, press(user, bot, card, 'price:USD'), user);
  assert.equal(answers(bot, user).length, 2, 'new presses still work after a restart');
});

test('presses are refused when expired, from another person, for another version, for a missing button or without a card', async (t) => {
  const { bot } = setup(t);
  const user = generateSecretKey(),
    other = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price'), { tags: [] });
  const card = onlyCard(bot);
  const refused = [
    press(user, bot, card, 'price:EUR', { expires: now() - 1 }),
    press(user, bot, card, 'price:EUR', { expires: now() + 301 }),
    press(user, bot, card, 'price:GBP'),
    press(user, bot, card, 'vote:0'),
    press(user, bot, card, 'price:eur'),
    press(user, bot, { target: { ...card.target, version: 'b'.repeat(64) } }),
    press(user, bot, { target: { ...card.target, root: 'c'.repeat(64), version: 'c'.repeat(64) } }),
    press(user, bot, {
      target: { ...card.target, chat: getPublicKey(other), bot: getPublicKey(other) },
    }),
    { ...press(user, bot, card), content: 'not empty' },
    { ...press(user, bot, card), created_at: now() - 301 },
  ];
  for (const event of refused) {
    event.id = getEventHash(event);
    await deliver(bot, event, user);
  }
  await deliver(bot, press(other, bot, card), other);
  assert.equal(bot.state.outbox.length, 2, 'only the two copies of the reply were queued');
  assert.deepEqual(Object.keys(bot.state.callbacks), []);
  // A control rumor that is not a request is never treated as a message either.
  const stray = { ...rumor(user, [['p', bot.pubkey]], 'price'), kind: BOT_CONTROL_KIND };
  stray.id = getEventHash(stray);
  await deliver(bot, stray, user);
  assert.equal(bot.state.outbox.length, 2);
  assert.equal(bot.state.seen[stray.id], undefined);
  // Help and failure replies carry no buttons and leave no card behind.
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'hello'), { tags: [] });
  const help = unwrap(bot.state.outbox[2].event, user).message;
  assert.equal(keyboardFromTags(help.tags), null);
  assert.equal(commandFromTags(help.tags), null);
  assert.equal(Object.keys(bot.state.cards).length, 1);
});

test('a provider outage: no card without a price, and a press then answers unavailable but keeps the buttons', async (t) => {
  let fail = true;
  const { bot } = setup(
    t,
    async () => {
      if (fail) throw new Error('down');
      return PRICES;
    },
    { cacheSeconds: 0 },
  );
  const user = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price'), { tags: [] });
  const reply = unwrap(bot.state.outbox[0].event, user).message;
  assert.equal(reply.content, UNAVAILABLE);
  assert.equal(keyboardFromTags(reply.tags), null);
  assert.deepEqual(bot.state.cards, {});
  fail = false;
  bot.feed.failedAt = undefined; // Do not wait out the provider's retry pause.
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price JPY'), { tags: [] });
  const card = onlyCard(bot);
  fail = true;
  bot.feed.failedAt = undefined;
  await deliver(bot, press(user, bot, card, 'price:EUR'), user);
  const [stale] = answers(bot, user);
  assert.match(stale.content, /^BTC: €58,234 EUR\nStale price from less than a minute ago/);
  assert.deepEqual(keyboardFromTags(stale.tags), card.keyboard);
  bot.feed.cache = undefined;
  bot.feed.failedAt = undefined;
  await deliver(bot, press(user, bot, card, 'price:JPY'), user);
  const [, unavailable] = answers(bot, user);
  assert.equal(unavailable.content, UNAVAILABLE);
  assert.deepEqual(keyboardFromTags(unavailable.tags), card.keyboard, 'retry stays possible');
});

test('private group: a press needs the current invitation proof, and the answer carries the bot’s own', async (t) => {
  const { bot } = setup(t);
  const owner = generateSecretKey(),
    user = generateSecretKey(),
    stranger = generateSecretKey(),
    epochKey = generateSecretKey();
  const group = getPublicKey(owner),
    pub = getPublicKey(user);
  const invite = ticket(owner, bot.pubkey, epochKey);
  acceptTicket(bot, invite.message, invite.seal);
  const userTicket = ticket(owner, pub, epochKey);
  const membership = {
    epoch: 0,
    invited_at: userTicket.message.created_at,
    invitation_proof: userTicket.signed.sig,
  };
  await privateMessage(
    bot,
    rumor(
      user,
      [
        ['p', getPublicKey(epochKey)],
        ['h', group],
        ['epoch', '0'],
        ['invited_at', String(membership.invited_at)],
        ['invitation_proof', membership.invitation_proof],
      ],
      `price EUR nostr:${nip19.npubEncode(bot.pubkey)}`,
    ),
    group,
    getPublicKey(epochKey),
  );
  const card = onlyCard(bot);
  assert.deepEqual(card.target, {
    type: 'private',
    chat: group,
    root: card.target.root,
    version: card.target.root,
    bot: bot.pubkey,
  });
  assert.equal(card.recipient, undefined, 'a group card belongs to the whole group');
  const forged = ticket(owner, getPublicKey(stranger), epochKey);
  for (const bad of [
    { ...membership, invitation_proof: forged.signed.sig },
    { ...membership, invitation_proof: 'ab'.repeat(64) },
    { ...membership, epoch: 1 },
    { ...membership, invited_at: membership.invited_at + 1 },
  ])
    await deliver(bot, press(user, bot, card, 'price:JPY', { membership: bad }), user);
  await deliver(bot, press(stranger, bot, card, 'price:JPY', { membership }), stranger);
  assert.equal(answers(bot, user).length, 0);
  assert.equal(answers(bot, stranger).length, 0);
  await deliver(bot, press(user, bot, card, 'price:JPY', { membership }), user);
  const [answer] = answers(bot, user);
  assert.equal(answer.content, 'BTC: ¥10,123,456 JPY');
  assert.deepEqual(parseControl(answer.tags).membership, {
    epoch: 0,
    invited_at: invite.message.created_at,
    invitation_proof: invite.signed.sig,
  });
  // After a key rotation the old proof is worthless, even on an old card.
  const next = ticket(owner, bot.pubkey, generateSecretKey(), 1);
  acceptTicket(bot, next.message, next.seal);
  await deliver(bot, press(user, bot, card, 'price:USD', { membership }), user);
  assert.equal(answers(bot, user).length, 1);
});

test('public group: everyone may press while the bot is trusted; blocked people and an untrusted bot get nothing', async (t) => {
  const { bot } = setup(t);
  const owner = generateSecretKey(),
    user = generateSecretKey(),
    other = generateSecretKey();
  const event = room(owner, bot);
  const address = `34550:${event.pubkey}:btc-room`;
  acceptRoom(bot, event);
  const command = sign(user, 9, [['a', address]], `price nostr:${nip19.npubEncode(bot.pubkey)}`);
  await publicMessage(bot, command, address);
  const reply = bot.state.outbox[0].event;
  assert.equal(commandFromTags(reply.tags), command.id);
  const card = onlyCard(bot);
  assert.deepEqual(card.target, {
    type: 'public',
    chat: address,
    root: reply.id,
    version: reply.id,
    bot: bot.pubkey,
  });
  await deliver(bot, press(other, bot, card, 'price:EUR'), other);
  assert.equal(answers(bot, other)[0].content, 'BTC: €58,234 EUR');
  assert.equal(answers(bot, user).length, 0, 'answers are personal');
  acceptRoom(bot, room(owner, bot, [['blocked', getPublicKey(other)]], now() + 1));
  await deliver(bot, press(other, bot, card, 'price:JPY'), other);
  assert.equal(answers(bot, other).length, 1);
  await deliver(bot, press(user, bot, card, 'price:JPY'), user);
  assert.equal(answers(bot, user).length, 1);
  acceptRoom(
    bot,
    sign(
      owner,
      34550,
      event.tags.filter((t) => t[0] !== 'trusted'),
      '',
      now() + 2,
    ),
  );
  await deliver(bot, press(user, bot, card, 'price:USD'), user);
  assert.equal(answers(bot, user).length, 1, 'an untrusted bot has no interactive cards');
});

test('cards and replay markers are bounded and expire', async (t) => {
  const { bot } = setup(t);
  const user = generateSecretKey();
  const old = 'd'.repeat(64);
  bot.state.cards[old] = { target: {}, keyboard: {}, at: now() - 8 * 86400, views: {} };
  for (let i = 0; i < 1000; i++)
    bot.state.cards[`${i}`.padStart(64, '0')] = {
      target: {},
      keyboard: {},
      at: now() - 1000 + i,
      views: {},
    };
  bot.state.callbacks['x:y'] = { expires: now() - 301, fingerprint: 'z', delivery: {} };
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price'), { tags: [] });
  assert.equal(bot.state.cards[old], undefined, 'week-old cards are dropped');
  assert.equal(Object.keys(bot.state.cards).length, 1000, 'the oldest card makes room');
  assert.equal(bot.state.cards['0'.repeat(64)], undefined);
  const card = Object.values(bot.state.cards).find((c) => c.recipient);
  await deliver(bot, press(user, bot, card), user);
  assert.equal(bot.state.callbacks['x:y'], undefined, 'expired replay markers are dropped');
  assert.equal(Object.keys(bot.state.callbacks).length, 1);
});
