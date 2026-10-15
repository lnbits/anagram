// Crash and restart recovery. A "crash" is simulated by writing the state a crashed process
// leaves on disk, then starting a fresh bot on the same data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getPublicKey } from 'nostr-tools';
import { issueBody } from '../drafting.js';
import { review } from '../review.js';
import { IssueAgent } from '../bot.js';
import { State } from '../runtime.js';
import {
  alice,
  codeOf,
  fakeGitHub,
  last,
  parent,
  REPO,
  repliesFor,
  sendDM,
  settle,
  setup,
} from './helpers.js';

function tempDir(t) {
  const dir = mkdtempSync(`${parent}restart-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The record a process leaves behind if it dies at a given point of publish().
function crashedRecord({ sending, attempt = randomUUID() }) {
  return {
    ref: 'AG-7K92',
    code: 'K3P9QX',
    attempt,
    requester: getPublicKey(alice),
    conversation: `dm:${getPublicKey(alice)}`,
    repo: REPO,
    title: 'Mobile login fails',
    messageId: 'a'.repeat(64),
    state: 'publishing',
    sending,
    createdAt: Math.floor(Date.now() / 1000) - 30,
    updatedAt: Math.floor(Date.now() / 1000) - 30,
    notified: true,
    checks: 0,
  };
}
function writeState(dir, records) {
  const store = new State(dir);
  store.data.issues = records;
  store.save();
  store.close();
}

test('crash after sending, issue created: restart finds the marker and does not POST again', async (t) => {
  const dir = tempDir(t);
  const record = crashedRecord({ sending: true });
  writeState(dir, [record]);
  const github = fakeGitHub();
  github.create(REPO, record.title, issueBody({ body: 'x' }, record.ref, record.attempt));
  const { bot } = setup(t, { dir, github });
  await bot.start();
  await settle(bot);
  assert.equal(github.creates.length, 0);
  assert.equal(bot.state.issues[0].state, 'published');
  assert.equal(bot.state.issues[0].number, 1);
  assert.match(last(bot, alice).content, /Published AG-7K92 as lnbits\/anagram#1/);
  assert.equal(bot.state.issues[0].notified, true);
});

test('crash after sending, issue not found: restart leaves it for the operator', async (t) => {
  const dir = tempDir(t);
  writeState(dir, [crashedRecord({ sending: true })]);
  const { bot, github } = setup(t, { dir });
  await bot.start();
  await settle(bot);
  assert.equal(github.creates.length, 0);
  assert.equal(bot.state.issues[0].state, 'review');
  assert.match(last(bot, alice).content, /could not confirm whether AG-7K92 was created/);
});

test('crash before sending: nothing can exist, so it is failed without asking GitHub', async (t) => {
  const dir = tempDir(t);
  writeState(dir, [crashedRecord({ sending: false })]);
  const { bot, github } = setup(t, { dir });
  await bot.start();
  await settle(bot);
  assert.equal(github.calls.length, 0);
  assert.equal(bot.state.issues[0].state, 'failed');
  assert.match(last(bot, alice).content, /was not published.*bot restarted/);
});

test('the operator resolves a review and the requester is told at the next start', async (t) => {
  const dir = tempDir(t);
  writeState(dir, [{ ...crashedRecord({ sending: true }), state: 'review', checks: 3 }]);
  const store = new State(dir);
  const lines = [];
  review(store.data, [], (line) => lines.push(line));
  assert.match(lines[0], /AG-7K92 {2}review/);
  assert.throws(() =>
    review(store.data, ['published', 'AG-7K92', 'https://github.com/evil/x/issues/1']),
  );
  review(store.data, ['published', 'ag-7k92', `https://github.com/${REPO}/issues/42`], () => {});
  store.save();
  store.close();
  const { bot } = setup(t, { dir });
  await bot.start();
  await settle(bot);
  assert.match(last(bot, alice).content, /Published AG-7K92 as lnbits\/anagram#42/);
  await sendDM(bot, alice, '/issues');
  assert.match(last(bot, alice).content, /AG-7K92 lnbits\/anagram#42/);
});

test('shutdown during a POST waits for the outcome and delivers the notice after restart', async (t) => {
  const dir = tempDir(t);
  const github = fakeGitHub();
  let release;
  github.onCreate = (repo, { title, body }) =>
    new Promise((resolve) => (release = () => resolve(github.create(repo, title, body))));
  const first = setup(t, { dir, github });
  await sendDM(first.bot, alice, `issue in ${REPO}: crash on start`);
  const code = codeOf(last(first.bot, alice));
  const { dm } = await import('./helpers.js');
  const { directMessage } = await import('../direct-messages.js');
  await directMessage(first.bot, dm(alice, `/confirm ${code}`, first.bot), { tags: [] });
  await new Promise((r) => setTimeout(r, 20));
  const closing = first.bot.close();
  release();
  await closing;
  const saved = JSON.parse((await import('node:fs')).readFileSync(`${dir}/state.json`, 'utf8'))
    .issues[0];
  assert.equal(saved.state, 'published');
  assert.equal(saved.notified, false, 'the notice could not be sent during shutdown');
  const second = setup(t, { dir, github });
  await second.bot.start();
  await settle(second.bot);
  assert.match(last(second.bot, alice).content, /Published AG-.* as lnbits\/anagram#1/);
  assert.equal(github.creates.length, 1);
  // Relays resend the old /confirm after the restart; it is not handled again.
  await directMessage(second.bot, dm(alice, `/confirm ${code}`, second.bot), { tags: [] });
  await settle(second.bot);
  assert.equal(github.creates.length, 1);
  // Unconfirmed drafts are not persisted, the published record is, and the file is private.
  assert.equal(second.bot.drafts.all().length, 0);
  assert.equal(statSync(`${dir}/state.json`).mode & 0o777, 0o600);
});

test('the daily limit survives a restart', async (t) => {
  const dir = tempDir(t);
  const first = setup(t, { dir, limits: { issuesPerDay: 1 } });
  await sendDM(first.bot, alice, `issue in ${REPO}: crash on start`);
  await sendDM(first.bot, alice, `/confirm ${codeOf(last(first.bot, alice))}`);
  await first.bot.close();
  const second = setup(t, { dir, limits: { issuesPerDay: 1 } });
  await sendDM(second.bot, alice, `issue in ${REPO}: another crash`);
  await sendDM(second.bot, alice, `/confirm ${codeOf(last(second.bot, alice))}`);
  assert.match(last(second.bot, alice).content, /limit of 1 published issues/);
  assert.equal(second.github.creates.length, 0);
  assert.equal(repliesFor(second.bot, alice).length > 0, true);
});

test('corrupt issue records stop startup instead of being ignored', async (t) => {
  const dir = tempDir(t);
  writeState(dir, [{ ...crashedRecord({ sending: true }), requester: 'not-a-key' }]);
  const store = new State(dir);
  try {
    assert.throws(
      () => new IssueAgent({ store, net: { configured: [] }, ollama: {}, github: {} }),
      /Invalid issue records/,
    );
  } finally {
    store.close(); // main() does the same when the constructor throws.
  }
});
