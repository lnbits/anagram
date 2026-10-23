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
import { Access } from './access.js';
import { loadConfig } from './config.js';
import { buildMessages, Conversations, systemPrompt } from './conversations.js';
import {
  failureText,
  formatAnswer,
  helpText,
  parseCommand,
  shortId,
  stripMention,
} from './commands.js';
import { OllamaClient } from './ollama.js';
import { directMessage } from './direct-messages.js';
import { acceptTicket, privateMessage, readTicket } from './private-groups.js';
import { acceptRoom, joinPublic, parseRoom, publicMessage } from './public-groups.js';

const DAY = 86400;
const HOUR = 3600;
const HERE = fileURLToPath(new URL('.', import.meta.url));

// How a message moves through the bot:
//   relay event -> receive()/submit() -> protocol handler (direct-messages.js,
//   private-groups.js, public-groups.js) checks the Nostr rules -> handle() checks access,
//   commands and limits -> jobs queue -> generate() asks Ollama -> deliver() signs the
//   reply into the durable outbox -> flush() publishes it to relays.
export class OllamaBridge {
  constructor({
    store,
    net,
    ollama,
    access = new Access(),
    conversations = new Conversations(),
    limits = {},
    prompt = '',
    name = 'Ollama Bridge (Example Anagram Bot)',
    log = console.log,
    onFatal = (error) => {
      throw error;
    },
  }) {
    this.name = name;
    this.store = store;
    this.state = store.data;
    this.key = store.key;
    this.pubkey = getPublicKey(this.key);
    this.net = net;
    this.relays = net.configured;
    this.ollama = ollama;
    this.access = access;
    this.conversations = conversations;
    this.limits = {
      maxInputChars: 4000,
      maxOutputChars: 4000,
      requestsPerHour: 30,
      maxQueue: 10,
      ...limits,
    };
    this.prompt = prompt;
    this.log = log;
    this.onFatal = onFatal;
    this.groupRelays = new Map();
    this.inboxes = new Map();
    this.watches = new Map();
    this.pending = new Set();
    this.work = Promise.resolve();
    this.stopped = false;
    this.started = false;
    // Generation: one Ollama request at a time, a bounded waiting list, at most one
    // question per conversation in progress. Rate counters and notices live in memory.
    this.jobs = [];
    this.busy = new Set();
    this.generating = null;
    this.abort = new AbortController();
    this.requests = new Map();
    this.notices = new Map();
    this.logged = new Map();
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
    this.syncGrants();
  }

  // Access is never retroactive. Each allowed sender and group keeps the time it was first
  // allowed, so messages written before then stay unanswered even when relays resend them
  // after a restart. Already-allowed users keep their time, so messages they sent while the
  // bot was offline are still answered. Revoked entries lose their time; allowing them again
  // starts a new window.
  syncGrants() {
    this.runStartedAt = now();
    const grants = this.state.grants;
    const allowed = {
      sender: (id) => this.access.sender(id),
      private: (id) => this.access.privateGroup(id),
      public: (id) => this.access.publicGroup(id),
    };
    let changed = false;
    for (const key of Object.keys(grants)) {
      const split = key.indexOf(':');
      if (!allowed[key.slice(0, split)]?.(key.slice(split + 1))) {
        delete grants[key];
        changed = true;
      }
    }
    for (const [type, ids] of [
      ['sender', this.access.senders],
      ['private', this.access.privateGroups],
      ['public', this.access.publicGroups],
    ]) {
      for (const id of ids ?? []) {
        if (grants[`${type}:${id}`] !== undefined) continue;
        grants[`${type}:${id}`] = this.runStartedAt;
        changed = true;
      }
    }
    if (changed) this.save();
  }
  // Access allowed after startup (not from the configured lists) counts from this run's start.
  grantedAt(key) {
    if (this.state.grants[key] === undefined) {
      this.state.grants[key] = this.runStartedAt;
      this.save();
    }
    return this.state.grants[key];
  }
  allowedWhenSent(message, context) {
    if (message.created_at < this.grantedAt(`sender:${message.pubkey}`)) return false;
    // Group conversation ids are the group grant keys: private:<group>, public:<address>.
    return context.type === 'dm' || message.created_at >= this.grantedAt(context.conversation);
  }
  save() {
    this.store.save();
  }

  // Protocol-level filter shared by every chat type: replay, age, edits, own/epoch authors.
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
    return true;
  }

  // Called by the protocol handlers once a message is a valid, addressed chat message.
  // context: { type: 'dm' | 'private' | 'public', conversation, deliver(text) }
  async handle(message, context) {
    if (!this.shouldReply(message)) return;
    // Rejections are not saved as seen: the grant check gives the same answer on every
    // replay, and strangers cannot make the bot write to disk.
    if (!this.access.sender(message.pubkey)) return this.ignoredSender(message.pubkey);
    if (!this.allowedWhenSent(message, context)) return this.sentBeforeAccess(message.pubkey);
    // From here on the message is handled exactly once, even if it fails or a relay
    // resends it later. Persist that before doing anything slow.
    this.markSeen(message);
    const limit = this.rateLimit(message.pubkey);
    if (limit === 'notice')
      return context.deliver(
        'You have reached the hourly message limit for this bot. Please try again later.',
      );
    if (limit === 'silent') return;

    const text = stripMention(message.content, this.pubkey);
    const command = parseCommand(text);
    if (command || !text) return context.deliver(this.command(command ?? 'help', context));
    if ([...text].length > this.limits.maxInputChars)
      return context.deliver(
        `Your message is too long. Please keep it under ${this.limits.maxInputChars} characters.`,
      );
    if (this.busy.has(context.conversation))
      return context.deliver(
        'I am still answering the previous message in this conversation. Please wait for that answer, then try again.',
      );
    if (this.jobs.length >= this.limits.maxQueue)
      return context.deliver('The bot is busy right now. Please try again in a minute.');

    // Group histories are shared by everyone in the group, so label who said what.
    const prompt = context.type === 'dm' ? text : `[${shortId(message.pubkey)}] ${text}`;
    this.busy.add(context.conversation);
    this.jobs.push({ message, context, prompt });
    this.pump();
  }

  command(name, context) {
    if (name === 'reset') {
      this.conversations.reset(context.conversation);
      return context.type === 'dm'
        ? 'Done. I have forgotten our conversation.'
        : 'Done. I have forgotten this group’s conversation.';
    }
    if (name === 'model') return `Model: ${this.ollama.model}`;
    if (name === 'unknown') return `Unknown command.\n\n${helpText(this.ollama.model)}`;
    return helpText(this.ollama.model);
  }

  // Sliding one-hour window per sender. Bounds cost and any loop with another bot.
  // Over the limit the sender gets one notice per window, then silence.
  rateLimit(pubkey) {
    const recent = (this.requests.get(pubkey) ?? []).filter((t) => t > now() - HOUR);
    if (recent.length >= this.limits.requestsPerHour) {
      this.requests.set(pubkey, recent);
      if ((this.notices.get(pubkey) ?? 0) > now() - HOUR) return 'silent';
      this.notices.set(pubkey, now());
      return 'notice';
    }
    recent.push(now());
    this.requests.delete(pubkey);
    this.requests.set(pubkey, recent);
    if (this.requests.size > 1000) this.requests.delete(this.requests.keys().next().value);
    if (this.notices.size > 1000) this.notices.delete(this.notices.keys().next().value);
    return 'ok';
  }

  pump() {
    if (this.generating || this.stopped) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.generating = this.generate(job).finally(() => {
      this.generating = null;
      this.pump();
    });
  }

  // Asks Ollama, records the exchange, then queues the reply on the serialized work chain.
  // Never throws: every failure becomes a short, generic message for the user.
  async generate({ message, context, prompt }) {
    const started = Date.now();
    const { history, version } = this.conversations.snapshot(context.conversation);
    let text;
    try {
      const result = await this.ollama.chat(
        buildMessages(systemPrompt(this.prompt, context.type), history, prompt),
        { signal: this.abort.signal },
      );
      text = formatAnswer(result.text, this.limits.maxOutputChars, result.truncated);
      this.conversations.record(context.conversation, version, prompt, text);
      this.log(
        `Answered a ${context.type} message in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
      );
    } catch (error) {
      if (this.stopped) return;
      text = failureText(error, this.ollama.model);
      this.log(`Ollama request failed (${error?.code ?? 'internal error'}).`);
    } finally {
      this.busy.delete(context.conversation);
    }
    // Replies skip the relay-flood cap: they are already bounded by MAX_QUEUE, and the
    // question is marked as handled, so dropping the answer here would lose it.
    this.submit(`reply:${message.id}`, () => context.deliver(text), false);
  }

  markSeen(message) {
    this.state.seen[message.id] = now();
    this.save();
  }
  queue(message, deliveries) {
    // Persist the exact signed reply before publishing. A crash/retry republishes
    // identical event IDs instead of asking the model a second time.
    this.state.seen[message.id] = now();
    this.state.outbox.push(...deliveries.map((delivery) => ({ ...delivery, queuedAt: now() })));
    this.save();
  }

  // Logs show who to allow, never what they wrote. One line per key per hour.
  note(key, line) {
    if ((this.logged.get(key) ?? 0) > now() - HOUR) return;
    this.logged.delete(key);
    this.logged.set(key, now());
    if (this.logged.size > 1000) this.logged.delete(this.logged.keys().next().value);
    this.log(line);
  }
  ignoredSender(pubkey) {
    this.note(pubkey, `Ignored a message from ${nip19.npubEncode(pubkey)}: not in ALLOWED_NPUBS.`);
  }
  sentBeforeAccess(pubkey) {
    this.note(
      `early:${pubkey}`,
      `Ignored a message from ${nip19.npubEncode(pubkey)}: sent before access was granted.`,
    );
  }
  ignoredPrivateGroup(group) {
    this.note(
      group,
      `Ignored a private group invitation from ${nip19.npubEncode(group)}: not in ALLOWED_PRIVATE_GROUPS.`,
    );
  }
  ignoredPublicGroup(room) {
    const naddr = nip19.naddrEncode({
      kind: 34550,
      pubkey: room.event.pubkey,
      identifier: single(room.event, 'd'),
      relays: room.relays.slice(0, 3),
    });
    this.note(room.address, `Ignored public group ${naddr}: not in ALLOWED_PUBLIC_GROUPS.`);
  }

  submit(id, action, bounded = true) {
    if (this.stopped || this.pending.has(id) || (bounded && this.pending.size >= 2000)) return;
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
    if (!epoch || epoch.conflict || !this.access.privateGroup(group)) return;
    if (!this.started || this.stopped) return;
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
    if (!room || !this.access.publicGroup(address)) return;
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
    // Rooms where an owner marked the bot Trusted. acceptRoom() still requires the room
    // to be in ALLOWED_PUBLIC_GROUPS; this only notices rooms outside the startup lookup.
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
          (item.group &&
            (!epoch ||
              epoch.conflict ||
              epoch.epoch !== item.epoch ||
              !this.access.privateGroup(item.group))) ||
          (item.room &&
            (!policy ||
              !this.access.publicGroup(item.room) ||
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
    // Cancel the Ollama request in progress and forget waiting questions. They were
    // marked as handled; users resend after a restart (see README, "Restarts").
    this.jobs = [];
    this.abort.abort();
    await this.generating;
    this.net.close();
    await this.work;
    // A publish finishing during shutdown still writes its result before releasing the lock.
    while (this.flushing) await new Promise((r) => setTimeout(r, 10));
    this.store.close();
  }
}

export async function publishProfile(bot, { pictureURL = '', nip05 = '' } = {}) {
  await bot.net.publish(
    sign(
      bot.key,
      10050,
      bot.relays.map((r) => ['relay', r]),
    ),
    bot.relays,
    bot.key,
  );
  if (pictureURL && new URL(pictureURL).protocol !== 'https:')
    throw new Error('PICTURE_URL must use HTTPS.');
  await bot.net.publish(
    sign(
      bot.key,
      0,
      [],
      JSON.stringify({
        name: bot.name,
        display_name: bot.name,
        bot: true,
        ...(nip05 ? { nip05 } : {}),
        about:
          'A private AI assistant running on a local Ollama model. It only answers people its operator has allowed.',
        ...(pictureURL ? { picture: pictureURL } : {}),
      }),
    ),
    bot.relays,
    bot.key,
  );
}

// Checks the configured model once at startup so the operator sees problems early.
// Never fatal: Ollama may start after the bot, and users get a clear message meanwhile.
export async function checkModel(ollama, log) {
  try {
    if (await ollama.hasModel()) log(`Ollama is reachable; model ${ollama.model} is installed.`);
    else
      log(
        `Ollama is reachable, but model ${ollama.model} is missing. Run: ollama pull ${ollama.model}`,
      );
  } catch (error) {
    log(
      error?.code === 'timeout' || error?.code === 'unavailable'
        ? 'Ollama is not reachable yet. Start it with "ollama serve"; the bot keeps running.'
        : 'Ollama returned an unexpected response to the model check.',
    );
  }
}

export async function main() {
  process.umask(0o077);
  const config = loadConfig(process.env);
  const store = new State(config.dataDir || resolve(HERE, 'data'), { nsec: config.nsec });
  let bot;
  try {
    const net = new Network(config.relays);
    const ollama = new OllamaClient(config.ollama);
    const access = new Access({
      senders: config.access.senders,
      privateGroups: config.access.privateGroups,
      publicGroups: config.access.publicGroups.map((g) => g.address),
    });
    const fatal = () => {
      console.error(
        'Bot stopped after an internal/storage error. Check disk space and data permissions.',
      );
      process.exitCode = 1;
      void shutdown();
    };
    bot = new OllamaBridge({
      store,
      net,
      ollama,
      access,
      conversations: new Conversations(config.history),
      limits: config.limits,
      prompt: config.systemPrompt,
      name: config.name,
      onFatal: fatal,
    });
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
    if (!ollama.local)
      console.log('Warning: OLLAMA_URL is not on this computer. Use HTTPS or a private network.');
    if (!config.access.senders.length)
      console.log('Warning: ALLOWED_NPUBS is empty, so the bot will not answer anyone.');
    await bot.start();
    void checkModel(ollama, console.log);
    const profile = async () => {
      if (publishing || closing) return;
      publishing = true;
      try {
        await publishProfile(bot, { pictureURL: config.pictureURL, nip05: config.nip05 });
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
    for (const { link } of config.access.publicGroups) {
      bot.submit(`join:${link}`, async () => {
        try {
          if (!(await joinPublic(bot, link)))
            console.error('Allowed public group not found; check the link and relays.');
        } catch {
          console.error('Allowed public group lookup failed.');
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
        : 'Cannot start Ollama Bridge. Check configuration and state.json; existing keys are never replaced.',
    );
    process.exitCode = 1;
  });
}
