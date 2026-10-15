// Integration: real WebSocket relay, real HTTP to a mock Ollama and a mock GitHub API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { IssueAgent } from '../bot.js';
import { Access } from '../access.js';
import { Drafts } from '../drafts.js';
import { GitHubClient } from '../github.js';
import { OllamaClient } from '../ollama.js';
import { Network, now, sign, State, wrap } from '../runtime.js';
import { relay, until } from './relay.js';
import { chat, ollamaServer } from './ollama-server.js';
import { githubServer } from './github-server.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });
const REPO = 'lnbits/anagram';

test(
  'over real relay sockets and HTTP: DM, private and public groups, denial and restart',
  { timeout: 60000 },
  async (t) => {
    const local = await relay();
    const ollama = await ollamaServer((request, res) => {
      const last = request.body.messages.at(-1).content;
      const title = last.includes('Current draft:') ? 'Edited login bug' : 'Login bug on mobile';
      chat(
        res,
        JSON.stringify({ title, body: 'Login fails on the mobile app.', missing: ['App version'] }),
      );
    });
    const github = await githubServer();
    const dir = mkdtempSync(`${parent}relay-test-`);
    const user = generateSecretKey(),
      stranger = generateSecretKey(),
      owner = generateSecretKey();
    const userPubkey = getPublicKey(user),
      group = getPublicKey(owner);
    const address = `34550:${group}:public-room`;
    let bot, store;
    const start = async () => {
      store = new State(dir);
      bot = new IssueAgent({
        store,
        net: new Network([local.url]),
        ollama: new OllamaClient({ url: ollama.url, model: 'test-model', timeoutMs: 5000 }),
        github: new GitHubClient({ token: github.token, url: github.url, allowLocal: true }),
        access: new Access({
          users: [[userPubkey, [REPO]]],
          privateGroups: [group],
          publicGroups: [address],
        }),
        drafts: new Drafts(),
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
      await ollama.close();
      await github.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await start();
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
        })
        .sort((a, b) => a.created_at - b.created_at);
    let offset = 0;
    const sendDM = (key, content, tags = []) =>
      local.emit(
        wrapEvent(
          { kind: 14, tags: [['p', bot.pubkey], ...tags], content, created_at: now() + offset++ },
          key,
          bot.pubkey,
        ),
      );
    const code = (message) => /code ([0-9A-Z]{6})/.exec(message.content)[1];

    // DM: denied stranger, draft, edit by reply, confirm.
    sendDM(stranger, `create an issue in ${REPO} about login`);
    sendDM(user, `create an issue in ${REPO} about the mobile login bug`);
    await until(() => replies(user).length === 1, 'DM draft');
    const draft = replies(user)[0];
    assert.match(draft.content, /^Draft AG-.*\n\nTitle: Login bug on mobile/);
    assert.equal(replies(stranger).length, 0);
    assert.equal(ollama.requests.length, 1, 'the stranger never reached Ollama');
    sendDM(user, 'mention Android 15', [['e', draft.id, '', 'reply']]);
    await until(() => replies(user).length === 2, 'edited draft');
    const edited = replies(user)[1];
    assert.match(edited.content, /^Updated draft.*\n\nTitle: Edited login bug/);
    sendDM(user, `/confirm ${code(edited)}`);
    await until(() => replies(user).length === 3, 'published notice');
    assert.match(
      replies(user)[2].content,
      /^Published AG-.* as lnbits\/anagram#1: https:\/\/github.com/,
    );
    assert.equal(github.issues.length, 1);
    assert.equal(github.issues[0].title, 'Edited login bug');

    // Private group: invitation, then a mention.
    const epochKey = generateSecretKey();
    const groupTicket = (member) =>
      sign(
        owner,
        1014,
        [
          ['p', member],
          ['epoch', '0'],
        ],
        Buffer.from(epochKey).toString('hex'),
      );
    const { sig, ...invitation } = groupTicket(bot.pubkey);
    local.emit(wrap(invitation, owner, bot.pubkey, [['invitation_proof', sig]]));
    await until(() => store.data.groups[group]?.epoch === 0, 'private invitation');
    const proof = groupTicket(userPubkey);
    local.emit(
      wrapEvent(
        {
          kind: 14,
          created_at: now(),
          content: `nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey })} issue in ${REPO}: crash on start`,
          tags: [
            ['p', getPublicKey(epochKey)],
            ['h', group],
            ['epoch', '0'],
            ['invited_at', String(proof.created_at)],
            ['invitation_proof', proof.sig],
          ],
        },
        user,
        getPublicKey(epochKey),
      ),
    );
    await until(() => replies(epochKey).length === 1, 'private group draft');
    assert.match(replies(epochKey)[0].content, /^Draft AG-/);

    // Public group: joined through the Trusted tag, mention, draft.
    local.emit(
      sign(owner, 34550, [
        ['d', 'public-room'],
        ['name', 'Public room'],
        ['anagram-room', '1'],
        ['relay', local.url],
        ['trusted', bot.pubkey],
      ]),
    );
    await until(() => store.data.rooms[address], 'public join via trusted tag');
    const question = sign(
      user,
      9,
      [['a', address]],
      `${nip19.npubEncode(bot.pubkey)} issue in ${REPO}: typo`,
    );
    local.emit(question);
    const publicReplies = () =>
      [...local.events.values()].filter((e) => e.kind === 9 && e.pubkey === bot.pubkey);
    await until(() => publicReplies().length === 1, 'public draft');
    assert.equal(publicReplies()[0].tags.find((tag) => tag[0] === 'q')[1], question.id);

    // Restart: relays replay history, nothing is handled twice, nothing is published twice.
    await bot.close();
    await start();
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(replies(user).length, 3);
    assert.equal(replies(epochKey).length, 1);
    assert.equal(publicReplies().length, 1);
    assert.equal(github.issues.length, 1);
    assert.equal(ollama.requests.length, 4);
    // Drafts are memory-only; the published issue record survives.
    sendDM(user, '/issues');
    await until(() => replies(user).length === 4, 'issues after restart');
    assert.match(replies(user)[3].content, /AG-.* lnbits\/anagram#1/);
    assert.ok(github.requests.every((r) => !r.url.includes(github.token)));
  },
);
