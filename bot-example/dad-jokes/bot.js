import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  bytes,
  ConfigurationError,
  Network,
  newer,
  now,
  sign,
  State,
  unwrap,
  valid,
  single,
} from './runtime.js';
import { directMessage } from './direct-messages.js';
import { acceptTicket, privateMessage, readTicket } from './private-groups.js';
import { acceptRoom, joinPublic, parseRoom, publicMessage } from './public-groups.js';

export const DEFAULT_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const DEFAULT_PICTURE_URL =
  'https://npub1c878wu04lfqcl5avfy3p5x83ndpvedaxv0dg7pxthakq3jqdyzcs2n8avm.blossom.band/2b21dde65f33c3a05e5ef9147db2463cdac8698aad29a106770eab044dbe33db.png';
const DAY = 86400;
const HERE = fileURLToPath(new URL('.', import.meta.url));

export class DadBot {
  constructor({
    store,
    net,
    jokes,
    cooldown = 5,
    name = 'Dad Jokes (Example Anagram Bot)',
    log = console.log,
    onFatal = (error) => {
      throw error;
    },
  }) {
    this.name = name.trim() || 'Dad Jokes (Example Anagram Bot)';
    this.store = store;
    this.state = store.data;
    this.key = store.key;
    this.pubkey = getPublicKey(this.key);
    this.net = net;
    this.relays = net.configured;
    this.jokes = jokes;
    this.cooldown = cooldown;
    this.log = log;
    this.onFatal = onFatal;
    this.groupRelays = new Map();
    this.inboxes = new Map();
    this.watches = new Map();
    this.pending = new Set();
    this.work = Promise.resolve();
    this.stopped = false;
    this.started = false;
    // Corrupt persisted protocol state must not silently grant access or rotate identity.
    for (const [group, epoch] of Object.entries(this.state.groups)) {
      const { sig, ...message } = epoch.ticket ?? {};
      const parsed = readTicket(message, { tags: [['invitation_proof', sig]] }, this.pubkey);
      if (
        !parsed ||
        message.pubkey !== group ||
        parsed.pubkey !== epoch.pubkey ||
        parsed.epoch !== epoch.epoch
      )
        throw new Error('Invalid saved private group ticket. Restore state.json from backup.');
    }
    for (const [address, room] of Object.entries(this.state.rooms)) {
      if (parseRoom(room.event)?.address !== address)
        throw new Error('Invalid saved public group profile.');
    }
  }
  save() {
    this.store.save();
  }

  // Change this one function to turn the example into your own bot.
  reply(_message) {
    return this.jokes[randomInt(this.jokes.length)].joke;
  }

  shouldReply(message) {
    if (
      message.pubkey === this.pubkey ||
      ![9, 14].includes(message.kind) ||
      message.created_at < Math.max(this.state.startedAt, now() - DAY) ||
      message.created_at > now() + 60 ||
      this.state.seen[message.id] ||
      this.state.outbox.length >= 1000 ||
      message.tags.some((t) => t[0] === 'e' && t[3] === 'edit')
    )
      return false;
    // Never answer with an epoch key as an author, even in another conversation.
    if (Object.values(this.state.groups).some((g) => g.pubkey === message.pubkey)) return false;
    const last = this.state.lastReply?.[message.pubkey] ?? 0;
    if (now() - last < this.cooldown) {
      this.state.seen[message.id] = now();
      this.save();
      return false;
    }
    return true;
  }
  queue(message, deliveries) {
    // Persist the exact signed reply AND dedupe marker before publishing. A crash/retry
    // republishes identical event IDs instead of choosing a second joke.
    this.state.seen[message.id] = now();
    (this.state.lastReply ??= {})[message.pubkey] = now();
    this.state.outbox.push(...deliveries.map((delivery) => ({ ...delivery, queuedAt: now() })));
    this.save();
  }
  submit(id, action) {
    if (this.stopped || this.pending.has(id) || this.pending.size >= 2000) return;
    this.pending.add(id);
    this.work = this.work
      .then(async () => {
        if (!this.stopped) await action();
      })
      .catch((error) => {
        this.stopped = true;
        this.onFatal(error);
      })
      .finally(() => this.pending.delete(id));
  }
  receive(event, key, group) {
    this.submit(event.id, async () => {
      const opened = unwrap(event, key);
      if (!opened) return;
      if (group) await privateMessage(this, opened.message, group, getPublicKey(key));
      else await directMessage(this, opened.message, opened.seal);
    });
  }
  privateTicket(message, seal) {
    acceptTicket(this, message, seal);
  }
  async joinPublicLinks(content) {
    const links = [...content.matchAll(/naddr1[023456789acdefghjklmnpqrstuvwxyz]+/gi)].slice(0, 4);
    for (const [link] of links) {
      try {
        if (!(await joinPublic(this, link)))
          this.log('Public group link could not be resolved; resend it after checking relays.');
      } catch {
        this.log('Public group lookup failed; resend the link after checking relays.');
      }
    }
  }
  async inbox(pubkey) {
    const cached = this.inboxes.get(pubkey);
    if (cached && cached.at > now() - 300) return cached.relays;
    let latest;
    try {
      for (const event of await this.net.query(this.relays, {
        kinds: [10050],
        authors: [pubkey],
        limit: 10,
      })) {
        if (event.kind === 10050 && event.pubkey === pubkey && valid(event) && newer(event, latest))
          latest = event;
      }
    } catch {
      /* Configured relays remain usable when discovery fails. */
    }
    const hints = latest?.tags.filter((t) => t[0] === 'relay').map((t) => t[1]) ?? [];
    const relays = this.net.routes(hints);
    if (this.inboxes.size >= 1000) this.inboxes.delete(this.inboxes.keys().next().value);
    this.inboxes.set(pubkey, { at: now(), relays });
    return relays;
  }
  setWatch(name, relays, filter, handler, key = this.key) {
    if (!this.started || this.stopped) return;
    this.watches.get(name)?.();
    this.watches.set(name, this.net.watch(relays, filter, handler, key));
  }
  refreshPrivate(group) {
    this.watches.get(`private:${group}`)?.();
    const epoch = this.state.groups[group];
    if (!epoch || epoch.conflict || !this.started || this.stopped) return;
    const key = bytes(epoch.ticket.content);
    const watch = (relays) =>
      this.setWatch(
        `private:${group}`,
        relays,
        () => ({
          kinds: [1059],
          '#p': [epoch.pubkey],
          since: Math.max(this.state.startedAt, now() - DAY) - 2 * DAY - 60,
          limit: 1000,
        }),
        (event) => this.receive(event, key, group),
        key,
      );
    watch(this.groupRelays.get(group) ?? this.relays);
    void this.inbox(group)
      .then((relays) => {
        if (this.stopped || this.state.groups[group] !== epoch) return;
        this.groupRelays.set(group, relays);
        watch(relays);
      })
      .catch(() => this.log('Group relay discovery failed; using configured relays.'));
  }
  refreshPublic(address) {
    const room = parseRoom(this.state.rooms[address].event);
    if (!room) return;
    const owner = room.event.pubkey;
    const slug = single(room.event, 'd');
    this.setWatch(
      `profile:${address}`,
      room.relays,
      () => ({ kinds: [34550], authors: [owner], '#d': [slug], limit: 10 }),
      (event) => this.submit(event.id, () => acceptRoom(this, event)),
    );
    this.setWatch(
      `public:${address}`,
      room.relays,
      () => ({
        kinds: [9],
        '#a': [address],
        since: Math.max(this.state.startedAt, now() - DAY),
        limit: 1000,
      }),
      (event) => this.submit(event.id, () => publicMessage(this, event, address)),
    );
  }
  async start() {
    this.started = true;
    this.log(`${this.name}: ${nip19.npubEncode(this.pubkey)}`);
    this.setWatch(
      'inbox',
      this.relays,
      () => ({ kinds: [1059], '#p': [this.pubkey], limit: 1000 }),
      (event) => this.receive(event, this.key),
    );
    // "trusted" is not an indexed single-letter Nostr tag. Read bounded room metadata
    // on app relays and filter locally; a pasted naddr handles rooms outside this set.
    this.setWatch(
      'discovery',
      this.relays,
      () => ({ kinds: [34550], limit: 500 }),
      (event) => this.submit(event.id, () => acceptRoom(this, event)),
    );
    for (const group of Object.keys(this.state.groups)) this.refreshPrivate(group);
    for (const room of Object.keys(this.state.rooms)) this.refreshPublic(room);
    this.timer = setInterval(() => {
      void this.flush().catch(this.onFatal);
    }, 2000);
    this.discoveryTimer = setInterval(() => {
      for (const group of Object.keys(this.state.groups)) this.refreshPrivate(group);
    }, 5 * 60000);
    await this.flush();
  }
  async flush() {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      for (const item of this.state.outbox
        .filter((item) => !item.retryAt || item.retryAt <= now())
        .slice(0, 20)) {
        if (this.stopped) break;
        const epoch = item.group && this.state.groups[item.group];
        const room = item.room && this.state.rooms[item.room];
        const policy = room && parseRoom(room.event);
        const obsolete =
          item.queuedAt < now() - DAY ||
          (item.group && (!epoch || epoch.conflict || epoch.epoch !== item.epoch)) ||
          (item.room &&
            (!policy ||
              policy.blocked.includes(this.pubkey) ||
              (!room.explicit && !policy.trusted.includes(this.pubkey))));
        if (!obsolete) {
          try {
            await this.net.publish(
              item.event,
              policy?.relays ?? (item.group && this.groupRelays.get(item.group)) ?? item.relays,
              epoch ? bytes(epoch.ticket.content) : this.key,
            );
          } catch {
            item.attempts = (item.attempts ?? 0) + 1;
            item.retryAt = now() + Math.min(300, 2 ** Math.min(item.attempts, 9));
            this.save();
            continue;
          } // One ACK is enough. With zero ACKs the durable outbox retries.
        }
        this.state.outbox = this.state.outbox.filter((pending) => pending !== item);
        this.save();
      }
      // Incoming age checks use a 24h window; keep dedupe IDs longer than that window.
      let changed = false;
      for (const [id, time] of Object.entries(this.state.seen)) {
        if (time < now() - 2 * DAY) {
          delete this.state.seen[id];
          changed = true;
        }
      }
      for (const [key, time] of Object.entries(this.state.lastReply ?? {})) {
        if (time < now() - DAY) {
          delete this.state.lastReply[key];
          changed = true;
        }
      }
      if (changed) this.save();
      const queued = this.state.outbox.length;
      if (queued && now() - (this.lastWarning ?? 0) > 60) {
        this.log(`${queued} deliveries pending; relays will be retried.`);
        this.lastWarning = now();
      }
    } finally {
      this.flushing = false;
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.discoveryTimer);
    this.net.close();
    await this.work;
    // A publish finishing during shutdown still writes its result before releasing the lock.
    while (this.flushing) await new Promise((r) => setTimeout(r, 10));
    this.store.close();
  }
}

export async function publishProfile(bot, { pictureURL = DEFAULT_PICTURE_URL, nip05 = '' } = {}) {
  await bot.net.publish(
    sign(
      bot.key,
      10050,
      bot.relays.map((r) => ['relay', r]),
    ),
    bot.relays,
    bot.key,
  );
  const picture = pictureURL || DEFAULT_PICTURE_URL;
  if (new URL(picture).protocol !== 'https:') throw new Error('PICTURE_URL must use HTTPS.');
  await bot.net.publish(
    sign(
      bot.key,
      0,
      [],
      JSON.stringify({
        name: bot.name,
        display_name: bot.name,
        bot: true,
        ...(nip05.trim() ? { nip05: nip05.trim() } : {}),
        about: 'DM me for a dad joke, or mention me in an Anagram group.',
        picture,
      }),
    ),
    bot.relays,
    bot.key,
  );
}

export async function main() {
  process.umask(0o077);
  const store = new State(process.env.DATA_DIR || resolve(HERE, 'data'), {
    nsec: process.env.NSEC,
  });
  let bot;
  try {
    const net = new Network(
      (process.env.RELAYS || DEFAULT_RELAYS.join(','))
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    );
    const jokes = JSON.parse(readFileSync(resolve(HERE, 'dad-jokes-collection.json'), 'utf8'));
    if (
      !jokes.length ||
      jokes.some((j) => typeof j.joke !== 'string' || !j.joke.trim() || j.joke.length > 8000)
    )
      throw new Error('Invalid joke collection.');
    const cooldown = Number(process.env.COOLDOWN_SECONDS ?? 5);
    if (!Number.isFinite(cooldown) || cooldown < 0)
      throw new Error('COOLDOWN_SECONDS must be non-negative.');
    const fatal = () => {
      console.error(
        'Bot stopped after an internal/storage error. Check disk space and data permissions.',
      );
      process.exitCode = 1;
      void shutdown();
    };
    bot = new DadBot({ store, net, jokes, cooldown, name: process.env.NAME, onFatal: fatal });
    let profileTimer,
      publishing = false,
      closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      bot.stopped = true;
      clearInterval(profileTimer);
      while (publishing) await new Promise((r) => setTimeout(r, 50));
      await bot.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await bot.start();
    const profile = async () => {
      if (publishing || closing) return;
      publishing = true;
      try {
        await publishProfile(bot, {
          pictureURL: process.env.PICTURE_URL,
          nip05: process.env.NIP05,
        });
        console.log('Profile and DM inbox published.');
        clearInterval(profileTimer);
      } catch {
        console.error(
          'Profile/inbox publication pending. Check relays and PICTURE_URL; retrying in 60s.',
        );
      } finally {
        publishing = false;
      }
    };
    profileTimer = setInterval(profile, 60000);
    void profile();
    for (const link of (process.env.PUBLIC_GROUPS || '').split(',').filter(Boolean)) {
      bot.submit(`join:${link}`, async () => {
        try {
          if (!(await joinPublic(bot, link)))
            console.error('Configured public group not found; check the link and relays.');
        } catch {
          console.error('Configured public group lookup failed.');
        }
      });
    }
  } catch (error) {
    if (bot) await bot.close();
    else store.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : 'Cannot start Dad Jokes. Check configuration and state.json; existing keys are never replaced.',
    );
    process.exitCode = 1;
  });
}
