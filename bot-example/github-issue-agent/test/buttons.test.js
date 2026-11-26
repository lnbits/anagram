// Inline buttons on draft messages: Preview, Refresh status and Cancel draft, answered
// privately. Nothing here can publish: /confirm CODE stays the only way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools';
import { DRAFT_KEYBOARD } from '../messages.js';
import { now, rumor, unwrap, wrap } from '../vendor/runtime.js';
import {
  BOT_CONTROL_KIND,
  controlTag,
  keyboardFromTags,
  parseControl,
} from '../vendor/botKeyboardProtocol.ts';
import {
  alice,
  at,
  bob,
  codeOf,
  last,
  mallory,
  privateGroup,
  publicGroup,
  refOf,
  REPO,
  sendDM,
  settle,
  setup,
  ticket,
} from './helpers.js';

const pub = (key) => getPublicKey(key);
// What Anagram sends when a button is pressed: a kind 21118 rumor, gift-wrapped to the bot.
function press(user, bot, card, data = 'status', extra = {}) {
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
  await settle(bot);
}
// The bot's personal answers queued for one person, oldest first.
const answers = (bot, user) =>
  bot.state.outbox
    .map((item) => unwrap(item.event, user)?.message)
    .filter((message) => message?.kind === BOT_CONTROL_KIND);
const lastCard = (bot) => Object.values(bot.state.cards).at(-1);

async function draft(bot, key = alice) {
  await sendDM(bot, key, `create an issue in ${REPO} about the mobile login bug`);
  const message = last(bot, key);
  assert.match(message.content, /^Draft AG-/);
  return { message, code: codeOf(message), ref: refOf(message), card: lastCard(bot) };
}

test('dm: a draft message is a card; Preview and Refresh status answer privately and never publish', async (t) => {
  const { bot, github } = setup(t);
  const { message, code, ref, card } = await draft(bot);
  assert.deepEqual(keyboardFromTags(message.tags), DRAFT_KEYBOARD);
  assert.ok(!message.content.includes('callback_data'), 'other clients see only the text');
  assert.deepEqual(card, {
    target: {
      type: 'dm',
      chat: bot.pubkey,
      root: message.id,
      version: message.id,
      bot: bot.pubkey,
    },
    recipient: pub(alice),
    ref,
    at: card.at,
    views: {},
  });
  await sendDM(bot, alice, '/help');
  assert.equal(keyboardFromTags(last(bot, alice).tags), null, 'only drafts carry buttons');

  const request = press(alice, bot, card, 'preview');
  await deliver(bot, request, alice);
  const [preview] = answers(bot, alice);
  assert.match(
    preview.content,
    new RegExp(`^Preview of ${ref}, as it would be published to ${REPO} \\(code ${code}\\):`),
  );
  assert.match(
    preview.content,
    /Title: Mobile login fails\n\nLogin does not work on the mobile app\./,
  );
  assert.match(preview.content, new RegExp(`${ref}`));
  assert.ok(!preview.content.includes('anagram-issue-agent:'), 'the hidden marker is not shown');
  assert.match(preview.content, new RegExp(`/confirm ${code} — publish`));
  assert.equal(preview.pubkey, bot.pubkey);
  assert.deepEqual(preview.tags[0], ['p', pub(alice)]);
  assert.ok(!preview.tags.some((tag) => tag[0] === 'e'), 'an answer is not a timeline reply');
  const { id, expires } = parseControl(request.tags);
  assert.deepEqual(parseControl(preview.tags), { op: 'answer', id, target: card.target, expires });
  assert.deepEqual(keyboardFromTags(preview.tags), DRAFT_KEYBOARD);
  assert.deepEqual(card.views[pub(alice)], [preview.id]);

  await deliver(bot, press(alice, bot, card, 'status', { view: preview.id }), alice);
  const [, status] = answers(bot, alice);
  assert.equal(
    status.content.replace(/Expires in \d+ hours\./, 'Expires in N hours.'),
    `${ref} for ${REPO}: draft (revision 1), waiting for /confirm ${code}. Expires in N hours.`,
  );
  assert.equal(github.creates.length, 0, 'buttons never publish');

  // After /confirm, Refresh status shows the published issue; Cancel says it is too late.
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
  await deliver(bot, press(alice, bot, card, 'status'), alice);
  assert.match(
    answers(bot, alice)[2].content,
    new RegExp(`^${ref}: ${REPO}#1 https://github.com/${REPO}/issues/1\nTitle: Mobile login fails`),
  );
  await deliver(bot, press(alice, bot, card, 'cancel'), alice);
  assert.match(
    answers(bot, alice)[3].content,
    new RegExp(`^Draft ${code} was already published as ${ref}: https://`),
  );
  await deliver(bot, press(alice, bot, card, 'preview'), alice);
  assert.match(
    answers(bot, alice)[4].content,
    new RegExp(`^${ref}: ${REPO}#1`),
    'preview of a published draft is its status',
  );
  assert.equal(github.creates.length, 1);
});

test('Cancel draft does what /cancel does, for the requester only, and removes the buttons for that person', async (t) => {
  const { bot, github } = setup(t);
  const { code, ref, card } = await draft(bot);
  await deliver(bot, press(alice, bot, card, 'cancel'), alice);
  const [cancelled] = answers(bot, alice);
  assert.equal(cancelled.content, `Cancelled draft ${ref} (code ${code}).`);
  assert.deepEqual(keyboardFromTags(cancelled.tags), { inline_keyboard: [] });
  assert.equal(bot.drafts.get(code), undefined);
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.match(last(bot, alice).content, /^No draft with code/);
  assert.equal(github.creates.length, 0);
  // Later presses on the old card explain that the draft is gone.
  await deliver(bot, press(alice, bot, card, 'preview'), alice);
  assert.match(answers(bot, alice)[1].content, new RegExp(`^${ref} is no longer available here`));
  await deliver(bot, press(alice, bot, card, 'cancel'), alice);
  assert.match(answers(bot, alice)[2].content, new RegExp(`^${ref} is no longer available here`));
});

test('a repeated press gets the stored answer again; a reused id with other data gets nothing; restarts forget drafts but not records', async (t) => {
  const fixture = setup(t);
  let { bot } = fixture;
  const { code, ref, card } = await draft(bot);
  const request = press(alice, bot, card, 'preview');
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
    ...rumor(alice, [['p', bot.pubkey], controlTag({ ...control, data: 'cancel' })], ''),
    kind: BOT_CONTROL_KIND,
  };
  altered.id = getEventHash(altered);
  await deliver(bot, altered, alice);
  assert.equal(bot.state.outbox.length, 0, 'same id, other button: refused');
  assert.ok(bot.drafts.get(code), 'and nothing was cancelled');

  // Publish, then restart: the draft is forgotten, the record and the card are not.
  await sendDM(bot, alice, `/confirm ${code}`);
  await bot.flush();
  await bot.close();
  bot = setup(t, { dir: fixture.dir }).bot;
  await settle(bot);
  assert.ok(bot.state.cards[card.target.root], 'cards survive a restart');
  await deliver(bot, request, alice);
  assert.equal(bot.state.outbox.at(-1).event.id, stored.event.id, 'the stored answer survives too');
  await deliver(bot, press(alice, bot, card, 'status'), alice);
  assert.match(answers(bot, alice).at(-1).content, new RegExp(`^${ref}: ${REPO}#1`));
  // A card of a draft that was never published is just gone after a restart.
  const second = await draft(bot);
  await bot.close();
  bot = setup(t, { dir: fixture.dir }).bot;
  await settle(bot);
  await deliver(bot, press(alice, bot, second.card, 'cancel'), alice);
  assert.match(answers(bot, alice).at(-1).content, /is no longer available here/);
});

test('presses are refused when expired, from another person, for another version, for a button not on the card, or by strangers', async (t) => {
  const { bot, logs } = setup(t);
  const { card } = await draft(bot);
  const refused = [
    press(alice, bot, card, 'status', { expires: now() - 1 }),
    press(alice, bot, card, 'status', { expires: now() + 301 }),
    press(alice, bot, card, 'confirm'),
    press(alice, bot, card, 'publish'),
    press(alice, bot, { target: { ...card.target, version: 'b'.repeat(64) } }),
    press(alice, bot, {
      target: { ...card.target, root: 'c'.repeat(64), version: 'c'.repeat(64) },
    }),
    { ...press(alice, bot, card), content: 'not empty' },
    { ...press(alice, bot, card), created_at: now() - 301 },
    press(alice, bot, card, 'status', { view: 'a'.repeat(64) }),
  ];
  for (const event of refused) {
    event.id = getEventHash(event);
    await deliver(bot, event, alice);
  }
  await deliver(bot, press(bob, bot, card), bob);
  await deliver(bot, press(mallory, bot, card), mallory);
  assert.equal(bot.state.outbox.length, 2, 'only the two copies of the draft were queued');
  assert.deepEqual(Object.keys(bot.state.callbacks), []);
  assert.ok(!logs.some((line) => line.includes('Ignored a message')), 'DM cards refuse silently');
  // A control rumor that is not a request is never treated as a message either.
  const stray = { ...rumor(alice, [['p', bot.pubkey]], '/drafts'), kind: BOT_CONTROL_KIND };
  stray.id = getEventHash(stray);
  await deliver(bot, stray, alice);
  assert.equal(bot.state.outbox.length, 2);
  assert.equal(bot.state.seen[stray.id], undefined);
});

test('private group: members see Preview and status with a valid proof, only the requester can cancel, strangers get nothing', async (t) => {
  const { bot, github } = setup(t);
  const g = privateGroup(bot);
  const request = await g.say(
    alice,
    `${at(bot)} create an issue in ${REPO} about the mobile login bug`,
  );
  const draftMessage = g.replies().at(-1);
  assert.match(draftMessage.content, /^Draft AG-/);
  assert.deepEqual(keyboardFromTags(draftMessage.tags), DRAFT_KEYBOARD);
  const code = codeOf(draftMessage);
  const card = lastCard(bot);
  assert.deepEqual(card.target, {
    type: 'private',
    chat: g.group,
    root: draftMessage.id,
    version: draftMessage.id,
    bot: bot.pubkey,
  });
  assert.equal(card.recipient, undefined, 'a group card belongs to the whole group');
  assert.equal(request.pubkey, pub(alice));
  const proof = (key) => {
    const t = ticket(g.owner, pub(key), g.epochKey);
    return { epoch: 0, invited_at: t.message.created_at, invitation_proof: t.signed.sig };
  };
  // Bob (allowed, member) may read; a forged or stale proof, or a stranger, gets nothing.
  for (const bad of [
    { ...proof(bob), invitation_proof: proof(mallory).invitation_proof },
    { ...proof(bob), epoch: 1 },
  ])
    await deliver(bot, press(bob, bot, card, 'preview', { membership: bad }), bob);
  await deliver(bot, press(mallory, bot, card, 'preview', { membership: proof(mallory) }), mallory);
  assert.equal(answers(bot, bob).length, 0);
  assert.equal(answers(bot, mallory).length, 0, 'group membership alone grants nothing');
  await deliver(bot, press(bob, bot, card, 'preview', { membership: proof(bob) }), bob);
  const [preview] = answers(bot, bob);
  assert.match(preview.content, /^Preview of AG-/);
  assert.equal(parseControl(preview.tags).membership.epoch, 0);
  assert.equal(
    parseControl(preview.tags).membership.invitation_proof,
    bot.state.groups[g.group].ticket.sig,
  );
  await deliver(bot, press(bob, bot, card, 'cancel', { membership: proof(bob) }), bob);
  assert.equal(
    answers(bot, bob)[1].content,
    `Only the person who requested draft ${code} can cancel it.`,
  );
  assert.ok(bot.drafts.get(code));
  // The repository turning private hides everything, privately too.
  github.privateRepos.add(REPO);
  await deliver(bot, press(bob, bot, card, 'status', { membership: proof(bob) }), bob);
  assert.match(answers(bot, bob)[2].content, /^That repository is not public/);
  github.privateRepos.delete(REPO);
  bot.publicRepos.add(REPO);
  await deliver(bot, press(alice, bot, card, 'cancel', { membership: proof(alice) }), alice);
  assert.equal(
    answers(bot, alice)[0].content,
    `Cancelled draft ${refOf(draftMessage)} (code ${code}).`,
  );
  assert.equal(bot.drafts.get(code), undefined);
  assert.equal(g.replies().length, 1, 'no group message was added by any press');
  assert.equal(github.creates.length, 0);
});

test('public group: allowed people may press while the bot is trusted; blocked people and strangers get nothing', async (t) => {
  const { bot, logs } = setup(t);
  const room = publicGroup(bot);
  await room.say(alice, `${at(bot)} create an issue in ${REPO} about the mobile login bug`);
  const draftMessage = room.replies().at(-1);
  assert.deepEqual(keyboardFromTags(draftMessage.tags), DRAFT_KEYBOARD);
  const card = lastCard(bot);
  assert.deepEqual(card.target, {
    type: 'public',
    chat: room.address,
    root: draftMessage.id,
    version: draftMessage.id,
    bot: bot.pubkey,
  });
  await deliver(bot, press(bob, bot, card, 'status'), bob);
  assert.match(answers(bot, bob)[0].content, /^AG-[0-9A-Z]{4} for lnbits\/anagram: draft/);
  assert.equal(answers(bot, alice).length, 0, 'answers are personal');
  await deliver(bot, press(mallory, bot, card, 'status'), mallory);
  assert.equal(answers(bot, mallory).length, 0);
  assert.ok(logs.some((line) => line.includes('not in ALLOWED_USERS')));
  bot.access.publicGroups.delete(room.address);
  await deliver(bot, press(bob, bot, card, 'status'), bob);
  assert.equal(answers(bot, bob).length, 1, 'a group taken off the allowlist is dead');
  assert.equal(room.replies().length, 1, 'no group message was added by any press');
});

test('cards and replay markers are bounded and expire', async (t) => {
  const { bot } = setup(t);
  const old = 'd'.repeat(64);
  bot.state.cards[old] = { target: {}, ref: 'AG-0000', at: now() - 8 * 86400, views: {} };
  for (let i = 0; i < 1000; i++)
    bot.state.cards[`${i}`.padStart(64, '0')] = {
      target: {},
      ref: 'AG-0000',
      at: now() - 1000 + i,
      views: {},
    };
  bot.state.callbacks['x:y'] = { expires: now() - 301, fingerprint: 'z', delivery: {} };
  const { card } = await draft(bot);
  assert.equal(bot.state.cards[old], undefined, 'week-old cards are dropped');
  assert.equal(Object.keys(bot.state.cards).length, 1000, 'the oldest card makes room');
  assert.equal(bot.state.cards['0'.repeat(64)], undefined);
  await deliver(bot, press(alice, bot, card, 'status'), alice);
  assert.equal(bot.state.callbacks['x:y'], undefined, 'expired replay markers are dropped');
  assert.equal(Object.keys(bot.state.callbacks).length, 1);
});
