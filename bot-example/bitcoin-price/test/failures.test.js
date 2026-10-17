// Provider failures and the async message flow, through the real chat handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { PriceBot } from '../bot.js';
import { UNAVAILABLE } from '../commands.js';
import { directMessage } from '../direct-messages.js';
import { privateMessage } from '../private-groups.js';
import { acceptRoom, publicMessage } from '../public-groups.js';
import { PriceFeed } from '../price.js';
import { now, rumor, sign, State, unwrap, wrap } from '../runtime.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

function setup(t, fetchText) {
  const dir = mkdtempSync(`${parent}failure-`);
  const store = new State(dir);
  const feed = new PriceFeed({ fetchText, log() {} });
  const sent = [];
  const net = {
    configured: ['wss://relay.example/'],
    routes: (hints = []) => ['wss://relay.example/', ...hints],
    query: async () => [],
    publish: async (event) => sent.push(event),
    close() {},
    watch: () => () => {},
  };
  const bot = new PriceBot({ store, net, feed, cooldown: 0, log() {} });
  t.after(async () => {
    await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bot, store, sent };
}
const readReply = (event, key) => unwrap(event, key).message.content;

test('a failing provider still produces a reply and the message is acknowledged once', async (t) => {
  const { bot, store, sent } = setup(t, async () => {
    throw new Error('offline');
  });
  const user = generateSecretKey();
  const message = rumor(user, [['p', bot.pubkey]], 'price');
  await directMessage(bot, message, { tags: [] });
  assert.equal(store.data.outbox.length, 2);
  assert.ok(store.data.seen[message.id]);
  await bot.flush();
  assert.equal(readReply(sent[0], user), UNAVAILABLE);
  await directMessage(bot, message, { tags: [] });
  assert.equal(store.data.outbox.length, 0, 'a replayed message is not answered twice');
});

test('a malformed provider response gives the unavailable message', async (t) => {
  const { bot, sent } = setup(t, async () => '<html>Bad gateway</html>');
  const user = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price EUR'), { tags: [] });
  await bot.flush();
  assert.equal(readReply(sent[0], user), UNAVAILABLE);
});

test('an unexpected error while building the reply cannot crash the bot', async (t) => {
  const { bot } = setup(t, async () => '{"USD":1}');
  bot.feed = {
    get: async () => {
      throw new Error('bug');
    },
  };
  assert.equal(await bot.reply({ content: 'price' }), UNAVAILABLE);
});

test('a reply is queued only after the provider answers, never before', async (t) => {
  // The handler waits for the provider but the reply is queued only afterwards.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { bot, store } = setup(t, async () => (await gate, '{"USD":67123}'));
  const user = generateSecretKey();
  const pending = directMessage(bot, rumor(user, [['p', bot.pubkey]], 'price'), { tags: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.data.outbox.length, 0, 'nothing is acknowledged before the reply exists');
  release();
  await pending;
  assert.equal(store.data.outbox.length, 2);
});

test('private group replies survive a provider failure', async (t) => {
  const { bot, store } = setup(t, async () => {
    throw new Error('offline');
  });
  const owner = generateSecretKey(),
    user = generateSecretKey(),
    epochKey = generateSecretKey();
  const group = getPublicKey(owner);
  const invitedAt = now();
  const invite = sign(
    owner,
    1014,
    [
      ['p', bot.pubkey],
      ['epoch', '0'],
    ],
    Buffer.from(epochKey).toString('hex'),
    invitedAt,
  );
  const { sig, ...ticket } = invite;
  const opened = unwrap(wrap(ticket, owner, bot.pubkey, [['invitation_proof', sig]]), bot.key);
  await directMessage(bot, opened.message, opened.seal);
  const memberTicket = sign(
    owner,
    1014,
    [
      ['p', getPublicKey(user)],
      ['epoch', '0'],
    ],
    Buffer.from(epochKey).toString('hex'),
    invitedAt,
  );
  const message = rumor(
    user,
    [
      ['p', getPublicKey(epochKey)],
      ['h', group],
      ['epoch', '0'],
      ['invited_at', String(invitedAt)],
      ['invitation_proof', memberTicket.sig],
    ],
    `price nostr:${nip19.npubEncode(bot.pubkey)}`,
  );
  await privateMessage(bot, message, group, getPublicKey(epochKey));
  assert.equal(store.data.outbox.length, 1);
  assert.equal(readReply(store.data.outbox[0].event, epochKey), UNAVAILABLE);
});

test('public group replies survive a provider failure', async (t) => {
  const { bot, store } = setup(t, async () => {
    throw new Error('offline');
  });
  const owner = generateSecretKey(),
    user = generateSecretKey();
  const event = sign(owner, 34550, [
    ['d', 'btc-room'],
    ['name', 'BTC room'],
    ['anagram-room', '1'],
    ['relay', 'wss://relay.example/'],
    ['trusted', bot.pubkey],
  ]);
  acceptRoom(bot, event);
  const address = `34550:${event.pubkey}:btc-room`;
  const mention = `nostr:${nip19.npubEncode(bot.pubkey)}`;
  await publicMessage(bot, sign(user, 9, [['a', address]], `price ${mention}`), address);
  assert.equal(store.data.outbox.length, 1);
  assert.equal(store.data.outbox[0].event.content, UNAVAILABLE);
  // Preserved mention rule: unrelated group traffic gets no answer.
  await publicMessage(bot, sign(user, 9, [['a', address]], 'price'), address);
  await publicMessage(bot, sign(user, 9, [['a', address]], 'good morning everyone'), address);
  assert.equal(store.data.outbox.length, 1);
});

test('help is not sent to replies, so two always-answering bots cannot loop', async (t) => {
  const first = setup(t, async () => '{"USD":67123}');
  const second = setup(t, async () => '{"USD":67123}');
  // The first bot is DMed by the second bot's key and answers with help.
  const opener = rumor(second.bot.key, [['p', first.bot.pubkey]], 'hello');
  await directMessage(first.bot, opener, { tags: [] });
  assert.equal(first.store.data.outbox.length, 2);
  // Deliver that help reply to the second bot: it must stay silent.
  const help = unwrap(first.store.data.outbox[0].event, second.bot.key).message;
  await directMessage(second.bot, help, { tags: [] });
  assert.equal(second.store.data.outbox.length, 0);
  assert.ok(second.store.data.seen[help.id], 'silent messages are remembered for replays');
});

test('a reply that is a real command is still answered', async (t) => {
  const { bot, store } = setup(t, async () => '{"USD":67123}');
  const user = generateSecretKey();
  const replyTag = ['e', 'a'.repeat(64), '', 'reply'];
  await directMessage(bot, rumor(user, [['p', bot.pubkey], replyTag], 'thanks!'), { tags: [] });
  assert.equal(store.data.outbox.length, 0);
  await directMessage(bot, rumor(user, [['p', bot.pubkey], replyTag], 'price'), { tags: [] });
  assert.equal(store.data.outbox.length, 2);
  assert.equal(unwrap(store.data.outbox[0].event, user).message.content, 'BTC: $67,123 USD');
});

test('public quote-replies that are not commands get no help reply', async (t) => {
  const { bot, store } = setup(t, async () => '{"USD":67123}');
  const owner = generateSecretKey(),
    user = generateSecretKey();
  const event = sign(owner, 34550, [
    ['d', 'btc-room'],
    ['name', 'BTC room'],
    ['anagram-room', '1'],
    ['relay', 'wss://relay.example/'],
    ['trusted', bot.pubkey],
  ]);
  acceptRoom(bot, event);
  const address = `34550:${event.pubkey}:btc-room`;
  const mention = `nostr:${nip19.npubEncode(bot.pubkey)}`;
  const quote = ['q', 'b'.repeat(64), '', getPublicKey(user)];
  await publicMessage(bot, sign(user, 9, [['a', address], quote], `nice ${mention}`), address);
  assert.equal(store.data.outbox.length, 0);
  await publicMessage(bot, sign(user, 9, [['a', address]], `hi ${mention}`), address);
  assert.equal(store.data.outbox.length, 1, 'a fresh mention still gets help');
});
