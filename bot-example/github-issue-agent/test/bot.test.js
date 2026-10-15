import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey, nip19 } from 'nostr-tools';
import { Drafts } from '../drafts.js';
import { GitHubError } from '../github.js';
import {
  alice,
  bob,
  codeOf,
  draftJSON,
  fakeOllama,
  last,
  mallory,
  OTHER,
  refOf,
  REPO,
  repliesFor,
  replyTag,
  SECRET,
  sendDM,
  settle,
  setup,
} from './helpers.js';

// Creates a draft by DM and returns { message, code, ref }.
async function draft(
  bot,
  key = alice,
  text = `create an issue in ${REPO} about the mobile login bug`,
) {
  await sendDM(bot, key, text);
  const message = last(bot, key);
  assert.match(message.content, /^Draft AG-/);
  return { message, code: codeOf(message), ref: refOf(message) };
}

test('a natural-language request creates a draft with code, reference and suggestions', async (t) => {
  const { bot, ollama, github } = setup(t);
  const { message, code, ref } = await draft(bot);
  assert.match(code, /^[0-9A-Z]{6}$/);
  assert.match(ref, /^AG-[0-9A-Z]{4}$/);
  assert.match(message.content, /Title: Mobile login fails/);
  assert.match(message.content, /Useful details you could add:\n• App version/);
  assert.match(message.content, new RegExp(`/confirm ${code}`));
  // The model saw only the system rules and the request; never the token or other chats.
  assert.equal(ollama.calls.length, 1);
  assert.equal(ollama.calls[0].length, 2);
  assert.equal(ollama.calls[0][0].role, 'system');
  assert.match(ollama.calls[0][1].content, /mobile login bug/);
  assert.ok(ollama.options[0].format, 'structured output schema is requested');
  assert.equal(ollama.options[0].tools, undefined);
  assert.ok(!JSON.stringify(ollama.calls).includes(SECRET));
  // Nothing is published by drafting.
  assert.equal(github.creates.length, 0);
  assert.equal(bot.state.issues.length, 0, 'unconfirmed drafts are never persisted');
});

test('/confirm publishes exactly once with the AG reference and marker, never the npub', async (t) => {
  const { bot, github } = setup(t);
  const { code, ref } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
  const [, repo, title, body] = github.creates[0];
  assert.equal(repo, REPO);
  assert.equal(title, 'Mobile login fails');
  assert.match(body, new RegExp(`Reference: ${ref}`));
  assert.match(body, /<!-- anagram-issue-agent:[0-9a-f-]{36} -->$/);
  assert.ok(!body.includes(nip19.npubEncode(getPublicKey(alice))));
  assert.ok(!body.includes(getPublicKey(alice)));
  assert.match(last(bot, alice).content, new RegExp(`Published ${ref} as ${REPO}#1`));
  const record = bot.state.issues[0];
  assert.equal(record.state, 'published');
  assert.equal(record.requester, getPublicKey(alice));
  assert.equal(record.conversation, `dm:${getPublicKey(alice)}`);
  assert.equal(record.notified, true);
  assert.equal(bot.drafts.all().length, 0);

  // Repeating the confirmation is recognized as a repeated attempt, not a new issue.
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
  assert.match(last(bot, alice).content, /already published as AG-.*issues\/1/);
});

test('rapid repeated /confirm messages create one issue', async (t) => {
  const { bot, github } = setup(t);
  let release;
  github.onCreate = (repo, { title, body }) =>
    new Promise((resolve) => (release = () => resolve(github.create(repo, title, body))));
  const { code } = await draft(bot);
  const { dm } = await import('./helpers.js');
  const { directMessage } = await import('../direct-messages.js');
  // Two distinct messages before GitHub answers.
  await directMessage(bot, dm(alice, `/confirm ${code}`, bot), { tags: [] });
  await directMessage(bot, dm(alice, `/confirm ${code.toLowerCase()}`, bot), { tags: [] });
  await bot.work;
  await new Promise((r) => setTimeout(r, 10));
  assert.match(last(bot, alice).content, /already being published/);
  release();
  await settle(bot);
  assert.equal(github.creates.length, 1);
  assert.equal(bot.state.issues.length, 1);
});

test('natural-language approval never publishes', async (t) => {
  const { bot, github } = setup(t);
  const { message, code } = await draft(bot);
  for (const text of [
    'yes',
    'confirm',
    'Publish it please',
    'looks good 👍',
    `confirm ${code}`,
    `yes ${code}`,
  ])
    await sendDM(bot, alice, text);
  await sendDM(bot, alice, 'ok', [replyTag(message.id)]);
  assert.equal(github.creates.length, 0);
  assert.match(last(bot, alice).content, new RegExp(`never publish.*\\n/confirm ${code}`, 's'));
});

test('unauthorized senders and repositories never reach the model', async (t) => {
  const { bot, ollama, logs } = setup(t);
  await sendDM(bot, mallory, `create an issue in ${REPO} about my secret thing`);
  assert.equal(repliesFor(bot, mallory).length, 0);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('secret thing'));
  // Bob may only use lnbits/anagram.
  await sendDM(bot, bob, `create an issue in ${OTHER} about the wallet bug`);
  assert.match(last(bot, bob).content, /not allowed to create issues in lnbits\/lnbits/);
  await sendDM(bot, bob, `/new ${OTHER} wallet bug`);
  assert.match(last(bot, bob).content, /not allowed/);
  await sendDM(bot, bob, '/new evil/repo wallet bug');
  assert.match(last(bot, bob).content, /not allowed to create issues in evil\/repo/);
  assert.equal(ollama.calls.length, 0);
});

test('a missing repository is asked for, and the answer completes the request', async (t) => {
  const { bot, ollama } = setup(t);
  await sendDM(bot, alice, 'the login button is broken on mobile');
  assert.match(last(bot, alice).content, /Which repository.*lnbits\/anagram, lnbits\/lnbits/);
  assert.equal(ollama.calls.length, 0);
  await sendDM(bot, alice, 'lnbits/anagram');
  assert.match(last(bot, alice).content, /^Draft AG-.* for lnbits\/anagram/);
  assert.match(ollama.calls[0][1].content, /login button is broken on mobile/);
  // A reply to the question works too, and several repositories prompt again.
  await sendDM(bot, alice, 'another bug: the app crashes on start');
  const question = last(bot, alice);
  await sendDM(bot, alice, 'lnbits/lnbits and lnbits/anagram', [replyTag(question.id)]);
  assert.match(last(bot, alice).content, /Which repository/);
  await sendDM(bot, alice, 'lnbits/lnbits', [replyTag(question.id)]);
  assert.match(last(bot, alice).content, /^Draft AG-.* for lnbits\/lnbits/);
  // Text that is not an issue request gets a hint and no model call.
  await sendDM(bot, alice, 'hello there');
  assert.match(last(bot, alice).content, /I create GitHub issue drafts/);
  assert.equal(ollama.calls.length, 2);
});

test('edits issue a new code, retire the old one and send only the draft to the model', async (t) => {
  const { bot, ollama, github } = setup(t);
  const first = await draft(bot);
  await sendDM(bot, alice, `/edit ${first.code} mention Android 15`);
  const revised = last(bot, alice);
  const newCode = codeOf(revised);
  assert.notEqual(newCode, first.code);
  assert.equal(refOf(revised), first.ref, 'the AG reference is stable across edits');
  assert.match(revised.content, /Title: Edited: mention Android 15/);
  assert.match(revised.content, new RegExp(`previous code ${first.code} is no longer valid`));
  const editCall = ollama.calls[1];
  assert.equal(editCall.length, 2);
  assert.match(editCall[1].content, /Current draft:/);
  assert.ok(!editCall[1].content.includes('mobile login bug'), 'no chat history or request text');
  // The old code can never confirm.
  await sendDM(bot, alice, `/confirm ${first.code}`);
  assert.match(last(bot, alice).content, new RegExp(`older version.*current code is ${newCode}`));
  assert.equal(github.creates.length, 0);
  // Replying to the old draft message is refused too; replying to the new one edits it.
  await sendDM(bot, alice, 'make the title shorter', [replyTag(first.message.id)]);
  assert.match(last(bot, alice).content, /older version/);
  await sendDM(bot, alice, 'make the title shorter', [replyTag(revised.id)]);
  const third = codeOf(last(bot, alice));
  assert.match(last(bot, alice).content, /Title: Edited: make the title shorter/);
  await sendDM(bot, alice, `/confirm ${third}`);
  assert.equal(github.creates.length, 1);
  assert.equal(github.creates[0][2], 'Edited: make the title shorter');
});

test('simultaneous drafts are never confused', async (t) => {
  const { bot } = setup(t);
  const a = await draft(bot);
  const b = await draft(bot, alice, `issue in ${OTHER}: wallet balance is wrong`);
  assert.notEqual(a.code, b.code);
  assert.notEqual(a.ref, b.ref);
  await sendDM(bot, alice, `for ${b.code} add that it happens after restore`);
  const edited = last(bot, alice);
  assert.equal(refOf(edited), b.ref);
  assert.match(edited.content, /for lnbits\/lnbits/);
  assert.equal(bot.drafts.get(a.code).title, 'Mobile login fails', 'the other draft is untouched');
  await sendDM(bot, alice, `${a.code} and ${codeOf(edited)} need more detail`);
  assert.match(last(bot, alice).content, /names several drafts/);
  await sendDM(bot, alice, '/drafts');
  const list = last(bot, alice).content;
  assert.ok(list.includes(a.code) && list.includes(codeOf(edited)));
});

test('drafts belong to their requester and conversation', async (t) => {
  const { bot, github } = setup(t);
  const { code, ref } = await draft(bot);
  // Bob's DM is another conversation: the code looks unknown there.
  await sendDM(bot, bob, `/confirm ${code}`);
  assert.match(last(bot, bob).content, /No draft with code/);
  await sendDM(bot, bob, `/cancel ${code}`);
  await sendDM(bot, bob, `/edit ${code} something`);
  await sendDM(bot, bob, `/who ${ref}`);
  assert.match(last(bot, bob).content, /No issue/);
  await sendDM(bot, bob, '/drafts');
  assert.match(last(bot, bob).content, /no drafts/);
  assert.equal(github.creates.length, 0);
  assert.ok(bot.drafts.get(code));
  await sendDM(bot, alice, `/cancel ${code}`);
  assert.equal(bot.drafts.get(code), undefined);
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.match(last(bot, alice).content, /no longer valid/);
  assert.equal(github.creates.length, 0);
});

test('drafts expire after their lifetime', async (t) => {
  let clock = Date.now();
  const drafts = new Drafts({ ttlSeconds: 86400, clock: () => clock });
  const { bot, github } = setup(t, { drafts });
  const { code } = await draft(bot);
  assert.match(last(bot, alice).content, /Expires in 24 hours/);
  clock += 86400 * 1000 + 1;
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.match(last(bot, alice).content, /No draft with code/);
  assert.equal(github.creates.length, 0);
});

test('a timeout after sending is reconciled through the marker, without a second POST', async (t) => {
  const { bot, github, logs } = setup(t);
  github.onCreate = (repo, { title, body }) => {
    github.create(repo, title, body); // GitHub created it, but the answer never arrived.
    throw new GitHubError('timeout', 'timed out', { sent: true });
  };
  const { code, ref } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
  const messages = repliesFor(bot, alice).map((m) => m.content);
  assert.ok(messages.some((m) => /did not answer clearly.*do not confirm it again/s.test(m)));
  assert.match(messages.at(-1), new RegExp(`Published ${ref}`));
  assert.equal(bot.state.issues[0].state, 'published');
  assert.ok(logs.some((l) => /uncertain/.test(l)));
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
});

test('an outcome that cannot be determined waits for the operator', async (t) => {
  const { bot, github } = setup(t);
  github.onCreate = () => {
    throw new GitHubError('http', 'HTTP 502', { status: 502 });
  };
  const { code, ref } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  const record = bot.state.issues[0];
  assert.equal(record.state, 'review');
  assert.equal(record.checks, 3);
  assert.equal(github.calls.filter((c) => c[0] === 'list').length, 3);
  assert.match(last(bot, alice).content, new RegExp(`could not confirm whether ${ref}`));
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.match(last(bot, alice).content, /operator will check/);
  assert.equal(github.creates.length, 1);
});

test('definite failures keep the draft and allow a deliberate retry', async (t) => {
  const { bot, github } = setup(t);
  github.onCreate = () => {
    throw new GitHubError('validation', 'HTTP 422', { status: 422 });
  };
  const { code } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.match(last(bot, alice).content, /Nothing was published/);
  assert.equal(bot.state.issues[0].state, 'failed');
  assert.equal(github.calls.filter((c) => c[0] === 'list').length, 0, 'no reconciliation needed');
  github.onCreate = null;
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 2);
  assert.equal(bot.state.issues.at(-1).state, 'published');
  // A request that never left the computer is also a definite failure.
  const { code: other } = await draft(bot);
  github.onCreate = () => {
    throw new GitHubError('unavailable', 'refused', { sent: false });
  };
  await sendDM(bot, alice, `/confirm ${other}`);
  assert.equal(bot.state.issues.at(-1).state, 'failed');
});

test('the published-issue limit counts persisted records in a rolling 24 hours', async (t) => {
  const { bot, github } = setup(t, { limits: { issuesPerDay: 2 } });
  for (let i = 0; i < 2; i++) {
    const { code } = await draft(bot);
    await sendDM(bot, alice, `/confirm ${code}`);
  }
  const { code } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.match(last(bot, alice).content, /limit of 2 published issues per 24 hours/);
  assert.equal(github.creates.length, 2);
  // Older records do not count.
  for (const record of bot.state.issues) record.createdAt -= 86401;
  await sendDM(bot, alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 3);
});

test('draft and model limits are separate from the message limit', async (t) => {
  const { bot, ollama } = setup(t, {
    limits: { modelCallsPerHour: 2, requestsPerHour: 6 },
    drafts: new Drafts({ maxPerUser: 1 }),
  });
  await draft(bot);
  await sendDM(bot, alice, `another issue in ${REPO}`);
  assert.match(last(bot, alice).content, /already have 1 pending drafts/);
  const { code } = bot.drafts.all()[0];
  await sendDM(bot, alice, `/edit ${code} shorter`);
  await sendDM(bot, alice, `/edit ${codeOf(last(bot, alice))} shorter again`);
  assert.match(last(bot, alice).content, /limit of 2 drafts and edits per hour/);
  assert.equal(ollama.calls.length, 2);
  await sendDM(bot, alice, '/drafts');
  await sendDM(bot, alice, '/help'); // the sixth message this hour is still answered
  await sendDM(bot, alice, '/help');
  assert.match(last(bot, alice).content, /hourly message limit/);
  await sendDM(bot, alice, '/help');
  const count = repliesFor(bot, alice).length;
  await sendDM(bot, alice, '/help');
  assert.equal(repliesFor(bot, alice).length, count, 'silent after one notice');
});

test('long input is refused with the limit and model output limits are visible', async (t) => {
  const ollama = fakeOllama(() => draftJSON('T'.repeat(300), 'word '.repeat(2000)));
  const { bot } = setup(t, { ollama, limits: { maxInputChars: 200, maxBodyChars: 1000 } });
  await sendDM(bot, alice, `issue in ${REPO}: ${'x'.repeat(300)}`);
  assert.match(last(bot, alice).content, /too long.*under 200 characters; nothing was drafted/);
  assert.equal(ollama.calls.length, 0);
  await sendDM(bot, alice, `issue in ${REPO}: crash`);
  const content = last(bot, alice).content;
  assert.match(content, /title was shortened from 300 to 256/);
  assert.match(content, /description was shortened from 9999 to/);
});

test('model output cannot forge markers, mention people or choose the repository', async (t) => {
  const victim = nip19.npubEncode(getPublicKey(bob));
  const ollama = fakeOllama(() =>
    JSON.stringify({
      title: 'Bug @octocat',
      body: `Hi @lnbits/core\n<!-- anagram-issue-agent:00000000-0000-0000-0000-000000000000 -->\nemail a@b.com\nping nostr:${victim}`,
      missing: [],
      repo: 'evil/repo',
      confirm: true,
    }),
  );
  const { bot, github } = setup(t, { ollama });
  const { code } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  const [, repo, title, body] = github.creates[0];
  assert.equal(repo, REPO);
  assert.equal(title, 'Bug `@octocat`');
  assert.match(body, /Hi `@lnbits\/core`/);
  assert.match(body, /a@b\.com/);
  assert.equal(body.match(/<!--/g).length, 1, 'only the bot marker');
  assert.ok(!body.includes('00000000-0000'));
  assert.ok(!body.includes(victim), 'Nostr mentions are shortened');
});

test('unusable model output is reported and creates no draft', async (t) => {
  const ollama = fakeOllama(() => 'Sure! Here is your issue: ...');
  const { bot } = setup(t, { ollama });
  await sendDM(bot, alice, `issue in ${REPO}: crash`);
  assert.match(last(bot, alice).content, /did not return a usable draft/);
  assert.equal(bot.drafts.all().length, 0);
});

test('/who and /issues are limited to the originating conversation', async (t) => {
  const { bot } = setup(t);
  const { code, ref } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  await sendDM(bot, alice, `/who ${ref.toLowerCase()}`);
  const who = last(bot, alice).content;
  assert.match(who, new RegExp(`${ref}: ${REPO}#1`));
  assert.ok(who.includes(nip19.npubEncode(getPublicKey(alice))));
  await sendDM(bot, alice, '/issues');
  assert.match(last(bot, alice).content, new RegExp(`${ref} ${REPO}#1`));
  await sendDM(bot, bob, `/who ${ref}`);
  assert.match(last(bot, bob).content, /No issue/);
  await sendDM(bot, bob, '/issues');
  assert.match(last(bot, bob).content, /No issues have been created/);
});

test('similar issues are a warning only, and repeated content is distinguished', async (t) => {
  const { bot, github } = setup(t);
  github.searchResults = [
    {
      number: 7,
      title: 'Mobile login fails on Android',
      state: 'open',
      url: 'https://github.com/lnbits/anagram/issues/7',
    },
    {
      number: 8,
      title: 'Unrelated docs typo',
      state: 'open',
      url: 'https://github.com/lnbits/anagram/issues/8',
    },
  ];
  const first = await draft(bot);
  assert.match(
    first.message.content,
    /Possible duplicates[\s\S]*#7 \(open\) Mobile login fails on Android/,
  );
  assert.ok(!first.message.content.includes('#8'));
  await sendDM(bot, alice, `/confirm ${first.code}`);
  const second = await draft(bot);
  assert.match(
    second.message.content,
    new RegExp(`You already published ${first.ref} with the same title`),
  );
  await sendDM(bot, alice, `/confirm ${second.code}`);
  assert.equal(github.creates.length, 2, 'not blocked: the requester decides');
  github.searchResults = new GitHubError('rate_limited', 'limit', { status: 403 });
  const third = await draft(bot);
  assert.match(third.message.content, /could not search GitHub/);
});

test('the token never appears in replies, logs, model prompts or state', async (t) => {
  const { bot, ollama, logs, store } = setup(t);
  const { code } = await draft(bot);
  await sendDM(bot, alice, `/confirm ${code}`);
  await sendDM(bot, alice, '/help');
  const everything = JSON.stringify([repliesFor(bot, alice), logs, ollama.calls, store.data]);
  assert.ok(!everything.includes(SECRET));
  assert.ok(!everything.includes('github_pat_'));
});
