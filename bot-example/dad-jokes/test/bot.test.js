import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPublicKey, generateSecretKey, nip19, verifyEvent } from 'nostr-tools';
import { createRumor, wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import { DadBot, DEFAULT_PICTURE_URL, publishProfile } from '../bot.js';
import { directMessage } from '../direct-messages.js';
import { acceptTicket, authorized, privateMessage } from '../private-groups.js';
import { acceptRoom, joinPublic, publicMessage, roomLink } from '../public-groups.js';
import {
  mentions,
  now,
  publicIP,
  relayURLs,
  rumor,
  sign,
  State,
  unwrap,
  wrap,
} from '../runtime.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });
function setup(t) {
  const dir = mkdtempSync(`${parent}test-`);
  const store = new State(dir);
  const sent = [];
  const net = {
    configured: ['wss://relay.example/'],
    routes(hints = []) {
      return [...this.configured, ...hints];
    },
    query: async () => [],
    publish: async (event) => {
      sent.push(event);
    },
    close() {},
    watch() {
      return () => {};
    },
  };
  const bot = new DadBot({
    store,
    net,
    jokes: [{ joke: 'A test dad joke.' }],
    cooldown: 0,
    log() {},
  });
  t.after(async () => {
    await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bot, store, net, sent, dir };
}
function ticket(group, member, epochKey, epoch = 0, time = now()) {
  const signed = sign(
    group,
    1014,
    [
      ['p', member],
      ['epoch', String(epoch)],
    ],
    Buffer.from(epochKey).toString('hex'),
    time,
  );
  const { sig, ...message } = signed;
  return { message, seal: { tags: [['invitation_proof', sig]] }, signed };
}
function room(owner, bot, extra = [], time = now()) {
  return sign(
    owner,
    34550,
    [
      ['d', 'dad-room'],
      ['name', 'Dad room'],
      ['anagram-room', '1'],
      ['relay', 'wss://relay.example/'],
      ['trusted', bot.pubkey],
      ...extra,
    ],
    '',
    time,
  );
}
function privateInput(sender, group, epochKey, epoch, bot, overrides = {}) {
  const senderTicket = ticket(group, getPublicKey(sender), epochKey, epoch);
  return {
    ...rumor(
      sender,
      [
        ['p', getPublicKey(epochKey)],
        ['h', getPublicKey(group)],
        ['epoch', String(epoch)],
        ['invited_at', String(senderTicket.message.created_at)],
        ['invitation_proof', senderTicket.signed.sig],
      ],
      `Hello nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey })}`,
    ),
    ...overrides,
  };
}

test('identity survives restarts, secret permissions, exclusive lock and invalid state fails closed', async (t) => {
  const { store, dir } = setup(t);
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.throws(() => new State(dir), /Another bot/);
  const nsec = store.data.nsec;
  store.close();
  const restored = new State(dir);
  assert.equal(restored.data.nsec, nsec);
  restored.close();
  writeFileSync(store.file, '{broken');
  assert.throws(() => new State(dir));
  assert.equal(readFileSync(store.file, 'utf8'), '{broken');
});

test('configured identity is validated, persisted and never mixed with another account', (t) => {
  const dir = mkdtempSync(`${parent}configured-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = generateSecretKey();
  const nsec = nip19.nsecEncode(key);
  for (const invalid of [
    'nsec1invalid',
    nip19.npubEncode(getPublicKey(key)),
    nip19.nsecEncode(new Uint8Array(32)),
  ])
    assert.throws(() => new State(dir, { nsec: invalid }), /NSEC must be a valid nsec/);
  const store = new State(dir, { nsec: ` ${nsec} ` });
  assert.equal(getPublicKey(store.key), getPublicKey(key));
  store.data.seen.example = now();
  store.save();
  store.close();
  const original = readFileSync(store.file, 'utf8');
  assert.throws(
    () => new State(dir, { nsec: nip19.nsecEncode(generateSecretKey()) }),
    /NSEC differs from the saved identity/,
  );
  assert.equal(readFileSync(store.file, 'utf8'), original);
  for (const configured of [nsec, '', '  ']) {
    const restored = new State(dir, { nsec: configured });
    assert.equal(getPublicKey(restored.key), getPublicKey(key));
    assert.ok(restored.data.seen.example);
    restored.close();
  }
});

test('NIP-59 interoperates with nostr-tools and rejects forged sender bindings and bad signatures', (t) => {
  const { bot } = setup(t);
  const user = generateSecretKey();
  const source = createRumor(
    { kind: 14, content: 'Hi', tags: [['p', bot.pubkey]], created_at: now() },
    user,
  );
  const incoming = wrapEvent(source, user, bot.pubkey);
  assert.equal(unwrap(incoming, bot.key).message.id, source.id);
  const outgoing = wrap(source, user, bot.pubkey);
  assert.equal(unwrapEvent(outgoing, bot.key).content, 'Hi');
  assert.equal(unwrap({ ...incoming, sig: '0'.repeat(128) }, bot.key), null);
  const other = generateSecretKey();
  assert.equal(unwrap(wrap(source, other, bot.pubkey), bot.key), null);
  const forged = { ...source, id: '0'.repeat(64) };
  assert.equal(unwrap(wrap(forged, user, bot.pubkey), bot.key), null);
  assert.equal(unwrap(wrap({ ...source, sig: '0'.repeat(128) }, user, bot.pubkey), bot.key), null);
});

test('DM receives one joke, proper reply tags, sender history copy, and no replay after restart', async (t) => {
  const { bot, store, net, dir, sent } = setup(t);
  const user = generateSecretKey();
  const message = rumor(user, [['p', bot.pubkey]], 'Anything');
  await directMessage(bot, message, { tags: [] });
  await directMessage(bot, message, { tags: [] });
  assert.equal(store.data.outbox.length, 2);
  await bot.flush();
  const reply = unwrapEvent(sent[0], user);
  assert.equal(reply.content, 'A test dad joke.');
  assert.equal(reply.pubkey, bot.pubkey);
  assert.deepEqual(reply.tags, [
    ['p', getPublicKey(user)],
    ['e', message.id, '', 'reply'],
  ]);
  assert.equal(unwrapEvent(sent[1], bot.key).id, reply.id);
  store.close();
  const restored = new State(dir);
  const restarted = new DadBot({
    store: restored,
    net,
    jokes: [{ joke: 'Another joke' }],
    log() {},
  });
  assert.equal(restarted.shouldReply(message), false);
  await restarted.close();
});

test('outbox survives no ACK and restart, retries identical signed events', async (t) => {
  const { bot, net, store, dir } = setup(t);
  const user = generateSecretKey();
  const message = rumor(user, [['p', bot.pubkey]], 'Hello');
  await directMessage(bot, message, { tags: [] });
  const ids = store.data.outbox.map((item) => item.event.id);
  net.publish = async () => {
    throw new Error('offline');
  };
  await bot.flush();
  assert.deepEqual(
    store.data.outbox.map((item) => item.event.id),
    ids,
  );
  store.close();
  const restored = new State(dir);
  const sent = [];
  net.publish = async (event) => {
    sent.push(event.id);
  };
  const restarted = new DadBot({ store: restored, net, jokes: [], log() {} });
  for (const item of restored.data.outbox) item.retryAt = 0;
  await restarted.flush();
  assert.deepEqual(sent, ids);
  assert.equal(restored.data.outbox.length, 0);
  await restarted.close();
});

test('private invitation proof and reply are valid; rotation, stale tickets and conflicts are enforced', async (t) => {
  const { bot, store } = setup(t);
  const owner = generateSecretKey(),
    user = generateSecretKey(),
    epochKey = generateSecretKey();
  const group = getPublicKey(owner);
  const invite = ticket(owner, bot.pubkey, epochKey);
  // Exact Anagram wire format: unsigned rumor, ticket signature in the seal.
  const opened = unwrap(wrap(invite.message, owner, bot.pubkey, invite.seal.tags), bot.key);
  await directMessage(bot, opened.message, opened.seal);
  assert.equal(store.data.groups[group].pubkey, getPublicKey(epochKey));
  const incoming = privateInput(user, owner, epochKey, 0, bot);
  await privateMessage(bot, incoming, group, getPublicKey(epochKey));
  const reply = unwrapEvent(store.data.outbox[0].event, epochKey);
  assert.equal(reply.pubkey, bot.pubkey);
  assert.equal(authorized(reply, group, store.data.groups[group]), true);
  assert.equal(reply.tags.find((tag) => tag[0] === 'e')[1], incoming.id);
  const nextKey = generateSecretKey();
  const next = ticket(owner, bot.pubkey, nextKey, 1);
  acceptTicket(bot, next.message, next.seal);
  acceptTicket(bot, invite.message, invite.seal);
  assert.equal(store.data.groups[group].epoch, 1);
  await bot.flush();
  assert.equal(store.data.outbox.length, 0, 'old-epoch queued reply is discarded');
  const conflict = ticket(owner, bot.pubkey, generateSecretKey(), 1);
  acceptTicket(bot, conflict.message, conflict.seal);
  assert.equal(store.data.groups[group].conflict, true);
  acceptTicket(bot, next.message, next.seal);
  assert.equal(store.data.groups[group].conflict, true);
  const resolved = ticket(owner, bot.pubkey, generateSecretKey(), 2);
  acceptTicket(bot, resolved.message, resolved.seal);
  assert.equal(store.data.groups[group].conflict, false);
});

test('private groups reject leaked-key outsiders, wrong room/epoch, duplicated proof tags and invalid tickets', async (t) => {
  const { bot } = setup(t);
  const owner = generateSecretKey(),
    user = generateSecretKey(),
    epochKey = generateSecretKey();
  const group = getPublicKey(owner);
  const invite = ticket(owner, bot.pubkey, epochKey);
  acceptTicket(bot, invite.message, { tags: [['invitation_proof', '0'.repeat(128)]] });
  assert.equal(bot.state.groups[group], undefined);
  acceptTicket(bot, invite.message, invite.seal);
  const good = privateInput(user, owner, epochKey, 0, bot);
  for (const bad of [
    { ...good, tags: good.tags.filter((tag) => tag[0] !== 'invitation_proof') },
    { ...good, tags: [...good.tags, ['epoch', '0']] },
    { ...good, pubkey: getPublicKey(generateSecretKey()) },
    { ...good, pubkey: getPublicKey(epochKey) },
    { ...good, tags: good.tags.map((tag) => (tag[0] === 'h' ? ['h', 'a'.repeat(64)] : tag)) },
  ])
    await privateMessage(bot, bad, group, getPublicKey(epochKey));
  assert.equal(bot.state.outbox.length, 0);
});

test('public trusted-user discovery, mentions, replies, block/untrust updates and explicit joining', async (t) => {
  const { bot, net } = setup(t);
  const owner = generateSecretKey(),
    user = generateSecretKey();
  const event = room(owner, bot);
  const address = `34550:${event.pubkey}:dad-room`;
  acceptRoom(bot, event);
  assert.ok(bot.state.rooms[address]);
  const message = sign(user, 9, [['a', address]], `Hi nostr:${nip19.npubEncode(bot.pubkey)}`);
  publicMessage(bot, message, address);
  assert.equal(bot.state.outbox.length, 1);
  const reply = bot.state.outbox[0].event;
  assert.ok(verifyEvent(reply));
  assert.deepEqual(reply.tags, [
    ['a', address],
    ['q', message.id, '', message.pubkey],
  ]);
  const blocked = room(owner, bot, [['blocked', bot.pubkey]], now() + 1);
  acceptRoom(bot, blocked);
  await bot.flush();
  assert.equal(bot.state.outbox.length, 0, 'queued response respects a block');
  const untrusted = sign(
    owner,
    34550,
    event.tags.filter((tag) => tag[0] !== 'trusted'),
    '',
    now() + 2,
  );
  acceptRoom(bot, untrusted);
  publicMessage(
    bot,
    sign(user, 9, [['a', address]], `Again nostr:${nip19.npubEncode(bot.pubkey)}`),
    address,
  );
  assert.equal(bot.state.outbox.length, 0);
  net.query = async () => [untrusted];
  const link = nip19.naddrEncode({
    kind: 34550,
    pubkey: event.pubkey,
    identifier: 'dad-room',
    relays: [],
  });
  assert.equal(await joinPublic(bot, `https://anagram.chat/join/chat.html#/public/${link}`), true);
  assert.equal(bot.state.rooms[address].explicit, true);
  assert.equal(roomLink(link).slug, 'dad-room');
  publicMessage(
    bot,
    sign(user, 9, [['a', address]], `Now nostr:${nip19.npubEncode(bot.pubkey)}`),
    address,
  );
  assert.equal(bot.state.outbox.length, 1);
});

test('old history, edits, own messages, controls and non-mentions never trigger replies', async (t) => {
  const { bot } = setup(t);
  const user = generateSecretKey();
  const source = rumor(user, [['p', bot.pubkey]], 'hello');
  assert.equal(bot.shouldReply({ ...source, created_at: now() - 86401 }), false);
  assert.equal(bot.shouldReply({ ...source, created_at: now() + 61 }), false);
  assert.equal(bot.shouldReply({ ...source, pubkey: bot.pubkey }), false);
  assert.equal(bot.shouldReply({ ...source, kind: 7 }), false);
  assert.equal(
    bot.shouldReply({ ...source, tags: [...source.tags, ['e', 'a'.repeat(64), '', 'edit']] }),
    false,
  );
  assert.equal(mentions('@Dad Jokes', bot.pubkey), false);
  assert.equal(mentions(nip19.npubEncode(bot.pubkey), bot.pubkey), true);
  assert.equal(mentions(nip19.nprofileEncode({ pubkey: bot.pubkey }), bot.pubkey), true);
  assert.equal(mentions(`https://example.org/${nip19.npubEncode(bot.pubkey)}`, bot.pubkey), false);
  assert.equal(mentions(`nostr:${nip19.npubEncode(bot.pubkey)}`, bot.pubkey), true);
  await directMessage(
    bot,
    {
      ...source,
      tags: [
        ['p', bot.pubkey],
        ['p', getPublicKey(user)],
      ],
    },
    { tags: [] },
  );
  assert.equal(bot.state.outbox.length, 0);
});

test('sender cooldown is persisted and suppressed messages do not replay', async (t) => {
  const { bot } = setup(t);
  bot.cooldown = 60;
  const user = generateSecretKey();
  await directMessage(bot, rumor(user, [['p', bot.pubkey]], 'one'), { tags: [] });
  const second = rumor(user, [['p', bot.pubkey]], 'two');
  await directMessage(bot, second, { tags: [] });
  assert.equal(bot.state.outbox.length, 2);
  assert.ok(bot.state.seen[second.id]);
});

test('profile publishes the hosted default picture and accepts an explicit override', async (t) => {
  const { bot, sent } = setup(t);
  bot.state.picture = 'https://example.org/old-avatar.png';
  await publishProfile(bot);
  assert.equal(sent[0].kind, 10050);
  assert.equal(JSON.parse(sent[1].content).name, 'Dad Jokes (Example Anagram Bot)');
  assert.equal(JSON.parse(sent[1].content).bot, true);
  assert.equal(JSON.parse(sent[1].content).picture, DEFAULT_PICTURE_URL);
  assert.equal(JSON.parse(sent[1].content).nip05, undefined);
  await publishProfile(bot, {
    pictureURL: 'https://example.org/custom.png',
    nip05: ' dad@example.org ',
  });
  assert.equal(JSON.parse(sent[3].content).picture, 'https://example.org/custom.png');
  assert.equal(JSON.parse(sent[3].content).nip05, 'dad@example.org');
});

test('untrusted relay hints cannot select private server addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2002:7f00:1::',
  ])
    assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP('1.1.1.1'), true);
  assert.equal(publicIP('2606:4700:4700::1111'), true);
  assert.deepEqual(
    relayURLs([
      'ws://127.0.0.1:9000',
      'wss://127.0.0.1',
      'wss://user:password@example.org',
      'file:///etc/passwd',
      'wss://relay.example',
    ]),
    ['wss://relay.example/'],
  );
  assert.deepEqual(relayURLs(['ws://127.0.0.1:9000'], ['ws://127.0.0.1:9000']), [
    'ws://127.0.0.1:9000/',
  ]);
});
