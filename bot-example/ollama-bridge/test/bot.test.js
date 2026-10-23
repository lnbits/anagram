import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import { OllamaBridge, publishProfile } from '../bot.js';
import { Access } from '../access.js';
import { Conversations } from '../conversations.js';
import { directMessage } from '../direct-messages.js';
import { acceptTicket, authorized, privateMessage } from '../private-groups.js';
import { acceptRoom, publicMessage } from '../public-groups.js';
import { OllamaError } from '../ollama.js';
import { mentions, now, rumor, sign, State, unwrap, wrap } from '../runtime.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

// A stand-in for OllamaClient. answer(messages) decides each reply; calls are recorded.
function fakeOllama(answer = (messages) => `Answer to: ${messages.at(-1).content}`) {
  const ollama = {
    model: 'test-model',
    calls: [],
    answer,
    async chat(messages, { signal } = {}) {
      ollama.calls.push(messages);
      const text = await ollama.answer(messages, signal);
      return { text, truncated: false };
    },
  };
  return ollama;
}
// An answer that waits until the test releases it, to observe in-progress behaviour.
function gate() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

const alice = generateSecretKey(),
  bob = generateSecretKey(),
  mallory = generateSecretKey();

function setup(t, { access = {}, limits = {}, history, dir } = {}) {
  dir ??= mkdtempSync(`${parent}test-`);
  const store = new State(dir);
  const sent = [];
  const logs = [];
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
  const ollama = fakeOllama();
  const bot = new OllamaBridge({
    store,
    net,
    ollama,
    access: new Access({ senders: [getPublicKey(alice), getPublicKey(bob)], ...access }),
    conversations: new Conversations(history),
    limits,
    log: (line) => logs.push(line),
  });
  t.after(async () => {
    if (!bot.stopped) await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bot, store, net, sent, logs, ollama, dir };
}
// Waits until queued questions are answered and their replies are in the outbox.
async function settle(bot) {
  for (let i = 0; i < 20; i++) {
    await bot.generating;
    await bot.work;
    if (!bot.generating && !bot.jobs.length) return;
  }
}
const dm = (sender, content, bot) => rumor(sender, [['p', bot.pubkey]], content);
async function sendDM(bot, sender, content) {
  const message = dm(sender, content, bot);
  await directMessage(bot, message, { tags: [] });
  return message;
}
// Replies the bot queued for a DM recipient, decrypted.
function dmReplies(bot, recipient) {
  return bot.state.outbox.flatMap((item) => {
    try {
      const message = unwrapEvent(item.event, recipient);
      return message.pubkey === bot.pubkey ? [message] : [];
    } catch {
      return [];
    }
  });
}
const lastUser = (call) => call.at(-1).content;

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
function privateInput(sender, owner, epochKey, epoch, bot, content) {
  const senderTicket = ticket(owner, getPublicKey(sender), epochKey, epoch);
  return rumor(
    sender,
    [
      ['p', getPublicKey(epochKey)],
      ['h', getPublicKey(owner)],
      ['epoch', String(epoch)],
      ['invited_at', String(senderTicket.message.created_at)],
      ['invitation_proof', senderTicket.signed.sig],
    ],
    content,
  );
}
function privateGroup(bot, owner = generateSecretKey()) {
  const epochKey = generateSecretKey();
  const invite = ticket(owner, bot.pubkey, epochKey);
  acceptTicket(bot, invite.message, invite.seal);
  const group = getPublicKey(owner);
  const say = async (sender, content) => {
    const message = privateInput(sender, owner, epochKey, 0, bot, content);
    await privateMessage(bot, message, group, getPublicKey(epochKey));
    return message;
  };
  const replies = () =>
    bot.state.outbox.filter((i) => i.group === group).map((i) => unwrapEvent(i.event, epochKey));
  return { owner, group, epochKey, say, replies };
}
function room(owner, bot, slug = 'ai-room', extra = [], time = now()) {
  return sign(
    owner,
    34550,
    [
      ['d', slug],
      ['name', 'AI room'],
      ['anagram-room', '1'],
      ['relay', 'wss://relay.example/'],
      ['trusted', bot.pubkey],
      ...extra,
    ],
    '',
    time,
  );
}
const at = (bot) => `nostr:${nip19.npubEncode(bot.pubkey)}`;

test('an allowed DM is answered by the model with NIP-17 reply tags and a self copy', async (t) => {
  const { bot, ollama, sent } = setup(t);
  const message = await sendDM(bot, alice, 'Explain Bitcoin mining in simple terms.');
  await settle(bot);
  assert.equal(ollama.calls.length, 1);
  assert.equal(ollama.calls[0][0].role, 'system');
  assert.deepEqual(ollama.calls[0].at(-1), {
    role: 'user',
    content: 'Explain Bitcoin mining in simple terms.',
  });
  assert.equal(bot.state.outbox.length, 2);
  await bot.flush();
  const reply = unwrapEvent(sent[0], alice);
  assert.equal(reply.content, 'Answer to: Explain Bitcoin mining in simple terms.');
  assert.equal(reply.pubkey, bot.pubkey);
  assert.deepEqual(reply.tags, [
    ['p', getPublicKey(alice)],
    ['e', message.id, '', 'reply'],
  ]);
  assert.equal(unwrapEvent(sent[1], bot.key).id, reply.id);
});

test('unknown senders are denied by default, logged by npub only and never reach the model', async (t) => {
  const { bot, ollama, logs } = setup(t);
  await sendDM(bot, mallory, 'my private question');
  await sendDM(bot, mallory, 'another one');
  await settle(bot);
  assert.equal(ollama.calls.length, 0);
  assert.equal(bot.state.outbox.length, 0);
  assert.equal(logs.length, 1, 'one log line per sender per hour');
  assert.ok(logs[0].includes(nip19.npubEncode(getPublicKey(mallory))));
  assert.ok(!logs.join('\n').includes('private question'));
  // An empty allowlist answers nobody, not everybody.
  const { bot: closed, ollama: closedOllama } = setup(t, { access: { senders: [] } });
  await sendDM(closed, alice, 'hello');
  await settle(closed);
  assert.equal(closedOllama.calls.length, 0);
});

test('DM conversations are isolated per sender and keep bounded history', async (t) => {
  const { bot, ollama } = setup(t, { history: { maxMessages: 2 } });
  await sendDM(bot, alice, 'Alice secret: 1234');
  await settle(bot);
  await sendDM(bot, bob, 'What did Alice say?');
  await settle(bot);
  assert.ok(!JSON.stringify(ollama.calls[1]).includes('1234'), 'Bob never sees Alice');
  await sendDM(bot, alice, 'second');
  await settle(bot);
  await sendDM(bot, alice, 'third');
  await settle(bot);
  const prompt = ollama.calls[3].map((m) => m.content);
  assert.ok(!prompt.includes('Alice secret: 1234'), 'oldest exchange dropped at the limit');
  assert.ok(prompt.includes('second'));
  assert.equal(prompt.at(-1), 'third');
  assert.ok(!JSON.stringify(ollama.calls[3]).includes('What did Alice say?'));
});

test('private groups: only allowed groups are joined, members must be allowed and mention the bot', async (t) => {
  const owner = generateSecretKey();
  const { bot, ollama, logs } = setup(t, { access: { privateGroups: [getPublicKey(owner)] } });
  const other = privateGroup(bot); // Not allowed: invitation ignored and logged.
  assert.equal(bot.state.groups[other.group], undefined);
  assert.ok(logs.some((l) => l.includes(nip19.npubEncode(other.group))));

  const g = privateGroup(bot, owner);
  assert.ok(bot.state.groups[g.group]);
  await g.say(alice, 'no mention, just chatting');
  await g.say(mallory, `${at(bot)} I am a member but not allowed`);
  await settle(bot);
  assert.equal(ollama.calls.length, 0);
  const question = await g.say(alice, `${at(bot)} summarize our plan`);
  await settle(bot);
  assert.equal(ollama.calls.length, 1);
  assert.match(lastUser(ollama.calls[0]), /^\[npub1\w{7}…\w{4}\] summarize our plan$/);
  const [reply] = g.replies();
  assert.equal(reply.pubkey, bot.pubkey);
  assert.equal(authorized(reply, g.group, bot.state.groups[g.group]), true);
  assert.deepEqual(
    reply.tags.find((tag) => tag[0] === 'e'),
    ['e', question.id, '', 'reply'],
  );
});

test('private group history is shared within a group but isolated from DMs and other groups', async (t) => {
  const one = generateSecretKey(),
    two = generateSecretKey();
  const { bot, ollama } = setup(t, {
    access: { privateGroups: [getPublicKey(one), getPublicKey(two)] },
  });
  const a = privateGroup(bot, one),
    b = privateGroup(bot, two);
  await sendDM(bot, alice, 'DM-only secret');
  await settle(bot);
  await a.say(alice, `${at(bot)} group one fact`);
  await settle(bot);
  await a.say(bob, `${at(bot)} what was said here?`);
  await settle(bot);
  await b.say(alice, `${at(bot)} group two question`);
  await settle(bot);
  const groupOneSecond = JSON.stringify(ollama.calls[2]);
  assert.ok(groupOneSecond.includes('group one fact'), 'members share group context');
  assert.ok(!groupOneSecond.includes('DM-only secret'));
  const groupTwo = JSON.stringify(ollama.calls[3]);
  assert.ok(!groupTwo.includes('group one fact'));
  assert.ok(!groupTwo.includes('DM-only secret'));
});

test('public groups: only allowed rooms, allowed senders and mentions; replies use kind 9 a/q tags', async (t) => {
  const owner = generateSecretKey();
  const address = `34550:${getPublicKey(owner)}:ai-room`;
  const { bot, ollama, logs } = setup(t, { access: { publicGroups: [address] } });
  acceptRoom(bot, room(owner, bot, 'other-room'));
  assert.equal(bot.state.rooms[`34550:${getPublicKey(owner)}:other-room`], undefined);
  assert.ok(logs.some((l) => l.includes('Ignored public group naddr1')));
  acceptRoom(bot, room(owner, bot, 'ai-room'));
  assert.ok(bot.state.rooms[address]);

  await publicMessage(bot, sign(alice, 9, [['a', address]], 'no mention'), address);
  await publicMessage(bot, sign(mallory, 9, [['a', address]], `${at(bot)} hi`), address);
  await settle(bot);
  assert.equal(ollama.calls.length, 0);
  const question = sign(alice, 9, [['a', address]], `${at(bot)} what is a sat?`);
  await publicMessage(bot, question, address);
  await settle(bot);
  assert.equal(ollama.calls.length, 1);
  const [{ event: reply }] = bot.state.outbox;
  assert.ok(verifyEvent(reply));
  assert.equal(reply.kind, 9);
  assert.deepEqual(reply.tags, [
    ['a', address],
    ['q', question.id, '', question.pubkey],
  ]);
  // A p-tag mention works too, and the public history never includes DMs.
  await sendDM(bot, alice, 'DM secret');
  await settle(bot);
  await publicMessage(
    bot,
    sign(
      alice,
      9,
      [
        ['a', address],
        ['p', bot.pubkey],
      ],
      'follow-up',
    ),
    address,
  );
  await settle(bot);
  const publicPrompt = JSON.stringify(ollama.calls[2]);
  assert.ok(publicPrompt.includes('what is a sat?'));
  assert.ok(!publicPrompt.includes('DM secret'));
});

test('/help, /model and /reset are answered without the model; models cannot be changed', async (t) => {
  const { bot, ollama } = setup(t);
  await sendDM(bot, alice, 'remember the number 42');
  await settle(bot);
  for (const command of ['/help', `${at(bot)} /model`, '/setmodel evil', '/model other-model'])
    await sendDM(bot, alice, command);
  await settle(bot);
  const texts = dmReplies(bot, alice).map((m) => m.content);
  assert.match(texts[1], /\/reset/);
  assert.equal(texts[2], 'Model: test-model');
  assert.match(texts[3], /^Unknown command/);
  assert.equal(texts[4], 'Model: test-model');
  assert.equal(bot.ollama.model, 'test-model');
  assert.equal(ollama.calls.length, 1);
  await sendDM(bot, alice, '/reset');
  await settle(bot);
  assert.match(dmReplies(bot, alice).at(-1).content, /forgotten/);
  await sendDM(bot, alice, 'what number?');
  await settle(bot);
  assert.equal(ollama.calls[1].length, 2, 'only system prompt and the new question');
});

test('/reset during an answer prevents that answer from refilling the history', async (t) => {
  const { bot, ollama } = setup(t);
  const wait = gate();
  ollama.answer = () => wait.promise;
  await sendDM(bot, alice, 'slow question');
  await sendDM(bot, alice, '/reset');
  wait.release('slow answer');
  await settle(bot);
  assert.equal(bot.conversations.size(`dm:${getPublicKey(alice)}`), 0);
});

test('a group reset affects only that group', async (t) => {
  const owner = generateSecretKey();
  const { bot } = setup(t, { access: { privateGroups: [getPublicKey(owner)] } });
  const g = privateGroup(bot, owner);
  await sendDM(bot, alice, 'dm context');
  await g.say(alice, `${at(bot)} group context`);
  await settle(bot);
  await g.say(bob, `${at(bot)} /reset`);
  await settle(bot);
  assert.equal(bot.conversations.size(`private:${g.group}`), 0);
  assert.equal(bot.conversations.size(`dm:${getPublicKey(alice)}`), 2);
});

test('input, output, per-conversation, queue and hourly limits are enforced', async (t) => {
  const { bot, ollama } = setup(t, {
    limits: { maxInputChars: 20, maxOutputChars: 10, maxQueue: 1, requestsPerHour: 5 },
  });
  await sendDM(bot, alice, 'x'.repeat(21));
  await settle(bot);
  assert.equal(ollama.calls.length, 0);
  assert.match(dmReplies(bot, alice)[0].content, /too long/);

  ollama.answer = () => 'This answer is far longer than ten characters.';
  await sendDM(bot, alice, 'short');
  await settle(bot);
  assert.match(dmReplies(bot, alice)[1].content, /^This answe…\n\[Answer shortened/);

  const wait = gate();
  ollama.answer = () => wait.promise;
  await sendDM(bot, alice, 'first'); // Generating.
  await sendDM(bot, alice, 'second'); // Same conversation: asked to wait.
  await sendDM(bot, bob, 'bob one'); // Waits in the queue (size 1).
  await sendDM(bot, bob, 'bob two'); // Bob's conversation is busy.
  wait.release('done');
  await settle(bot);
  assert.match(dmReplies(bot, alice)[2].content, /still answering/);
  assert.match(dmReplies(bot, bob)[0].content, /still answering/);

  ollama.answer = () => 'ok';
  await sendDM(bot, alice, 'fifth'); // Alice's 5th message this hour is still allowed.
  await settle(bot);
  await sendDM(bot, alice, 'sixth'); // Over the limit: one notice...
  await sendDM(bot, alice, 'seventh'); // ...then silence, so two bots cannot loop.
  await settle(bot);
  const aliceTexts = dmReplies(bot, alice).map((m) => m.content);
  assert.equal(aliceTexts.filter((text) => /hourly message limit/.test(text)).length, 1);
  assert.equal(aliceTexts.length, 6);
  assert.equal(ollama.calls.length, 4);
});

test('a full queue answers "busy" instead of growing without bound', async (t) => {
  const { bot, ollama } = setup(t, { limits: { maxQueue: 1 } });
  const wait = gate();
  ollama.answer = () => wait.promise;
  const carol = generateSecretKey();
  bot.access.senders.add(getPublicKey(carol));
  await sendDM(bot, alice, 'running');
  await sendDM(bot, bob, 'queued');
  await sendDM(bot, carol, 'rejected');
  assert.equal(bot.jobs.length, 1);
  wait.release('ok');
  await settle(bot);
  assert.match(dmReplies(bot, carol)[0].content, /busy/);
  assert.equal(ollama.calls.length, 2);
});

test('a generated answer is queued even when the work queue is full of relay events', async (t) => {
  const { bot, ollama } = setup(t);
  const wait = gate();
  ollama.answer = () => wait.promise;
  await sendDM(bot, alice, 'slow question');
  for (let i = 0; i < 2000; i++) bot.pending.add(`flood:${i}`);
  wait.release('late answer');
  await bot.generating;
  for (let i = 0; i < 2000; i++) bot.pending.delete(`flood:${i}`);
  await settle(bot);
  assert.equal(dmReplies(bot, alice)[0].content, 'late answer');
});

test('bot-to-bot loops: own, epoch-key, edited and replayed messages are ignored; output cannot mention', async (t) => {
  const owner = generateSecretKey();
  const { bot, ollama } = setup(t, { access: { privateGroups: [getPublicKey(owner)] } });
  bot.access.senders.add(bot.pubkey);
  const g = privateGroup(bot, owner);
  const own = rumor(bot.key, [['p', bot.pubkey]], 'talking to myself');
  await directMessage(bot, own, { tags: [] });
  bot.access.senders.add(getPublicKey(g.epochKey));
  await sendDM(bot, g.epochKey, 'from an epoch key');
  const edited = rumor(
    alice,
    [
      ['p', bot.pubkey],
      ['e', 'a'.repeat(64), '', 'edit'],
    ],
    'edited',
  );
  await directMessage(bot, edited, { tags: [] });
  await directMessage(bot, { ...dm(alice, 'old', bot), created_at: now() - 90000 }, { tags: [] });
  await settle(bot);
  assert.equal(ollama.calls.length, 0);

  const otherBot = getPublicKey(generateSecretKey());
  ollama.answer = () => `Ask nostr:${nip19.npubEncode(otherBot)} instead.`;
  await g.say(alice, `${at(bot)} who knows?`);
  await settle(bot);
  const [reply] = g.replies();
  assert.equal(mentions(reply.content, otherBot), false);
  assert.ok(!reply.tags.some((tag) => tag[0] === 'p' && tag[1] === otherBot));
});

test('duplicate deliveries of one message (several relays, replays) produce one answer', async (t) => {
  const { bot, ollama } = setup(t);
  const wrapped = wrap(dm(alice, 'once please', bot), alice, bot.pubkey);
  bot.receive(wrapped, bot.key);
  bot.receive(wrapped, bot.key);
  const opened = unwrap(wrapped, bot.key);
  await settle(bot);
  await directMessage(bot, opened.message, opened.seal);
  await settle(bot);
  assert.equal(ollama.calls.length, 1);
  assert.equal(dmReplies(bot, alice).length, 1);
});

test('model failures become friendly replies, are not remembered, and the bot keeps working', async (t) => {
  const { bot, ollama, logs } = setup(t);
  const failures = [
    new OllamaError('unavailable', 'connect ECONNREFUSED 127.0.0.1:11434'),
    new OllamaError('timeout', 'timed out'),
    new OllamaError('model_not_found', 'missing'),
    new TypeError('unexpected bug'),
  ];
  ollama.answer = () => {
    throw failures.shift();
  };
  for (const text of ['one', 'two', 'three', 'four']) {
    await sendDM(bot, alice, `private question ${text}`);
    await settle(bot);
  }
  const texts = dmReplies(bot, alice).map((m) => m.content);
  assert.match(texts[0], /not reachable/);
  assert.match(texts[1], /too long/);
  assert.match(texts[2], /ollama pull test-model/);
  assert.match(texts[3], /unexpected/);
  assert.ok(!texts.join().includes('11434'));
  assert.equal(bot.conversations.size(`dm:${getPublicKey(alice)}`), 0);
  assert.ok(!logs.join('\n').includes('private question'), 'logs never contain message text');
  ollama.answer = () => 'Recovered.';
  await sendDM(bot, alice, 'are you back?');
  await settle(bot);
  assert.equal(dmReplies(bot, alice).at(-1).content, 'Recovered.');
  assert.equal(bot.stopped, false);
  assert.equal(ollama.calls.at(-1).length, 2, 'failed exchanges are not in the history');
});

test('restart: identity and dedupe persist, history does not, outbox retries the same events', async (t) => {
  const { bot, store, net, dir } = setup(t);
  const first = await sendDM(bot, alice, 'remember me');
  await settle(bot);
  const ids = bot.state.outbox.map((item) => item.event.id);
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(store.data).includes('remember me'), 'no plaintext DM on disk');
  await bot.close();

  const restored = new State(dir);
  const ollama = fakeOllama();
  const sent = [];
  net.publish = async (event) => {
    sent.push(event.id);
  };
  const restarted = new OllamaBridge({
    store: restored,
    net,
    ollama,
    access: new Access({ senders: [getPublicKey(alice)] }),
    log() {},
  });
  t.after(() => restarted.close());
  assert.equal(restarted.pubkey, bot.pubkey);
  await directMessage(restarted, first, { tags: [] }); // A relay replays the old message.
  await settle(restarted);
  assert.equal(ollama.calls.length, 0, 'not answered twice after restart');
  await restarted.flush();
  assert.deepEqual(sent, ids);
  await sendDM(restarted, alice, 'do you remember me?');
  await settle(restarted);
  assert.equal(ollama.calls[0].length, 2, 'conversation memory starts empty after restart');
});

// Access grants. Only Date is mocked, so messages can be written before or after a grant.
const MINUTE = 60000;
const frozenClock = (t) => t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
// Stops a bot and starts a new one on the same data directory, as after editing .env.
async function restart(t, previous, access) {
  await previous.bot.close();
  return setup(t, { dir: previous.dir, access });
}
const countSaves = (bot) => {
  const counter = { saves: 0 };
  const save = bot.store.save.bind(bot.store);
  bot.store.save = () => {
    counter.saves++;
    save();
  };
  return counter;
};

test('DM: messages rejected before a sender was allowed are not answered after a restart', async (t) => {
  frozenClock(t);
  const first = setup(t);
  const saves = countSaves(first.bot);
  const wraps = ['Sap man', '/help'].map((text) =>
    wrap(dm(mallory, text, first.bot), mallory, first.bot.pubkey),
  );
  for (const event of wraps) first.bot.receive(event, first.bot.key);
  await settle(first.bot);
  assert.equal(first.ollama.calls.length, 0);
  assert.deepEqual(first.bot.state.seen, {}, 'rejected messages are not saved as seen');
  assert.equal(saves.saves, 0, 'strangers cannot make the bot write to disk');

  t.mock.timers.tick(MINUTE);
  const senders = [getPublicKey(alice), getPublicKey(mallory)];
  const second = await restart(t, first, { senders });
  const grant = second.bot.state.grants[`sender:${getPublicKey(mallory)}`];
  for (const event of wraps) second.bot.receive(event, second.bot.key); // Relays resend.
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 0, 'the old question is not sent to the model');
  assert.equal(second.bot.state.outbox.length, 0, 'the old /help is not answered either');
  assert.ok(second.logs.some((line) => line.includes('sent before access was granted')));
  await sendDM(second.bot, mallory, 'now I am allowed');
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 1, 'new messages are answered');

  t.mock.timers.tick(MINUTE);
  const third = await restart(t, second, { senders });
  assert.equal(third.bot.state.grants[`sender:${getPublicKey(mallory)}`], grant, 'grant kept');
  for (const event of wraps) third.bot.receive(event, third.bot.key);
  await settle(third.bot);
  assert.equal(third.ollama.calls.length, 0);
});

test('DM: messages an allowed user sent while the bot was offline are answered once', async (t) => {
  frozenClock(t);
  const first = setup(t);
  await first.bot.close();
  t.mock.timers.tick(MINUTE);
  const offline = wrap(dm(alice, 'sent while you were down', first.bot), alice, first.bot.pubkey);
  t.mock.timers.tick(MINUTE);
  const second = await restart(t, first);
  second.bot.receive(offline, second.bot.key);
  second.bot.receive(offline, second.bot.key);
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 1);
  assert.equal(lastUser(second.ollama.calls[0]), 'sent while you were down');
  const third = await restart(t, second);
  third.bot.receive(offline, third.bot.key);
  await settle(third.bot);
  assert.equal(third.ollama.calls.length, 0, 'not answered again after another restart');
});

test('private group: mentions written before the group was allowed are not answered', async (t) => {
  frozenClock(t);
  const owner = generateSecretKey(),
    epochKey = generateSecretKey(),
    group = getPublicKey(owner);
  const first = setup(t);
  const invite = ticket(owner, first.bot.pubkey, epochKey);
  acceptTicket(first.bot, invite.message, invite.seal);
  assert.equal(first.bot.state.groups[group], undefined);
  const old = privateInput(alice, owner, epochKey, 0, first.bot, `${at(first.bot)} old question`);
  await privateMessage(first.bot, old, group, getPublicKey(epochKey));

  t.mock.timers.tick(MINUTE);
  const second = await restart(t, first, { privateGroups: [group] });
  acceptTicket(second.bot, invite.message, invite.seal); // The invitation is read again.
  assert.ok(second.bot.state.groups[group]);
  await privateMessage(second.bot, old, group, getPublicKey(epochKey));
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 0);
  const fresh = privateInput(alice, owner, epochKey, 0, second.bot, `${at(second.bot)} new`);
  await privateMessage(second.bot, fresh, group, getPublicKey(epochKey));
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 1);
});

test('public group: a newly allowed member or room does not answer earlier mentions', async (t) => {
  frozenClock(t);
  const owner = generateSecretKey(),
    other = generateSecretKey();
  const address = `34550:${getPublicKey(owner)}:ai-room`;
  const later = `34550:${getPublicKey(other)}:ai-room`;
  const first = setup(t, { access: { publicGroups: [address] } });
  acceptRoom(first.bot, room(owner, first.bot));
  const fromMallory = sign(mallory, 9, [['a', address]], `${at(first.bot)} early`);
  await publicMessage(first.bot, fromMallory, address);
  const inLaterRoom = sign(alice, 9, [['a', later]], `${at(first.bot)} before the room`);

  t.mock.timers.tick(MINUTE);
  const second = await restart(t, first, {
    senders: [getPublicKey(alice), getPublicKey(mallory)],
    publicGroups: [address, later],
  });
  acceptRoom(second.bot, room(other, second.bot));
  await publicMessage(second.bot, fromMallory, address);
  await publicMessage(second.bot, inLaterRoom, later);
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 0);
  const fresh = sign(alice, 9, [['a', later]], `${at(second.bot)} after the room`);
  await publicMessage(second.bot, fresh, later);
  await settle(second.bot);
  assert.equal(second.ollama.calls.length, 1);
});

test('pending replies are not sent to groups removed from the allow lists', async (t) => {
  const owner = generateSecretKey();
  const address = `34550:${getPublicKey(owner)}:ai-room`;
  const first = setup(t, {
    access: { privateGroups: [getPublicKey(owner)], publicGroups: [address] },
  });
  const g = privateGroup(first.bot, owner);
  await g.say(alice, `${at(first.bot)} private question`);
  acceptRoom(first.bot, room(owner, first.bot));
  await publicMessage(
    first.bot,
    sign(alice, 9, [['a', address]], `${at(first.bot)} public`),
    address,
  );
  await settle(first.bot);
  assert.equal(first.bot.state.outbox.filter((i) => i.group || i.room).length, 2);

  const second = await restart(t, first, {});
  await second.bot.flush();
  assert.deepEqual(second.sent, []);
  assert.equal(second.bot.state.outbox.length, 0);
});

test('revoking access removes the grant, so allowing again starts a new window', async (t) => {
  frozenClock(t);
  const address = `34550:${getPublicKey(generateSecretKey())}:ai-room`;
  const first = setup(t, { access: { publicGroups: [address] } });
  const before = first.bot.state.grants[`sender:${getPublicKey(alice)}`];
  assert.ok(first.bot.state.grants[`public:${address}`]);

  t.mock.timers.tick(MINUTE);
  const revoked = await restart(t, first, { senders: [getPublicKey(bob)] });
  assert.equal(revoked.bot.state.grants[`sender:${getPublicKey(alice)}`], undefined);
  assert.equal(revoked.bot.state.grants[`public:${address}`], undefined);
  const during = wrap(dm(alice, 'while revoked', revoked.bot), alice, revoked.bot.pubkey);
  revoked.bot.receive(during, revoked.bot.key);
  await settle(revoked.bot);
  assert.equal(revoked.ollama.calls.length, 0);

  t.mock.timers.tick(MINUTE);
  const again = await restart(t, revoked);
  assert.ok(again.bot.state.grants[`sender:${getPublicKey(alice)}`] > before, 'a new window');
  again.bot.receive(during, again.bot.key);
  await settle(again.bot);
  assert.equal(again.ollama.calls.length, 0, 'messages from the revoked period stay unanswered');
  await sendDM(again.bot, alice, 'back again');
  await settle(again.bot);
  assert.equal(again.ollama.calls.length, 1);
});

test('state files without grants are migrated conservatively; malformed grants are refused', async (t) => {
  frozenClock(t);
  const first = setup(t);
  await first.bot.close();
  const saved = JSON.parse(readFileSync(first.store.file, 'utf8'));
  delete saved.grants; // A state.json written before grants existed.
  writeFileSync(first.store.file, JSON.stringify(saved));
  const pending = wrap(dm(alice, 'before the upgrade', first.bot), alice, first.bot.pubkey);

  t.mock.timers.tick(MINUTE);
  const upgraded = setup(t, { dir: first.dir });
  assert.equal(upgraded.bot.state.grants[`sender:${getPublicKey(alice)}`], now());
  assert.ok(JSON.parse(readFileSync(first.store.file, 'utf8')).grants, 'migration is saved');
  upgraded.bot.receive(pending, upgraded.bot.key);
  await settle(upgraded.bot);
  assert.equal(upgraded.ollama.calls.length, 0, 'access is never granted retroactively');
  await sendDM(upgraded.bot, alice, 'after the upgrade');
  await settle(upgraded.bot);
  assert.equal(upgraded.ollama.calls.length, 1);
  await upgraded.bot.close();

  for (const grants of [[], { 'sender:x': 'soon' }, { 'sender:x': -1 }, null]) {
    writeFileSync(first.store.file, JSON.stringify({ ...saved, grants }));
    assert.throws(() => new State(first.dir), /Invalid state\.json/);
  }
});

test('shutdown cancels the model request in progress and releases the data directory', async (t) => {
  const { bot, ollama, dir } = setup(t);
  let aborted = false;
  ollama.answer = (messages, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new OllamaError('aborted', 'cancelled'));
      });
    });
  await sendDM(bot, alice, 'long question');
  await sendDM(bot, bob, 'waiting question');
  await bot.close();
  assert.equal(aborted, true);
  assert.equal(bot.state.outbox.length, 0);
  assert.equal(ollama.calls.length, 1, 'the waiting question is not started');
  new State(dir).close(); // The lock was released.
});

test('profile marks the account as a bot and only includes a picture when configured', async (t) => {
  const { bot, sent } = setup(t);
  await publishProfile(bot);
  assert.equal(sent[0].kind, 10050);
  const profile = JSON.parse(sent[1].content);
  assert.equal(profile.bot, true);
  assert.equal(profile.name, 'Ollama Bridge (Example Anagram Bot)');
  assert.equal(profile.picture, undefined);
  await publishProfile(bot, { pictureURL: 'https://example.org/ai.png', nip05: 'ai@example.org' });
  assert.equal(JSON.parse(sent[3].content).picture, 'https://example.org/ai.png');
  assert.equal(JSON.parse(sent[3].content).nip05, 'ai@example.org');
  await assert.rejects(publishProfile(bot, { pictureURL: 'http://example.org/ai.png' }));
});
