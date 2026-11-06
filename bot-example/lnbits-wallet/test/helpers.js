// Shared fixtures for the bot tests: a fake relay network, linked people and DM helpers.
import './no-network.js';
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import { WalletBot } from '../bot.js';
import { Wallets } from '../wallets.js';
import { now, sign, State } from '../vendor/runtime.js';
import { defer, tempDir } from './tmp.js';

export { defer, tempDir };

// Synthetic LNbits invoice keys. Tests assert they never appear in logs, replies or state.
export const ALICE_KEY = 'a11ce000000000000000000000000001';
export const BOB_KEY = 'b0b00000000000000000000000000002';

export const alice = generateSecretKey(),
  bob = generateSecretKey(),
  mallory = generateSecretKey();
export const npub = (key) => nip19.npubEncode(getPublicKey(key));

export const linked = () =>
  new Wallets([
    [npub(alice), { label: 'Alice test wallet', invoiceKey: ALICE_KEY }],
    [npub(bob), { label: 'Bob test wallet', invoiceKey: BOB_KEY }],
  ]);

// Relay stand-in: records published events, never fails unless told to.
export function fakeNet() {
  const net = {
    configured: ['wss://relay.example/'],
    sent: [],
    fail: false,
    routes(hints = []) {
      return [...this.configured, ...hints];
    },
    query: async () => [],
    async publish(event) {
      if (net.fail) throw new Error('relay down');
      net.sent.push(event);
    },
    close() {},
    watch() {
      return () => {};
    },
  };
  return net;
}

export function setup(t, { wallets = linked(), limits = {}, dir, net = fakeNet(), ...rest } = {}) {
  // A caller that passes its own directory owns it (restart tests reuse it).
  dir ??= tempDir(t, 'bot');
  const store = new State(dir);
  const logs = [];
  const bot = new WalletBot({
    store,
    net,
    wallets,
    limits,
    log: (line) => logs.push(line),
    ...rest,
  });
  defer(t, async () => {
    if (!bot.stopped) await bot.close();
    else store.close();
  });
  return { bot, store, net, logs, dir };
}

// Waits until every lane, reply and message-chain action has finished.
export async function settle(bot) {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 2));
    await bot.work;
    await Promise.all(bot.replying);
    if (
      [...bot.lanes.values()].every((lane) => !lane.current && !lane.jobs.length) &&
      !bot.pending.size &&
      !bot.replying.size
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
  await bot.directMessage(message, { tags: [] });
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
