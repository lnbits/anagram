// Message handling: who is answered, what is recorded, and what is never sent or stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { wrapEvent } from 'nostr-tools/nip59';
import { now, unwrap } from '../vendor/runtime.js';
import {
  ALICE_KEY,
  BOB_KEY,
  alice,
  bob,
  dm,
  last,
  mallory,
  repliesFor,
  replyTag,
  sendDM,
  settle,
  setup,
  ticket,
} from './helpers.js';

test('/help answers a linked person by encrypted DM, with their own wallet label', async (t) => {
  const { bot } = setup(t);
  const message = await sendDM(bot, alice, '/help');
  const reply = last(bot, alice);
  assert.match(reply.content, /Linked wallet: Alice test wallet\./);
  assert.match(reply.content, /cannot send payments/);
  assert.deepEqual(
    reply.tags.find((tag) => tag[0] === 'e'),
    ['e', message.id, '', 'reply'],
  );
  // Wrapped for Alice only: a later leak of the bot's key must not show this.
  assert.equal(bot.state.outbox.length, 1);
  assert.equal(repliesFor(bot, bob).length, 0);
  await sendDM(bot, bob, 'help');
  assert.match(last(bot, bob).content, /Linked wallet: Bob test wallet\./);
});

test('a stranger gets no answer, causes no disk write and is logged by npub only', async (t) => {
  const { bot, dir, logs } = setup(t);
  const before = readFileSync(`${dir}/state.json`, 'utf8');
  await sendDM(bot, mallory, '/help my secret question');
  await sendDM(bot, mallory, '/balance');
  assert.equal(bot.state.outbox.length, 0);
  assert.equal(readFileSync(`${dir}/state.json`, 'utf8'), before);
  assert.equal(logs.length, 1, 'one log line per stranger per hour');
  assert.match(logs[0], /^Ignored a message from npub1[a-z0-9]+: no linked wallet\.$/);
  assert.ok(!logs[0].includes('secret question'));
});

test('a message delivered twice, directly or as the same gift wrap, is answered once', async (t) => {
  const { bot } = setup(t);
  const message = dm(alice, '/help', bot);
  await bot.directMessage(message, { tags: [] });
  await bot.directMessage(message, { tags: [] });
  await settle(bot);
  assert.equal(repliesFor(bot, alice).length, 1);

  const wrapped = wrapEvent(
    { kind: 14, tags: [['p', bot.pubkey]], content: 'help', created_at: now() },
    alice,
    bot.pubkey,
  );
  bot.receive(wrapped, bot.key);
  bot.receive(wrapped, bot.key);
  await settle(bot);
  bot.receive(wrapped, bot.key);
  await settle(bot);
  assert.equal(repliesFor(bot, alice).length, 2);
});

test('messages written before linking, too old or from the future are ignored', async (t) => {
  const { bot } = setup(t);
  bot.state.authorized.users[getPublicKey(alice)] = now() - 60;
  await sendDM(bot, alice, '/help', [], now() - 120);
  await sendDM(bot, bob, '/help', [], now() - 2 * 86400);
  await sendDM(bot, bob, '/help', [], now() + 3600);
  assert.equal(bot.state.outbox.length, 0);
  await sendDM(bot, alice, '/help', [], now());
  assert.equal(repliesFor(bot, alice).length, 1);
});

test('a forged seal, a wrong recipient and group-tagged DMs are not answered', async (t) => {
  const { bot } = setup(t);
  // Wrapped for someone else: the bot cannot open it.
  bot.receive(
    wrapEvent(
      { kind: 14, tags: [['p', bot.pubkey]], content: 'help', created_at: now() },
      alice,
      getPublicKey(bob),
    ),
    bot.key,
  );
  // A rumor claiming to be from Bob inside a seal signed by Mallory (built by hand:
  // nostr-tools' wrapEvent would rewrite the rumor's pubkey).
  const encrypt = (value, secret, pubkey) =>
    nip44.v2.encrypt(JSON.stringify(value), nip44.v2.utils.getConversationKey(secret, pubkey));
  const forged = dm(bob, '/help', bot);
  const seal = finalizeEvent(
    { kind: 13, tags: [], created_at: now(), content: encrypt(forged, mallory, bot.pubkey) },
    mallory,
  );
  const ephemeral = generateSecretKey();
  const wrapped = finalizeEvent(
    {
      kind: 1059,
      tags: [['p', bot.pubkey]],
      created_at: now(),
      content: encrypt(seal, ephemeral, bot.pubkey),
    },
    ephemeral,
  );
  assert.equal(unwrap(wrapped, bot.key), null, 'rumor author must equal seal signer');
  bot.receive(wrapped, bot.key);
  await settle(bot);
  assert.equal(repliesFor(bot, bob).length, 0);
  // Addressed elsewhere, or carrying private-group routing tags.
  await sendDM(bot, alice, '/help', [['p', getPublicKey(bob)]]);
  await bot.directMessage(dm(alice, '/help', bot, [['h', getPublicKey(bob)]]), { tags: [] });
  await settle(bot);
  assert.equal(repliesFor(bot, alice).length, 0);
});

test('keys pasted into chat are refused, never stored, logged or repeated', async (t) => {
  const { bot, dir, logs } = setup(t);
  const pasted = [
    `here is my invoice key ${BOB_KEY}`,
    'usr=c5d49fbe-0000-4000-8000-000000000000',
    'nostr+walletconnect://abc?relay=wss://r&secret=def',
    'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  ];
  for (const text of pasted) await sendDM(bot, alice, text);
  const replies = repliesFor(bot, alice);
  assert.equal(replies.length, pasted.length);
  for (const reply of replies) assert.match(reply.content, /never accept keys in chat/);
  const state = readFileSync(`${dir}/state.json`, 'utf8');
  for (const secret of [BOB_KEY, ALICE_KEY, 'c5d49fbe', 'secret=def', 'nsec1qqqq']) {
    assert.ok(!state.includes(secret), 'not in state.json');
    assert.ok(!logs.join('\n').includes(secret), 'not in logs');
    assert.ok(!replies.some((r) => r.content.includes(secret)), 'not in replies');
  }
  // A payment hash is 64 hex characters and is not mistaken for a key.
  await sendDM(bot, alice, `what is ${'ab'.repeat(32)}?`);
  assert.doesNotMatch(last(bot, alice).content, /never accept keys/);
});

test('group invitations are ignored: no group is joined or stored', async (t) => {
  const { bot, logs } = setup(t);
  const group = generateSecretKey(),
    epoch = generateSecretKey();
  const invite = ticket(group, bot.pubkey, epoch);
  await bot.directMessage(invite.message, invite.seal);
  assert.deepEqual(bot.state.groups, {});
  assert.match(logs.at(-1), /Ignored a private group invitation/);
  assert.equal(bot.state.outbox.length, 0);
});

test('plain text gets help, but replies do not, so bots cannot loop', async (t) => {
  const { bot } = setup(t);
  const first = await sendDM(bot, alice, 'hello');
  assert.match(last(bot, alice).content, /Commands:/);
  await sendDM(bot, alice, 'thanks!', [replyTag(first.id)]);
  assert.equal(repliesFor(bot, alice).length, 1);
  await sendDM(bot, alice, '/nope');
  assert.match(last(bot, alice).content, /^Unknown command\./);
});

test('the hourly limit sends one notice, then stays silent', async (t) => {
  const { bot } = setup(t, { limits: { requestsPerHour: 2 } });
  for (let i = 0; i < 5; i++) await sendDM(bot, alice, '/help');
  const replies = repliesFor(bot, alice);
  assert.equal(replies.length, 3);
  assert.match(replies[2].content, /hourly limit/);
  // Other people keep their own allowance.
  await sendDM(bot, bob, '/help');
  assert.equal(repliesFor(bot, bob).length, 1);
});
