// Shared fixtures for the bot tests: fake relays, a fake model and a fake GitHub API.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import { IssueAgent } from '../bot.js';
import { Access } from '../access.js';
import { Drafts } from '../drafts.js';
import { directMessage } from '../direct-messages.js';
import { acceptTicket, privateMessage } from '../private-groups.js';
import { acceptRoom, publicMessage } from '../public-groups.js';
import { GitHubError } from '../github.js';
import { now, sign, State } from '../runtime.js';

export const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

export const REPO = 'lnbits/anagram';
export const OTHER = 'lnbits/lnbits';
export const SECRET = 'github_pat_SECRET_TEST_TOKEN_never_shown_anywhere';

export const draftJSON = (title, body = `${title}. Details from the request.`, missing = []) =>
  JSON.stringify({ title, body, missing });

// Model stand-in. answer(messages) returns the raw model text; calls are recorded.
export function fakeOllama(
  answer = (messages) => {
    const last = messages.at(-1).content;
    if (last.includes('Current draft:')) {
      const instructions = last.split('<<<').at(-1).split('>>>')[0].trim();
      return draftJSON(`Edited: ${instructions}`.slice(0, 80), `Edited body. ${instructions}`);
    }
    return draftJSON('Mobile login fails', 'Login does not work on the mobile app.', [
      'App version',
    ]);
  },
) {
  const ollama = {
    model: 'test-model',
    calls: [],
    options: [],
    answer,
    async chat(messages, options = {}) {
      ollama.calls.push(messages);
      ollama.options.push(options);
      return { text: await ollama.answer(messages, options.signal), truncated: false };
    },
  };
  return ollama;
}

// GitHub stand-in with the same methods as GitHubClient. onCreate may throw GitHubErrors.
export function fakeGitHub() {
  const github = {
    issues: [],
    calls: [],
    searchResults: null,
    onCreate: null,
    create(repo, title, body) {
      const number = github.issues.length + 1;
      const issue = {
        repo,
        number,
        title,
        body,
        url: `https://github.com/${repo}/issues/${number}`,
      };
      github.issues.push(issue);
      return { number, url: issue.url };
    },
    async user() {
      github.calls.push(['user']);
      return { login: 'issue-bot' };
    },
    async repository(repo) {
      return { fullName: repo, hasIssues: true, archived: false };
    },
    async searchIssues(repo, title) {
      github.calls.push(['search', repo, title]);
      if (github.searchResults instanceof Error) throw github.searchResults;
      return github.searchResults ?? [];
    },
    async createIssue(repo, { title, body }) {
      github.calls.push(['create', repo, title, body]);
      if (github.onCreate) return github.onCreate(repo, { title, body });
      return github.create(repo, title, body);
    },
    async recentIssues(repo) {
      github.calls.push(['list', repo]);
      return {
        issues: github.issues.filter((i) => i.repo === repo).map((i) => ({ ...i })),
        complete: true,
      };
    },
    get creates() {
      return github.calls.filter((c) => c[0] === 'create');
    },
  };
  return github;
}
export const timeoutAfterSending = () => new GitHubError('timeout', 'timed out', { sent: true });

export const alice = generateSecretKey(),
  bob = generateSecretKey(),
  mallory = generateSecretKey();
export const npub = (key) => nip19.npubEncode(getPublicKey(key));

export function setup(
  t,
  {
    users,
    groups = {},
    limits = {},
    drafts,
    dir,
    github = fakeGitHub(),
    ollama = fakeOllama(),
    reconcileDelays = [0, 0, 0],
  } = {},
) {
  // A caller that passes its own directory owns it (restart tests reuse it).
  const owned = !dir;
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
  const bot = new IssueAgent({
    store,
    net,
    ollama,
    github,
    access: new Access({
      users: users ?? [
        [getPublicKey(alice), [REPO, OTHER]],
        [getPublicKey(bob), [REPO]],
      ],
      ...groups,
    }),
    drafts: drafts ?? new Drafts(),
    limits,
    reconcileDelays,
    log: (line) => logs.push(line),
  });
  t.after(async () => {
    if (!bot.stopped) await bot.close();
    if (owned) rmSync(dir, { recursive: true, force: true });
  });
  return { bot, store, net, sent, logs, ollama, github, dir };
}

// Waits until every queue, timer and message-chain action has finished.
export async function settle(bot) {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 2));
    await bot.work;
    if (
      !bot.timers.size &&
      !bot.models.current &&
      !bot.models.jobs.length &&
      !bot.publisher.current &&
      !bot.publisher.jobs.length &&
      !bot.pending.size
    )
      return;
  }
  throw new Error('bot did not settle');
}

let tick = 0;
// Distinct (slightly future, still accepted) timestamps keep message ids unique even when
// a test sends the same text twice, like a person repeating a command.
export const stamp = () => now() + (tick++ % 50);
export function rumor(key, tags, content, created_at = stamp()) {
  const event = { kind: 14, pubkey: getPublicKey(key), created_at, tags, content };
  return { ...event, id: getEventHash(event) };
}
export const dm = (sender, content, bot, tags = [], time = undefined) =>
  rumor(sender, [['p', bot.pubkey], ...tags], content, time);
export async function sendDM(bot, sender, content, tags = [], time = undefined) {
  const message = dm(sender, content, bot, tags, time);
  await directMessage(bot, message, { tags: [] });
  await settle(bot);
  return message;
}
export const replyTag = (id) => ['e', id, '', 'reply'];

// Messages the bot queued for a recipient key, decrypted, oldest first.
export function repliesFor(bot, key) {
  return bot.state.outbox.flatMap((item) => {
    try {
      const message = unwrapEvent(item.event, key);
      return message.pubkey === bot.pubkey ? [message] : [];
    } catch {
      return [];
    }
  });
}
export const last = (bot, key) => repliesFor(bot, key).at(-1);
export const codeOf = (message) => /code ([0-9A-Z]{6})/.exec(message.content)?.[1];
export const refOf = (message) => /(AG-[0-9A-Z]{4})/.exec(message.content)?.[1];

export function ticket(group, member, epochKey, epoch = 0, time = now()) {
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

// A private group the bot has joined. say() delivers a member's message to the bot.
// allow: add the group to the bot's allowlist first (the operator's ALLOWED_PRIVATE_GROUPS).
export function privateGroup(bot, { allow = true, owner = generateSecretKey() } = {}) {
  const epochKey = generateSecretKey();
  const invite = ticket(owner, bot.pubkey, epochKey);
  const group = getPublicKey(owner);
  if (allow) {
    bot.access.privateGroups.add(group);
    bot.authorize();
  }
  acceptTicket(bot, invite.message, invite.seal);
  const say = async (sender, content, tags = [], time = undefined) => {
    const senderTicket = ticket(owner, getPublicKey(sender), epochKey, 0);
    const message = rumor(
      sender,
      [
        ['p', getPublicKey(epochKey)],
        ['h', group],
        ['epoch', '0'],
        ['invited_at', String(senderTicket.message.created_at)],
        ['invitation_proof', senderTicket.signed.sig],
        ...tags,
      ],
      content,
      time,
    );
    await privateMessage(bot, message, group, getPublicKey(epochKey));
    await settle(bot);
    return message;
  };
  const replies = () => repliesFor(bot, epochKey);
  return { owner, group, epochKey, say, replies };
}

// A public group the bot has joined. say() delivers a signed kind:9 message.
export function publicGroup(
  bot,
  { allow = true, owner = generateSecretKey(), slug = 'issues-room' } = {},
) {
  const event = sign(owner, 34550, [
    ['d', slug],
    ['name', 'Issues room'],
    ['anagram-room', '1'],
    ['relay', 'wss://relay.example/'],
    ['trusted', bot.pubkey],
  ]);
  const address = `34550:${getPublicKey(owner)}:${slug}`;
  if (allow) {
    bot.access.publicGroups.add(address);
    bot.authorize();
  }
  acceptRoom(bot, event, true);
  const say = async (sender, content, tags = [], time = stamp()) => {
    const message = sign(sender, 9, [['a', address], ...tags], content, time);
    await publicMessage(bot, message, address);
    await settle(bot);
    return message;
  };
  const replies = () => bot.state.outbox.filter((i) => i.room === address).map((i) => i.event);
  return { owner, address, say, replies };
}
export const at = (bot) => `nostr:${nip19.npubEncode(bot.pubkey)}`;
