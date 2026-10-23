import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import {
  alice,
  at,
  bob,
  codeOf,
  dm,
  last,
  mallory,
  OTHER,
  privateGroup,
  publicGroup,
  refOf,
  REPO,
  replyTag,
  repliesFor,
  sendDM,
  settle,
  setup,
  stamp,
} from './helpers.js';
import { sign } from '../vendor/runtime.js';
import { until } from './relay.js';

test('private group: addressing, requester-only confirmation and shared history', async (t) => {
  const { bot, github, ollama } = setup(t);
  const g = privateGroup(bot);
  // Not addressed: ignored without being marked handled.
  const chatter = await g.say(alice, `there is a bug in ${REPO} with logins`);
  assert.equal(bot.state.seen[chatter.id], undefined);
  assert.equal(g.replies().length, 0);
  // Not allowed sender: ignored even when mentioning the bot.
  await g.say(mallory, `${at(bot)} create an issue in ${REPO} about logins`);
  assert.equal(g.replies().length, 0);
  // A bare /help is meant for any bot, so it is ignored.
  await g.say(alice, '/help');
  assert.equal(g.replies().length, 0);

  const request = await g.say(
    alice,
    `${at(bot)} create an issue in ${REPO} about the mobile login bug`,
  );
  const draftMessage = g.replies().at(-1);
  assert.match(draftMessage.content, /^Draft AG-/);
  assert.deepEqual(
    draftMessage.tags.find((tag) => tag[0] === 'e'),
    ['e', request.id, '', 'reply'],
  );
  const code = codeOf(draftMessage);
  const ref = refOf(draftMessage);

  // Bob is allowed and in the group, but cannot confirm or edit Alice's draft.
  await g.say(bob, `/confirm ${code}`);
  assert.match(g.replies().at(-1).content, /Only the person who requested/);
  await g.say(bob, 'add more detail', [replyTag(draftMessage.id)]);
  assert.match(g.replies().at(-1).content, /Only the person who requested/);
  assert.equal(ollama.calls.length, 1);

  // Alice edits by replying to the draft, then confirms with a bare command.
  await g.say(alice, 'mention it happens on Android', [replyTag(draftMessage.id)]);
  const revised = g.replies().at(-1);
  assert.match(revised.content, /^Updated draft/);
  await g.say(alice, `/confirm ${codeOf(revised)}`);
  assert.equal(github.creates.length, 1);
  assert.match(g.replies().at(-1).content, new RegExp(`Published ${ref}`));

  // Any authorized participant can see the group's history and the mapping.
  await g.say(bob, `${at(bot)} /issues`);
  assert.match(g.replies().at(-1).content, new RegExp(`${ref} ${REPO}#1`));
  await g.say(bob, `/who ${ref}`);
  assert.ok(
    g
      .replies()
      .at(-1)
      .content.includes(nip19.npubEncode(getPublicKey(alice))),
  );
  // ...but not from somewhere else, not even the requester's own DM.
  await sendDM(bot, alice, `/who ${ref}`);
  assert.match(last(bot, alice).content, /No issue/);
  await sendDM(bot, alice, `/confirm ${codeOf(revised)}`);
  assert.match(last(bot, alice).content, /No draft with code/);
});

test('codes and references never cross between groups', async (t) => {
  const { bot, github } = setup(t);
  const a = privateGroup(bot);
  const b = privateGroup(bot);
  await a.say(alice, `${at(bot)} issue in ${REPO}: crash on start`);
  const code = codeOf(a.replies().at(-1));
  // A bare command with a foreign code is not addressed to the bot in group B.
  await b.say(alice, `/confirm ${code}`);
  assert.equal(b.replies().length, 0);
  await b.say(alice, `${at(bot)} /confirm ${code}`);
  assert.match(b.replies().at(-1).content, /No draft with code/);
  assert.equal(github.creates.length, 0);
});

test('private groups must be allowed', async (t) => {
  const { bot, logs } = setup(t);
  const g = privateGroup(bot, { allow: false });
  assert.equal(bot.state.groups[g.group], undefined);
  assert.ok(logs.some((line) => line.includes('not in ALLOWED_PRIVATE_GROUPS')));
});

test('public group: p-tag mention, q-tag reply edits, no repository list in public', async (t) => {
  const { bot, github } = setup(t);
  const room = publicGroup(bot);
  await room.say(alice, `${at(bot)} the login is broken`);
  const question = room.replies().at(-1);
  assert.match(question.content, /Which repository/);
  assert.ok(!question.content.includes('lnbits/'), 'repositories are not listed publicly');
  await room.say(alice, `the login is broken in ${REPO}`, [['p', bot.pubkey]]);
  const draftEvent = room.replies().at(-1);
  assert.match(draftEvent.content, /^Draft AG-/);
  await room.say(alice, 'add steps: open app, tap login', [['q', draftEvent.id, '', bot.pubkey]]);
  const revised = room.replies().at(-1);
  assert.match(revised.content, /^Updated draft/);
  await room.say(alice, `/confirm ${codeOf(revised)}`, [['p', bot.pubkey]]);
  assert.equal(github.creates.length, 1);
  await room.say(alice, `${at(bot)} /help`);
  assert.ok(!room.replies().at(-1).content.includes('Your repositories'));
  assert.match(room.replies().at(-1).content, /visible to the whole group/);
  await room.say(bob, `${at(bot)} /new lnbits/lnbits wallet bug`);
  assert.match(room.replies().at(-1).content, /not allowed to create issues in that repository\.$/);
  assert.ok(!room.replies().at(-1).content.includes('lnbits/lnbits'));
});

test('a DM reply references the request and the reply id is remembered for edits', async (t) => {
  const { bot } = setup(t);
  const request = await sendDM(bot, alice, `issue in ${REPO}: crash`);
  const reply = last(bot, alice);
  assert.deepEqual(reply.tags, [
    ['p', getPublicKey(alice)],
    ['e', request.id, '', 'reply'],
  ]);
  assert.equal(bot.sent.get(reply.id).kind, 'draft');
  // The bot also keeps a copy for itself.
  const own = bot.state.outbox.map((item) => {
    try {
      return unwrapEvent(item.event, bot.key);
    } catch {
      return null;
    }
  });
  assert.ok(own.some((m) => m?.id === reply.id));
});

test('groups never show private repositories, their drafts or their issues', async (t) => {
  const { bot, github, ollama } = setup(t, { publicRepos: [REPO] });
  const g = privateGroup(bot);
  const room = publicGroup(bot);
  for (const chat of [g, room]) {
    const replies = () => chat.replies().map((e) => e.content);
    await chat.say(alice, `${at(bot)} create an issue in ${OTHER} about wallet sync`);
    assert.match(replies().at(-1), /not public, so I handle it only in a direct message/);
    await chat.say(alice, `${at(bot)} /help`);
    await chat.say(alice, `${at(bot)} the login is broken`);
    await chat.say(mallory, `${at(bot)} /help`);
    await chat.say(bob, `${at(bot)} /new ${OTHER} wallet bug`);
    assert.ok(
      replies().every((text) => !text.includes(OTHER) && !text.includes('Your repositories')),
    );
  }
  assert.equal(ollama.calls.length, 0);

  // A draft for a public repository whose repository turns private before publication:
  // the group only learns that the requester was told; the URL goes to the requester's DM.
  await g.say(alice, `${at(bot)} create an issue in ${REPO} about the login bug`);
  const code = codeOf(g.replies().at(-1));
  const ref = refOf(g.replies().at(-1));
  // GitHub now says private; the bot's cache still says public.
  github.onCreate = (repo, issue) => {
    github.privateRepos.add(REPO);
    return github.create(repo, issue.title, issue.body);
  };
  await g.say(alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
  assert.equal(
    g.replies().at(-1).content,
    `${ref}: I sent the result to the requester by direct message.`,
  );
  assert.match(last(bot, alice).content, new RegExp(`Published ${ref} as ${REPO}#1: https://`));
  // Lists and lookups in the group now leave it out.
  await g.say(alice, `${at(bot)} /issues`);
  assert.match(g.replies().at(-1).content, /No issues have been created/);
  await g.say(bob, `/who ${ref}`);
  assert.match(g.replies().at(-1).content, /not public/);
  assert.ok(g.replies().every((e) => !e.content.includes('github.com')));
});

test('repository visibility comes from GitHub and anything unclear counts as private', async (t) => {
  const { bot, github, logs } = setup(t, { publicRepos: [] });
  github.privateRepos.add(OTHER);
  await bot.checkRepos(bot.log);
  assert.deepEqual([...bot.publicRepos], [REPO]);
  assert.ok(logs.some((line) => line === `${OTHER}: ok (not public: handled only in DMs)`));
  github.repository = async () => {
    throw new Error('offline');
  };
  await bot.checkRepos();
  assert.deepEqual([...bot.publicRepos], []);
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

// The cached visibility is refreshed only every ten minutes. Group messages with repository
// details must not rely on a cached "public".
async function groupWithDraft(t) {
  const fixture = setup(t, { publicRepos: [REPO] });
  const g = privateGroup(fixture.bot);
  await g.say(alice, `${at(fixture.bot)} create an issue in ${REPO} about the login bug`);
  const draftEvent = g.replies().at(-1);
  assert.match(draftEvent.content, /^Draft AG-/);
  return { ...fixture, g, draftEvent, code: codeOf(draftEvent), ref: refOf(draftEvent) };
}
// Everything the group received after `from`, as text.
const since = (g, from) =>
  g
    .replies()
    .slice(from)
    .map((e) => e.content)
    .join('\n');

test('a public repository that becomes private is withheld from groups at once', async (t) => {
  const { bot, github, ollama, g, draftEvent, code, ref } = await groupWithDraft(t);
  await g.say(alice, `/confirm ${code}`);
  assert.match(g.replies().at(-1).content, /#1: https:\/\/github.com/);
  const before = g.replies().length;
  github.privateRepos.add(REPO); // made private on GitHub; the cache is not refreshed
  assert.ok(bot.publicRepos.has(REPO));

  await g.say(alice, `${at(bot)} create an issue in ${REPO} about a crash`);
  assert.match(g.replies().at(-1).content, /not public/);
  assert.equal(ollama.calls.length, 2, 'the cache let the model run once more');
  assert.equal(bot.publicRepos.has(REPO), false, 'the failed check updated the cache');
  await g.say(alice, `${at(bot)} create an issue in ${REPO} about another crash`);
  assert.equal(ollama.calls.length, 2, 'now refused before the model');
  for (const command of ['/issues', '/drafts', `/who ${ref}`])
    await g.say(alice, `${at(bot)} ${command}`);
  await g.say(alice, `/confirm ${code}`);
  await g.say(alice, 'yes', [replyTag(draftEvent.id)]);

  const text = since(g, before);
  assert.ok(!text.includes(REPO) && !text.includes('github.com') && !text.includes('Mobile login'));
  assert.equal(bot.drafts.all().length, 0, 'no hidden draft was created');
});

test('a failing visibility check counts as private', async (t) => {
  const { bot, github, g } = await groupWithDraft(t);
  const before = g.replies().length;
  github.repository = async () => {
    throw new Error('GitHub unavailable');
  };
  await g.say(alice, `${at(bot)} /drafts`);
  assert.match(g.replies().at(-1).content, /no drafts/);
  await g.say(alice, `${at(bot)} create an issue in ${REPO} about a crash`);
  assert.match(g.replies().at(-1).content, /not public/);
  assert.ok(!since(g, before).includes(REPO));
  assert.equal(bot.publicRepos.size, 0);
});

test('visibility is asked only for group messages with details of a cached public repository', async (t) => {
  const { bot, github } = setup(t, { publicRepos: [REPO] });
  const lookups = () => github.calls.filter((c) => c[0] === 'repository').length;
  await sendDM(bot, alice, `create an issue in ${OTHER} about a crash`);
  await sendDM(bot, alice, '/issues');
  assert.equal(lookups(), 0, 'DMs never ask');
  const g = privateGroup(bot);
  await g.say(alice, `${at(bot)} create an issue in ${OTHER} about a crash`);
  await g.say(alice, `${at(bot)} /help`);
  assert.equal(lookups(), 0, 'a cached "private" is trusted');
  await g.say(alice, `${at(bot)} create an issue in ${REPO} about a crash`);
  assert.equal(lookups(), 1, 'one fresh check before sending the draft');
});

test('a slow visibility check delays only its own conversation, which keeps its order', async (t) => {
  const { bot, github } = setup(t, { publicRepos: [REPO] });
  const room = publicGroup(bot);
  await room.say(alice, `${at(bot)} create an issue in ${REPO} about the login bug`);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const repository = github.repository;
  github.repository = async (repo) => {
    await gate;
    return repository(repo);
  };
  const before = room.replies().length;
  const post = (content) =>
    bot.publicMessage(
      sign(
        alice,
        9,
        [
          ['a', room.address],
          ['p', bot.pubkey],
        ],
        content,
        stamp(),
      ),
      room.address,
    );
  await post('/drafts'); // waits for GitHub
  await post('/help'); // same conversation: must wait behind /drafts
  // Another conversation is answered meanwhile.
  await bot.directMessage(dm(bob, '/help', bot), { tags: [] });
  await until(() => repliesFor(bot, bob).length === 1, 'DM answer while the group waits');
  assert.equal(room.replies().length, before);
  release();
  await settle(bot);
  const [drafts, help] = room.replies().slice(before);
  assert.match(drafts.content, /^Your drafts in this conversation:\n• .* lnbits\/anagram/);
  assert.match(help.content, /^I turn your requests/);
});

test('lanes exist only for authorized conversations; a full lane leaves messages unrecorded', async (t) => {
  const { bot } = setup(t);
  await sendDM(bot, mallory, '/help');
  assert.equal(bot.lanes.size, 0);
  await sendDM(bot, alice, '/help');
  assert.deepEqual([...bot.lanes.keys()], [`dm:${getPublicKey(alice)}`]);
  bot.lanes.get(`dm:${getPublicKey(alice)}`).limit = 0;
  const refused = await sendDM(bot, alice, '/drafts');
  assert.equal(bot.state.seen[refused.id], undefined, 'a relay can deliver it again later');
});
