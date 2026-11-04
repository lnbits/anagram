// Inline buttons: cards, private answers, replays, expiry, access and isolation per chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { OllamaBridge } from '../bot.js';
import { Access } from '../access.js';
import { KEYBOARD } from '../commands.js';
import { directMessage } from '../direct-messages.js';
import { acceptTicket, privateMessage } from '../private-groups.js';
import { acceptRoom, publicMessage } from '../public-groups.js';
import { now, rumor, sign, State, unwrap, wrap } from '../runtime.js';
import {
  BOT_CONTROL_KIND,
  controlTag,
  keyboardFromTags,
  parseControl,
} from '../botKeyboardProtocol.ts';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

const alice = generateSecretKey(),
  bob = generateSecretKey(),
  mallory = generateSecretKey();
const pub = (key) => getPublicKey(key);

function setup(t, { access = {}, limits = {}, dir } = {}) {
  dir ??= mkdtempSync(`${parent}buttons-`);
  const logs = [];
  const net = {
    configured: ['wss://relay.example/'],
    routes: (hints = []) => ['wss://relay.example/', ...hints],
    query: async () => [],
    publish: async () => {},
    close() {},
    watch: () => () => {},
  };
  const ollama = {
    model: 'test-model',
    calls: [],
    async chat(messages) {
      ollama.calls.push(messages);
      return { text: `Answer to: ${messages.at(-1).content}`, truncated: false };
    },
  };
  const make = () =>
    new OllamaBridge({
      store: new State(dir),
      net,
      ollama,
      access: new Access({ senders: [pub(alice), pub(bob)], ...access }),
      limits,
      log: (line) => logs.push(line),
    });
  let bot = make();
  t.after(async () => {
    if (!bot.stopped) await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get bot() {
      return bot;
    },
    ollama,
    logs,
    async restart() {
      await bot.close();
      bot = make();
      return bot;
    },
  };
}
async function settle(bot) {
  for (let i = 0; i < 20; i++) {
    await bot.generating;
    await bot.work;
    if (!bot.generating && !bot.jobs.length) return;
  }
}
async function sendDM(bot, sender, content) {
  const message = rumor(sender, [['p', bot.pubkey]], content);
  await directMessage(bot, message, { tags: [] });
  await settle(bot);
  return message;
}
// What Anagram sends when a button is pressed: a kind 21118 rumor, gift-wrapped to the bot.
function press(user, bot, card, data = 'new', extra = {}) {
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
const lastCard = (bot) => Object.values(bot.state.cards).at(-1);

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
function privateGroup(bot, owner) {
  const epochKey = generateSecretKey();
  const invite = ticket(owner, bot.pubkey, epochKey);
  acceptTicket(bot, invite.message, invite.seal);
  const group = getPublicKey(owner);
  const membership = (sender) => {
    const senderTicket = ticket(owner, pub(sender), epochKey);
    return {
      epoch: 0,
      invited_at: senderTicket.message.created_at,
      invitation_proof: senderTicket.signed.sig,
    };
  };
  const say = async (sender, content) => {
    const m = membership(sender);
    const message = rumor(
      sender,
      [
        ['p', getPublicKey(epochKey)],
        ['h', group],
        ['epoch', '0'],
        ['invited_at', String(m.invited_at)],
        ['invitation_proof', m.invitation_proof],
      ],
      content,
    );
    await privateMessage(bot, message, group, getPublicKey(epochKey));
    await settle(bot);
    return message;
  };
  return { group, epochKey, invite, membership, say };
}
const room = (owner, bot, extra = [], time = now()) =>
  sign(
    owner,
    34550,
    [
      ['d', 'ai-room'],
      ['name', 'AI room'],
      ['anagram-room', '1'],
      ['relay', 'wss://relay.example/'],
      ['trusted', bot.pubkey],
      ...extra,
    ],
    '',
    time,
  );
const at = (bot) => `nostr:${nip19.npubEncode(bot.pubkey)}`;

test('dm: every reply carries the buttons; New chat forgets the conversation privately, Model and Help answer in place', async (t) => {
  const { bot, ollama } = setup(t);
  await sendDM(bot, alice, 'remember the number 42');
  const reply = unwrap(bot.state.outbox[0].event, alice).message;
  assert.equal(reply.content, 'Answer to: remember the number 42');
  assert.deepEqual(keyboardFromTags(reply.tags), KEYBOARD);
  assert.ok(!reply.content.includes('callback_data'), 'other clients see only the text');
  const card = lastCard(bot);
  assert.deepEqual(card, {
    target: { type: 'dm', chat: bot.pubkey, root: reply.id, version: reply.id, bot: bot.pubkey },
    recipient: pub(alice),
    at: card.at,
    views: {},
  });
  assert.equal(bot.conversations.size(`dm:${pub(alice)}`), 2);

  const request = press(alice, bot, card, 'new');
  await deliver(bot, request, alice);
  const [answer] = answers(bot, alice);
  assert.equal(answer.content, 'Done. I have forgotten our conversation.');
  assert.equal(answer.pubkey, bot.pubkey);
  assert.deepEqual(answer.tags[0], ['p', pub(alice)]);
  assert.ok(!answer.tags.some((tag) => tag[0] === 'e'), 'an answer is not a timeline reply');
  const { id, expires } = parseControl(request.tags);
  assert.deepEqual(parseControl(answer.tags), { op: 'answer', id, target: card.target, expires });
  assert.deepEqual(keyboardFromTags(answer.tags), KEYBOARD, 'the next press works from the answer');
  assert.deepEqual(card.views[pub(alice)], [answer.id]);
  assert.equal(bot.conversations.size(`dm:${pub(alice)}`), 0, 'the history is gone');
  assert.equal(bot.state.outbox.length, 3, 'two copies of the reply, one personal answer');

  await sendDM(bot, alice, 'what number?');
  assert.equal(ollama.calls[1].length, 2, 'only the system prompt and the new question');
  // From the personal view: Model and Help. From an unknown view: nothing.
  await deliver(bot, press(alice, bot, card, 'model', { view: answer.id }), alice);
  assert.equal(answers(bot, alice)[1].content, 'Model: test-model');
  await deliver(bot, press(alice, bot, card, 'help', { view: answers(bot, alice)[1].id }), alice);
  assert.match(answers(bot, alice)[2].content, /^I forward your messages to a local AI model/);
  await deliver(bot, press(alice, bot, card, 'help', { view: 'a'.repeat(64) }), alice);
  assert.equal(answers(bot, alice).length, 3);
  assert.equal(ollama.calls.length, 2, 'buttons never reach the model');
});

test('a repeated press gets the stored answer again, also after a restart; a reused id with other data gets nothing', async (t) => {
  const fixture = setup(t);
  let bot = fixture.bot;
  await sendDM(bot, alice, 'hello');
  const card = lastCard(bot);
  const request = press(alice, bot, card, 'model');
  await deliver(bot, request, alice);
  await deliver(bot, request, alice);
  assert.equal(answers(bot, alice).length, 1, 'a duplicate delivery is not answered twice');
  const [stored] = bot.state.outbox.filter(
    (item) => unwrap(item.event, alice)?.message.kind === BOT_CONTROL_KIND,
  );
  await bot.flush();
  assert.equal(bot.state.outbox.length, 0);
  await deliver(bot, request, alice);
  assert.equal(bot.state.outbox.length, 1, 'a retry after delivery resends the same answer');
  assert.equal(bot.state.outbox[0].event.id, stored.event.id);
  await bot.flush();
  const control = parseControl(request.tags);
  const altered = {
    ...rumor(alice, [['p', bot.pubkey], controlTag({ ...control, data: 'new' })], ''),
    kind: BOT_CONTROL_KIND,
  };
  altered.id = getEventHash(altered);
  await deliver(bot, altered, alice);
  assert.equal(bot.state.outbox.length, 0, 'same id, other button: refused');
  assert.equal(bot.conversations.size(`dm:${pub(alice)}`), 2, 'and nothing was reset');

  bot = await fixture.restart();
  assert.ok(bot.state.cards[card.target.root], 'cards survive a restart');
  await deliver(bot, request, alice);
  assert.equal(bot.state.outbox[0].event.id, stored.event.id, 'the stored answer survives too');
  await deliver(bot, press(alice, bot, card, 'help'), alice);
  assert.equal(answers(bot, alice).length, 2, 'new presses still work after a restart');
});

test('presses are refused when expired, from another person, for another version, for a button not on the card, or by strangers', async (t) => {
  const { bot, logs } = setup(t);
  await sendDM(bot, alice, 'hello');
  const card = lastCard(bot);
  const refused = [
    press(alice, bot, card, 'new', { expires: now() - 1 }),
    press(alice, bot, card, 'new', { expires: now() + 301 }),
    press(alice, bot, card, 'reset'),
    press(alice, bot, card, 'vote:0'),
    press(alice, bot, { target: { ...card.target, version: 'b'.repeat(64) } }),
    press(alice, bot, {
      target: { ...card.target, root: 'c'.repeat(64), version: 'c'.repeat(64) },
    }),
    { ...press(alice, bot, card), content: 'not empty' },
    { ...press(alice, bot, card), created_at: now() - 301 },
  ];
  for (const event of refused) {
    event.id = getEventHash(event);
    await deliver(bot, event, alice);
  }
  await deliver(bot, press(bob, bot, card), bob);
  await deliver(bot, press(mallory, bot, card), mallory);
  assert.equal(bot.state.outbox.length, 2, 'only the two copies of the reply were queued');
  assert.deepEqual(Object.keys(bot.state.callbacks), []);
  assert.equal(bot.conversations.size(`dm:${pub(alice)}`), 2);
  // A press written before the sender was allowed is ignored, like an old message.
  const early = {
    ...press(alice, bot, card, 'new', { expires: bot.runStartedAt + 200 }),
    created_at: bot.runStartedAt - 100,
  };
  early.id = getEventHash(early);
  await deliver(bot, early, alice);
  assert.equal(bot.state.outbox.length, 2);
  assert.ok(logs.some((line) => line.includes('sent before access was granted')));
  // A control rumor that is not a request is never treated as a message either.
  const stray = { ...rumor(alice, [['p', bot.pubkey]], 'hello'), kind: BOT_CONTROL_KIND };
  stray.id = getEventHash(stray);
  await deliver(bot, stray, alice);
  assert.equal(bot.state.outbox.length, 2);
  assert.equal(bot.state.seen[stray.id], undefined);
});

test('presses count against the hourly limit: one private notice, then silence', async (t) => {
  const { bot } = setup(t, { limits: { requestsPerHour: 2 } });
  await sendDM(bot, alice, 'hello');
  const card = lastCard(bot);
  await deliver(bot, press(alice, bot, card, 'model'), alice);
  assert.equal(answers(bot, alice)[0].content, 'Model: test-model');
  await deliver(bot, press(alice, bot, card, 'model'), alice);
  assert.match(answers(bot, alice)[1].content, /hourly message limit/);
  assert.deepEqual(keyboardFromTags(answers(bot, alice)[1].tags), KEYBOARD);
  await deliver(bot, press(alice, bot, card, 'model'), alice);
  assert.equal(answers(bot, alice).length, 2);
});

test('private group: a press needs the current invitation proof and an allowed group; New chat resets only that group', async (t) => {
  const owner = generateSecretKey(),
    other = generateSecretKey();
  const fixture = setup(t, { access: { privateGroups: [pub(owner), pub(other)] } });
  const bot = fixture.bot;
  const g = privateGroup(bot, owner),
    h = privateGroup(bot, other);
  await g.say(alice, `${at(bot)} group context`);
  await h.say(alice, `${at(bot)} other group`);
  await sendDM(bot, alice, 'dm context');
  const card = Object.values(bot.state.cards)[0];
  assert.deepEqual(card.target, {
    type: 'private',
    chat: g.group,
    root: card.target.root,
    version: card.target.root,
    bot: bot.pubkey,
  });
  assert.equal(card.recipient, undefined, 'a group card belongs to the whole group');
  const membership = g.membership(bob);
  for (const bad of [
    { ...membership, invitation_proof: g.membership(mallory).invitation_proof },
    { ...membership, invitation_proof: 'ab'.repeat(64) },
    { ...membership, epoch: 1 },
    h.membership(bob),
  ])
    await deliver(bot, press(bob, bot, card, 'new', { membership: bad }), bob);
  await deliver(
    bot,
    press(mallory, bot, card, 'new', { membership: g.membership(mallory) }),
    mallory,
  );
  assert.equal(answers(bot, bob).length, 0);
  assert.equal(answers(bot, mallory).length, 0, 'group membership alone grants nothing');
  assert.equal(bot.conversations.size(`private:${g.group}`), 2);

  await deliver(bot, press(bob, bot, card, 'new', { membership }), bob);
  const [answer] = answers(bot, bob);
  assert.equal(answer.content, 'Done. I have forgotten this group’s conversation.');
  assert.deepEqual(parseControl(answer.tags).membership, {
    epoch: 0,
    invited_at: g.invite.message.created_at,
    invitation_proof: g.invite.signed.sig,
  });
  assert.equal(bot.conversations.size(`private:${g.group}`), 0);
  assert.equal(bot.conversations.size(`private:${h.group}`), 2, 'other groups keep theirs');
  assert.equal(bot.conversations.size(`dm:${pub(alice)}`), 2, 'DMs keep theirs');

  // After a key rotation the old proof is worthless; a group taken off the allowlist too.
  const next = ticket(owner, bot.pubkey, generateSecretKey(), 1);
  acceptTicket(bot, next.message, next.seal);
  await deliver(bot, press(bob, bot, card, 'model', { membership }), bob);
  assert.equal(answers(bot, bob).length, 1);
  const hCard = Object.values(bot.state.cards)[1];
  bot.access.privateGroups.delete(h.group);
  await deliver(bot, press(bob, bot, hCard, 'model', { membership: h.membership(bob) }), bob);
  assert.equal(answers(bot, bob).length, 1);
});

test('public group: allowed people may press while the bot is trusted; blocked people, strangers and an untrusted bot get nothing', async (t) => {
  const owner = generateSecretKey();
  const address = `34550:${pub(owner)}:ai-room`;
  const { bot } = setup(t, { access: { publicGroups: [address] } });
  const event = room(owner, bot);
  acceptRoom(bot, event);
  await publicMessage(bot, sign(alice, 9, [['a', address]], `${at(bot)} what is a sat?`), address);
  await settle(bot);
  const reply = bot.state.outbox[0].event;
  assert.deepEqual(keyboardFromTags(reply.tags), KEYBOARD);
  const card = lastCard(bot);
  assert.deepEqual(card.target, {
    type: 'public',
    chat: address,
    root: reply.id,
    version: reply.id,
    bot: bot.pubkey,
  });
  await deliver(bot, press(bob, bot, card, 'model'), bob);
  assert.equal(answers(bot, bob)[0].content, 'Model: test-model');
  assert.equal(answers(bot, alice).length, 0, 'answers are personal');
  await deliver(bot, press(mallory, bot, card, 'model'), mallory);
  assert.equal(answers(bot, mallory).length, 0);
  acceptRoom(bot, room(owner, bot, [['blocked', pub(bob)]], now() + 1));
  await deliver(bot, press(bob, bot, card, 'model'), bob);
  assert.equal(answers(bot, bob).length, 1);
  await deliver(bot, press(alice, bot, card, 'new'), alice);
  assert.equal(answers(bot, alice).length, 1);
  assert.equal(bot.conversations.size(`public:${address}`), 0);
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
  await deliver(bot, press(alice, bot, card, 'model'), alice);
  assert.equal(answers(bot, alice).length, 1, 'an untrusted bot has no interactive cards');
});

test('cards and replay markers are bounded and expire', async (t) => {
  const { bot } = setup(t);
  const old = 'd'.repeat(64);
  bot.state.cards[old] = { target: {}, at: now() - 8 * 86400, views: {} };
  for (let i = 0; i < 1000; i++)
    bot.state.cards[`${i}`.padStart(64, '0')] = { target: {}, at: now() - 1000 + i, views: {} };
  bot.state.callbacks['x:y'] = { expires: now() - 301, fingerprint: 'z', delivery: {} };
  await sendDM(bot, alice, 'hello');
  assert.equal(bot.state.cards[old], undefined, 'week-old cards are dropped');
  assert.equal(Object.keys(bot.state.cards).length, 1000, 'the oldest card makes room');
  assert.equal(bot.state.cards['0'.repeat(64)], undefined);
  const card = Object.values(bot.state.cards).find((c) => c.recipient);
  await deliver(bot, press(alice, bot, card, 'help'), alice);
  assert.equal(bot.state.callbacks['x:y'], undefined, 'expired replay markers are dropped');
  assert.equal(Object.keys(bot.state.callbacks).length, 1);
});
