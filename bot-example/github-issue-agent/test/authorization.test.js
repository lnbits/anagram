// Relays resend recent history after every start. Messages written before their author
// or group was allowed must stay unanswered, while messages from identities that were
// already allowed are still answered after the bot was offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools';
import { now } from '../vendor/runtime.js';
import {
  alice,
  at,
  bob,
  dm,
  parent,
  privateGroup,
  publicGroup,
  REPO,
  repliesFor,
  sendDM,
  settle,
  setup,
} from './helpers.js';

const HOUR = 3600;
const ALICE = getPublicKey(alice),
  BOB = getPublicKey(bob);
const onlyAlice = [[ALICE, [REPO]]];
const both = [
  [ALICE, [REPO]],
  [BOB, [REPO]],
];

function tempDir(t) {
  const dir = mkdtempSync(`${parent}authorization-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Pretends the bot has been installed for a while, so the 24-hour window is not what
// rejects the old messages in these tests.
function installedEarlier(store) {
  store.data.startedAt = now() - 12 * HOUR;
  store.save();
}
async function deliver(bot, messages) {
  for (const message of messages) await bot.directMessage(message, { tags: [] });
  await settle(bot);
}

test('DM: messages sent before the sender was allowed are not answered after a restart', async (t) => {
  const dir = tempDir(t);
  const first = setup(t, { dir, users: onlyAlice });
  installedEarlier(first.store);
  const old = ['Hi', '/help', '/confirm ABCDEF'].map((text, i) =>
    dm(bob, text, first.bot, [], now() - 600 + i),
  );
  await deliver(first.bot, old);
  assert.equal(repliesFor(first.bot, bob).length, 0);
  await first.bot.close();

  // The operator adds Bob and restarts; the relay resends Bob's history.
  const second = setup(t, { dir, users: both });
  assert.ok(second.bot.state.authorized.users[BOB] >= now() - 5);
  await deliver(second.bot, old);
  assert.equal(repliesFor(second.bot, bob).length, 0);
  assert.ok(
    old.every((m) => second.bot.state.seen[m.id] === undefined),
    'not recorded as seen',
  );
  assert.equal(second.ollama.calls.length, 0);
  assert.equal(second.github.creates.length, 0);
  // New messages from Bob are answered.
  await sendDM(second.bot, bob, '/help');
  assert.equal(repliesFor(second.bot, bob).length, 1);
});

test('offline delivery: users and groups allowed earlier keep their time across restarts', async (t) => {
  const dir = tempDir(t);
  const address = `34550:${'a'.repeat(64)}:room`;
  const groups = { privateGroups: ['b'.repeat(64)], publicGroups: [address] };
  const first = setup(t, { dir, users: onlyAlice, groups });
  installedEarlier(first.store);
  const since = now() - 2 * HOUR;
  first.store.data.authorized.users[ALICE] = since;
  first.store.data.authorized.publicGroups[address] = since;
  first.store.save();
  await first.bot.close();

  // Alice wrote while the bot was offline; the relay delivers it after the restart.
  const second = setup(t, { dir, users: onlyAlice, groups });
  assert.equal(second.bot.state.authorized.users[ALICE], since);
  assert.equal(second.bot.state.authorized.publicGroups[address], since);
  assert.ok(Number.isSafeInteger(second.bot.state.authorized.privateGroups['b'.repeat(64)]));
  const offline = dm(alice, '/help', second.bot, [], now() - HOUR);
  await deliver(second.bot, [offline]);
  assert.equal(repliesFor(second.bot, alice).length, 1);
  assert.ok(second.bot.state.seen[offline.id]);
});

test('removing a user and adding them back starts a new authorization time', async (t) => {
  const dir = tempDir(t);
  const first = setup(t, { dir, users: both });
  installedEarlier(first.store);
  first.store.data.authorized.users[BOB] = now() - 2 * HOUR;
  first.store.save();
  await first.bot.close();

  const second = setup(t, { dir, users: onlyAlice });
  assert.equal(second.bot.state.authorized.users[BOB], undefined);
  assert.ok(second.bot.state.authorized.users[ALICE]);
  await second.bot.close();

  const third = setup(t, { dir, users: both });
  assert.ok(third.bot.state.authorized.users[BOB] >= now() - 5);
  // Written while Bob was removed: not answered, not recorded.
  const old = dm(bob, '/help', third.bot, [], now() - HOUR);
  await deliver(third.bot, [old]);
  assert.equal(repliesFor(third.bot, bob).length, 0);
  assert.equal(third.bot.state.seen[old.id], undefined);
});

test('private group: mentions sent before the group was allowed are not answered', async (t) => {
  const { bot, store } = setup(t);
  installedEarlier(store);
  // Alice has been allowed for a while; only the group is new.
  bot.state.authorized.users[ALICE] = now() - 2 * HOUR;
  const g = privateGroup(bot);
  assert.ok(bot.state.authorized.privateGroups[g.group] >= now() - 5);
  const old = await g.say(alice, `${at(bot)} /help`, [], now() - 600);
  assert.equal(g.replies().length, 0);
  assert.equal(bot.state.seen[old.id], undefined);
  // The same kind of message is answered once the group was allowed before it was written.
  bot.state.authorized.privateGroups[g.group] = now() - HOUR;
  await g.say(alice, `${at(bot)} /help`, [], now() - 599);
  assert.equal(g.replies().length, 1);
});

test('public group: mentions sent before the group was allowed are not answered', async (t) => {
  const { bot, store } = setup(t);
  installedEarlier(store);
  bot.state.authorized.users[ALICE] = now() - 2 * HOUR;
  const g = publicGroup(bot);
  assert.ok(bot.state.authorized.publicGroups[g.address] >= now() - 5);
  const old = await g.say(alice, `${at(bot)} /help`, [], now() - 600);
  assert.equal(g.replies().length, 0);
  assert.equal(bot.state.seen[old.id], undefined);
  bot.state.authorized.publicGroups[g.address] = now() - HOUR;
  await g.say(alice, `${at(bot)} /help`, [], now() - 599);
  assert.equal(g.replies().length, 1);
});

test('group messages from a newly allowed user are not answered either', async (t) => {
  const { bot, store } = setup(t);
  installedEarlier(store);
  const g = publicGroup(bot);
  bot.state.authorized.publicGroups[g.address] = now() - 2 * HOUR;
  // Bob was allowed just now (when the bot started); his older mention is ignored.
  const old = await g.say(bob, `${at(bot)} /help`, [], now() - 600);
  assert.equal(g.replies().length, 0);
  assert.equal(bot.state.seen[old.id], undefined);
});
