// Regression tests for findings of the independent security review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText } from '../drafting.js';
import {
  alice,
  at,
  codeOf,
  last,
  privateGroup,
  publicGroup,
  REPO,
  sendDM,
  settle,
  setup,
} from './helpers.js';

test('GitHub mentions are neutralized after punctuation and as HTML entities', () => {
  for (const input of [
    '_@alice_',
    '-@alice',
    '.@alice',
    'see/@alice',
    '(@alice)',
    '&#64;alice',
    '&#x40;alice',
    '&commat;alice',
  ])
    assert.match(sanitizeText(input), /`@alice`/, input);
  assert.equal(
    sanitizeText('mail a@b.com or first.last@x.org'),
    'mail a@b.com or first.last@x.org',
  );
});

test('groups get links to similar issues but never their titles', async (t) => {
  const { bot, github } = setup(t);
  github.searchResults = [
    {
      number: 7,
      title: 'Mobile login fails SECRET-PRIVATE-TITLE',
      state: 'open',
      url: 'https://github.com/lnbits/anagram/issues/7',
    },
  ];
  for (const g of [publicGroup(bot), privateGroup(bot)]) {
    await g.say(alice, `${at(bot)} issue in ${REPO}: mobile login fails`);
    const draft = g.replies().at(-1).content;
    assert.match(draft, /#7 \(open\) — https:\/\/github.com\/lnbits\/anagram\/issues\/7/);
    assert.ok(!draft.includes('SECRET-PRIVATE-TITLE'));
  }
});

test('issues published in a DM are not linked to the requester in a group', async (t) => {
  const { bot } = setup(t);
  await sendDM(bot, alice, `issue in ${REPO}: mobile login fails`);
  await sendDM(bot, alice, `/confirm ${codeOf(last(bot, alice))}`);
  const ref = bot.state.issues[0].ref;
  const room = publicGroup(bot);
  await room.say(alice, `${at(bot)} issue in ${REPO}: mobile login fails`);
  assert.ok(!room.replies().at(-1).content.includes(ref));
  assert.ok(!room.replies().at(-1).content.includes('You already published'));
});

test('a dropped edit result never leaves the draft locked', async (t) => {
  const { bot } = setup(t);
  await sendDM(bot, alice, `issue in ${REPO}: crash`);
  const draft = bot.drafts.all()[0];
  const original = bot.submit.bind(bot);
  bot.submit = (id, action) => (id.startsWith('edit:') ? false : original(id, action));
  await sendDM(bot, alice, `/edit ${draft.code} shorter`);
  assert.equal(draft.editing, false);
  bot.submit = original;
  await sendDM(bot, alice, `/confirm ${draft.code}`);
  assert.match(last(bot, alice).content, /Published/);
});

test('a storage error in an unawaited reply goes to onFatal, not an unhandled rejection', async (t) => {
  const { bot } = setup(t);
  const fatal = [];
  bot.onFatal = (error) => fatal.push(error);
  const save = bot.store.save.bind(bot.store);
  bot.store.save = () => {
    throw new Error('disk full');
  };
  const pending = bot.say(
    { context: { conversation: `dm:${'a'.repeat(64)}` }, message: { id: 'b'.repeat(64) } },
    'hi',
  );
  await pending;
  assert.equal(fatal.length, 1);
  assert.equal(bot.stopped, true);
  bot.store.save = save;
  await settle(bot).catch(() => {});
});
