import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { DadBot, publishProfile } from '../bot.js';
import { Network, now, sign, State, wrap } from '../runtime.js';
import { relay, until } from './relay.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

test(
  'over real relay sockets: profile, DM, automatic private/public joins, mentions, rotation and restart',
  { timeout: 60000 },
  async (t) => {
    const local = await relay();
    const dir = mkdtempSync(`${parent}relay-test-`);
    let bot, store;
    const start = async () => {
      store = new State(dir);
      bot = new DadBot({
        store,
        net: new Network([local.url]),
        jokes: [{ joke: 'Hello from Dad Jokes!' }],
        cooldown: 0,
        log() {},
        onFatal: (error) => {
          throw error;
        },
      });
      await bot.start();
    };
    t.after(async () => {
      await bot?.close();
      await local.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await start();
    await publishProfile(bot, { pictureURL: 'https://example.org/dad.png' });
    assert.ok([...local.events.values()].some((e) => e.kind === 10050 && e.pubkey === bot.pubkey));
    assert.ok([...local.events.values()].some((e) => e.kind === 0 && JSON.parse(e.content).bot));
    const user = generateSecretKey(),
      owner = generateSecretKey();
    const userPubkey = getPublicKey(user),
      group = getPublicKey(owner);
    const replies = (key) =>
      [...local.events.values()]
        .filter((e) => e.kind === 1059)
        .flatMap((event) => {
          try {
            const message = unwrapEvent(event, key);
            return message.pubkey === bot.pubkey ? [message] : [];
          } catch {
            return [];
          }
        });
    const dm = wrapEvent(
      { kind: 14, tags: [['p', bot.pubkey]], content: 'Tell me a joke', created_at: now() },
      user,
      bot.pubkey,
    );
    local.emit(dm);
    await until(() => replies(user).length === 1, 'DM joke');
    assert.equal(replies(user)[0].content, 'Hello from Dad Jokes!');

    let epochKey = generateSecretKey();
    const invite = (epoch) => {
      const ticket = sign(
        owner,
        1014,
        [
          ['p', bot.pubkey],
          ['epoch', String(epoch)],
        ],
        Buffer.from(epochKey).toString('hex'),
      );
      const { sig, ...unsigned } = ticket;
      local.emit(wrap(unsigned, owner, bot.pubkey, [['invitation_proof', sig]]));
    };
    const mention = (epoch) => {
      const proof = sign(
        owner,
        1014,
        [
          ['p', userPubkey],
          ['epoch', String(epoch)],
        ],
        Buffer.from(epochKey).toString('hex'),
      );
      local.emit(
        wrapEvent(
          {
            kind: 14,
            created_at: now(),
            content: `Hi nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey })}`,
            tags: [
              ['p', getPublicKey(epochKey)],
              ['h', group],
              ['epoch', String(epoch)],
              ['invited_at', String(proof.created_at)],
              ['invitation_proof', proof.sig],
            ],
          },
          user,
          getPublicKey(epochKey),
        ),
      );
    };
    invite(0);
    await until(() => store.data.groups[group]?.epoch === 0, 'private invitation');
    mention(0);
    await until(() => replies(epochKey).length === 1, 'private joke');
    const old = epochKey;
    epochKey = generateSecretKey();
    invite(1);
    await until(() => store.data.groups[group]?.epoch === 1, 'epoch rotation');
    mention(1);
    await until(() => replies(epochKey).length === 1, 'new-epoch joke');
    assert.equal(replies(old).length, 1);

    const room = sign(owner, 34550, [
      ['d', 'public-room'],
      ['name', 'Public room'],
      ['anagram-room', '1'],
      ['relay', local.url],
      ['trusted', bot.pubkey],
    ]);
    const address = `34550:${group}:public-room`;
    local.emit(room);
    await until(() => store.data.rooms[address], 'automatic public join via trusted tag');
    const publicMessage = sign(user, 9, [['a', address]], `Hello ${nip19.npubEncode(bot.pubkey)}`);
    local.emit(publicMessage);
    const publicReplies = () =>
      [...local.events.values()].filter((e) => e.kind === 9 && e.pubkey === bot.pubkey);
    await until(() => publicReplies().length === 1, 'public joke');
    assert.equal(publicReplies()[0].tags.find((t) => t[0] === 'q')[1], publicMessage.id);
    const npub = bot.pubkey;
    await bot.close();
    await start();
    assert.equal(bot.pubkey, npub);
    assert.equal(store.data.groups[group].epoch, 1);
    // Replayed events from all three histories must not create any new replies.
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(publicReplies().length, 1);
    assert.equal(replies(user).length, 1);
    assert.equal(replies(epochKey).length, 1);
    local.emit(
      sign(user, 9, [['a', address]], `After restart nostr:${nip19.npubEncode(bot.pubkey)}`),
    );
    await until(() => publicReplies().length === 2, 'post-restart public joke');
  },
);

test(
  'one relay ACK is sufficient and reconnect recovers randomized gift-wrap timestamps',
  { timeout: 30000 },
  async (t) => {
    const good = await relay(),
      bad = await relay();
    bad.reject = true;
    const network = new Network([bad.url, good.url]);
    t.after(async () => {
      network.close();
      await good.close();
      await bad.close();
    });
    const sender = generateSecretKey(),
      recipient = generateSecretKey(),
      pubkey = getPublicKey(recipient);
    const received = new Set();
    network.watch(
      [good.url],
      () => ({ kinds: [1059], '#p': [pubkey], since: now() - 3 * 86400 }),
      (e) => received.add(e.id),
      recipient,
    );
    const first = wrapEvent(
      { kind: 14, content: 'one', tags: [['p', pubkey]], created_at: now() },
      sender,
      pubkey,
    );
    await network.publish(first, [bad.url, good.url], sender);
    await until(() => received.has(first.id), 'first wrap');
    good.disconnect();
    const second = wrapEvent(
      { kind: 14, content: 'two', tags: [['p', pubkey]], created_at: now() },
      sender,
      pubkey,
    );
    // A newer inner message may have an older outer timestamp; force that situation.
    const olderOuter = sign(
      generateSecretKey(),
      1059,
      second.tags,
      second.content,
      first.created_at - 60,
    );
    // This tests transport replay only; keep a valid signed outer event with a lower timestamp.
    good.emit(olderOuter);
    await until(() => received.has(olderOuter.id), 'reconnected randomized-timestamp replay');
  },
);

test(
  'NIP-42 personal and epoch inboxes authenticate on separate connections',
  { timeout: 20000 },
  async (t) => {
    const local = await relay();
    local.requireAuth = true;
    const network = new Network([local.url]);
    t.after(async () => {
      network.close();
      await local.close();
    });
    const account = generateSecretKey(),
      epoch = generateSecretKey(),
      sender = generateSecretKey();
    const seen = new Set();
    for (const key of [account, epoch]) {
      const pubkey = getPublicKey(key);
      network.watch(
        [],
        () => ({ kinds: [1059], '#p': [pubkey] }),
        (e) => seen.add(e.id),
        key,
      );
      local.emit(
        wrapEvent(
          { kind: 14, tags: [['p', pubkey]], content: 'auth test', created_at: now() },
          sender,
          pubkey,
        ),
      );
    }
    await until(() => seen.size === 2, 'authenticated personal and epoch delivery');
    for (let i = 0; i < 2; i++) {
      local.disconnect();
      seen.clear();
      await until(() => seen.size === 2, 'both inboxes reauthenticate after disconnect');
    }
  },
);

test(
  'a timed-out relay handshake cannot crash healthy relay delivery or retries',
  { timeout: 20000 },
  async (t) => {
    const { createServer } = await import('node:net');
    const sockets = new Set();
    let attempts = 0,
      closed = 0;
    // Accept TCP and the upgrade request, but never complete the WebSocket handshake.
    const stalled = createServer((socket) => {
      attempts++;
      sockets.add(socket);
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        closed++;
      });
    });
    await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const good = await relay();
    const stalledURL = `ws://127.0.0.1:${stalled.address().port}/`;
    const network = new Network([stalledURL, good.url]);
    t.after(async () => {
      network.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([good.close(), new Promise((resolve) => stalled.close(resolve))]);
    });
    const key = generateSecretKey();
    const received = new Set();
    network.watch(
      [],
      () => ({ kinds: [1] }),
      (event) => received.add(event.id),
      key,
    );
    const first = sign(key, 1, [], 'Before handshake timeout');
    await network.publish(first, [], key);
    await until(() => received.has(first.id), 'healthy relay delivery');
    await until(() => closed > 0, 'stalled connection timeout');
    await until(() => attempts > 1, 'failed relay retry');
    const next = sign(key, 1, [], 'After handshake timeout');
    await network.publish(next, [], key);
    await until(() => received.has(next.id), 'continued delivery after timeout');
  },
);

test(
  'repeated failures back off, recover, and stopping an authenticated watch closes it',
  { timeout: 30000 },
  async (t) => {
    const local = await relay();
    local.online = false;
    local.requireAuth = true;
    const network = new Network([local.url]);
    t.after(async () => {
      network.close();
      await local.close();
    });
    const key = generateSecretKey(),
      pubkey = getPublicKey(key);
    const seen = new Set();
    const stop = network.watch(
      [],
      () => ({ kinds: [1059], '#p': [pubkey] }),
      (event) => seen.add(event.id),
      key,
    );
    await until(() => local.connections.length >= 4, 'four failed connections', 15000);
    const gaps = local.connections.slice(1).map((at, i) => at - local.connections[i]);
    assert.ok(
      gaps[0] >= 900 && gaps[1] >= 1900 && gaps[2] >= 3900,
      `retry delay must grow despite synthetic EOSE: ${gaps}`,
    );
    local.online = true;
    const event = wrapEvent(
      { kind: 14, tags: [['p', pubkey]], content: 'Recovered', created_at: now() },
      generateSecretKey(),
      pubkey,
    );
    local.emit(event);
    await until(() => seen.has(event.id), 'authenticated reconnect and replay');
    stop();
    await until(
      () => [...local.subscriptions.values()].every((subs) => subs.size === 0),
      'authenticated replacement subscription removed',
    );
    const attempts = local.connections.length;
    local.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(local.connections.length, attempts, 'stopped watchers must not reconnect');
  },
);

test(
  'heartbeat recovers a silent connection that never answers pings',
  { timeout: 55000 },
  async (t) => {
    const local = await relay({ autoPong: false });
    const network = new Network([local.url]);
    t.after(async () => {
      network.close();
      await local.close();
    });
    const key = generateSecretKey(),
      received = new Set();
    network.watch(
      [],
      () => ({ kinds: [1] }),
      (e) => received.add(e.id),
      key,
    );
    const first = sign(key, 1, [], 'Before silent failure');
    local.emit(first);
    await until(() => received.has(first.id), 'initial subscription');
    await until(() => local.connections.length >= 2, 'heartbeat reconnect', 45000);
    const next = sign(key, 1, [], 'After heartbeat reconnect');
    local.emit(next);
    await until(() => received.has(next.id), 'delivery after heartbeat reconnect');
  },
);

test(
  'connection refusal is recoverable and shutdown prevents further connections',
  { timeout: 15000 },
  async (t) => {
    let local = await relay();
    const url = local.url,
      port = Number(new URL(url).port);
    await local.close();
    const network = new Network([url]);
    t.after(async () => {
      network.close();
      await local.close();
    });
    const key = generateSecretKey(),
      seen = new Set();
    network.watch(
      [],
      () => ({ kinds: [1] }),
      (event) => seen.add(event.id),
      key,
    );
    await assert.rejects(network.publish(sign(key, 1, [], 'Offline'), [], key));
    local = await relay({ port });
    const event = sign(key, 1, [], 'Relay is back');
    local.emit(event);
    await until(() => seen.has(event.id), 'subscription after connection refusal');
    network.close();
    await until(() => local.subscriptions.size === 0, 'all sockets closed');
    const connections = local.connections.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(local.connections.length, connections);
    assert.throws(
      () =>
        network.watch(
          [],
          () => ({ kinds: [1] }),
          () => {},
          key,
        ),
      /closed/,
    );
  },
);
