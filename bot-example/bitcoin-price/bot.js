import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import {
  bytes,
  ConfigurationError,
  Network,
  newer,
  now,
  rumor,
  sign,
  State,
  unwrap,
  valid,
  single,
  wrap,
} from './runtime.js';
import { directMessage } from './direct-messages.js';
import { acceptTicket, authorized, privateMessage, readTicket } from './private-groups.js';
import { acceptRoom, joinPublic, parseRoom, publicMessage } from './public-groups.js';
import { buttonCurrency, priceReply, REFRESH, UNAVAILABLE } from './commands.js';
import { DEFAULT_PRICE_URL, defaultCurrency, parseCacheSeconds, PriceFeed } from './price.js';
import {
  BOT_CONTROL_KIND,
  COMMAND_TAG,
  controlTag,
  hasCallback,
  keyboardTag,
  parseControl,
  targetKey,
} from './botKeyboardProtocol.ts';

export const DEFAULT_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const DEFAULT_NAME = 'Bitcoin Price (Example Anagram Bot)';
const DAY = 86400;
const HERE = fileURLToPath(new URL('.', import.meta.url));
// Replies with buttons (cards) are remembered so that presses can be checked against them.
const KEEP_CARDS = 7 * DAY;
const MAX_CARDS = 1000;
const USERS_PER_CARD = 1000;
const VIEWS_PER_USER = 8;
const MAX_CALLBACKS = 2000;

export class PriceBot {
  constructor({
    store,
    net,
    feed,
    defaultCurrency = 'USD',
    cooldown = 5,
    name = DEFAULT_NAME,
    log = console.log,
    onFatal = (error) => {
      throw error;
    },
  }) {
    this.name = name.trim() || DEFAULT_NAME;
    this.store = store;
    this.state = store.data;
    this.key = store.key;
    this.pubkey = getPublicKey(this.key);
    this.net = net;
    this.relays = net.configured;
    this.feed = feed;
    this.defaultCurrency = defaultCurrency;
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
    // state.cards[id] = { target, recipient?, keyboard, currency, at,
    //                     views: { [pubkey]: [{ id: answer id, currency }] } }
    // state.callbacks[`${pubkey}:${requestId}`] = { fingerprint, expires, delivery }
    this.state.cards ??= {};
    this.state.callbacks ??= {};
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

  // Change this one function to turn the example into your own bot. It is async, returns
  // { text, keyboard } (keyboard may be null) or null (no reply), and must not throw: a
  // thrown error here would stop the bot.
  async reply(message) {
    try {
      // Replies carry an `e` reply tag (kind 14) or a `q` quote tag (kind 9). Other bots,
      // including this one, always reply that way, so never answer those with help.
      const isReply = message.tags.some((t) => (t[0] === 'e' && t[3] === 'reply') || t[0] === 'q');
      return await priceReply(message.content, this.feed, this.defaultCurrency, {
        help: !isReply,
      });
    } catch {
      this.log('Price reply failed unexpectedly.');
      return { text: UNAVAILABLE, keyboard: null };
    }
  }
  // Extra tags for a reply with buttons: the keyboard, and a marker that lets Anagram
  // collapse the command the price answers (docs/bot-keyboards.md in the Anagram repository).
  cardTags(response, command) {
    if (!response.keyboard) return [];
    const tags = [keyboardTag(response.keyboard)];
    if (response.priced) tags.push([COMMAND_TAG, '1', command.id]);
    return tags;
  }
  // Remembers a reply with buttons, so a press can be checked against the card it is on.
  remember({ root, type, chat, recipient, keyboard, currency }) {
    const cards = this.state.cards;
    for (const [id, card] of Object.entries(cards))
      if (card.at < now() - KEEP_CARDS) delete cards[id];
    const ids = Object.keys(cards);
    if (ids.length >= MAX_CARDS)
      delete cards[ids.reduce((a, b) => (cards[a].at <= cards[b].at ? a : b))];
    cards[root] = {
      target: { type, chat, root, version: root, bot: this.pubkey },
      ...(recipient ? { recipient } : {}),
      keyboard,
      currency: currency ?? this.defaultCurrency,
      at: now(),
      views: {},
    };
  }

  // A button press: an encrypted kind 21118 request in the bot's own inbox. The answer is
  // personal (only the person who pressed sees it, in place of the card's text), so the
  // same card keeps working for everyone in a group. Checks follow the protocol document:
  // author, conversation, card version, expiry, group membership and that the button is
  // really on that card or on the bot's own answer there. Nothing in the request data is
  // trusted beyond naming one of the card's buttons.
  async callback(message) {
    const request = parseControl(message.tags),
      time = now();
    if (
      request?.op !== 'request' ||
      single(message, 'p') !== this.pubkey ||
      message.pubkey === this.pubkey ||
      message.content !== '' ||
      request.target.bot !== this.pubkey ||
      request.expires <= time ||
      request.expires > message.created_at + 300 ||
      message.created_at > time + 60 ||
      message.created_at < time - 300 ||
      this.state.outbox.length >= 1000 ||
      Object.values(this.state.groups).some((g) => g.pubkey === message.pubkey)
    )
      return;
    const card = this.state.cards[request.target.root];
    if (!card || targetKey(card.target) !== targetKey(request.target)) return;
    let membership;
    if (card.target.type === 'dm' && card.recipient !== message.pubkey) return;
    if (card.target.type === 'public') {
      const saved = this.state.rooms[card.target.chat];
      const room = saved && parseRoom(saved.event);
      if (
        !room ||
        room.blocked.includes(message.pubkey) ||
        room.blocked.includes(this.pubkey) ||
        (room.event.pubkey !== this.pubkey && !room.trusted.includes(this.pubkey))
      )
        return;
    }
    if (card.target.type === 'private') {
      const epoch = this.state.groups[card.target.chat],
        proof = request.membership;
      if (
        !epoch ||
        epoch.conflict ||
        !proof ||
        proof.epoch !== epoch.epoch ||
        !authorized(
          {
            ...message,
            kind: 14,
            tags: [
              ['p', epoch.pubkey],
              ['h', card.target.chat],
              ['epoch', String(proof.epoch)],
              ['invited_at', String(proof.invited_at)],
              ['invitation_proof', proof.invitation_proof],
            ],
          },
          card.target.chat,
          epoch,
        )
      )
        return;
      membership = {
        epoch: epoch.epoch,
        invited_at: epoch.ticket.created_at,
        invitation_proof: epoch.ticket.sig,
      };
    }
    // A retried request gets the exact stored answer; a reused id with other contents gets
    // nothing. Anagram retries for five minutes, then starts a new request.
    for (const [id, value] of Object.entries(this.state.callbacks))
      if (value.expires < time - 300) delete this.state.callbacks[id];
    const cacheKey = `${message.pubkey}:${request.id}`;
    const cached = this.state.callbacks[cacheKey];
    if (cached) {
      if (cached.fingerprint !== message.id) return;
      if (!this.state.outbox.some((item) => item.event.id === cached.delivery.event.id)) {
        this.state.outbox.push({ ...cached.delivery, queuedAt: time });
        this.save();
      }
      return;
    }
    if (Object.keys(this.state.callbacks).length >= MAX_CALLBACKS) return;
    const views = card.views[message.pubkey];
    if (!views && Object.keys(card.views).length >= USERS_PER_CARD) return;
    // Every answer carries the card's keyboard again, so a press from a personal view is
    // valid only if that view is one of the bot's own answers to this person on this card.
    const view = request.view && views?.find((v) => v.id === request.view);
    if (request.view && !view) return;
    if (!hasCallback(card.keyboard, request.data)) return;
    // Refresh asks again for the currency this person is looking at. A currency button
    // names one of the card's; if the provider stopped offering it, the answer says so.
    const currency =
      request.data === REFRESH ? (view || card).currency : buttonCurrency(request.data);
    if (!currency) return;
    let priced;
    try {
      priced = await priceReply(`price ${currency}`, this.feed, this.defaultCurrency);
    } catch {
      this.log('Price reply failed unexpectedly.');
      priced = { text: UNAVAILABLE };
    }
    const text = priced.text;
    const answer = {
      op: 'answer',
      id: request.id,
      target: request.target,
      expires: request.expires,
      ...(membership ? { membership } : {}),
    };
    const response = {
      ...rumor(
        this.key,
        [['p', message.pubkey], controlTag(answer), keyboardTag(card.keyboard)],
        text,
      ),
      kind: BOT_CONTROL_KIND,
    };
    response.id = getEventHash(response);
    const relays = await this.inbox(message.pubkey);
    const delivery = { event: wrap(response, this.key, message.pubkey), relays };
    // The answer, the replay marker and the view commit together, before publishing.
    (card.views[message.pubkey] ??= []).push({
      id: response.id,
      currency: priced.currency ?? (view || card).currency,
    });
    if (card.views[message.pubkey].length > VIEWS_PER_USER) card.views[message.pubkey].shift();
    this.state.callbacks[cacheKey] = {
      expires: request.expires,
      fingerprint: message.id,
      delivery,
    };
    this.state.outbox.push({ ...delivery, queuedAt: time });
    this.save();
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
  // A message that needs no answer is remembered, so history replays skip it cheaply.
  skip(message) {
    this.state.seen[message.id] = now();
    this.save();
  }
  queue(message, deliveries, card) {
    // Persist the exact signed reply AND dedupe marker before publishing. A crash/retry
    // republishes identical event IDs instead of fetching a different price.
    this.state.seen[message.id] = now();
    (this.state.lastReply ??= {})[message.pubkey] = now();
    this.state.outbox.push(...deliveries.map((delivery) => ({ ...delivery, queuedAt: now() })));
    if (card) this.remember(card);
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
      else if (opened.message.kind === BOT_CONTROL_KIND) await this.callback(opened.message);
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
  const picture = pictureURL.trim();
  if (picture && new URL(picture).protocol !== 'https:')
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
        ...(nip05.trim() ? { nip05: nip05.trim() } : {}),
        about:
          'DM me "price" or "price EUR" for the Bitcoin price, or mention me in an Anagram group.',
        ...(picture ? { picture } : {}),
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
    const feed = new PriceFeed({
      url: process.env.PRICE_URL || DEFAULT_PRICE_URL,
      allowHttp: process.env.PRICE_ALLOW_HTTP === '1',
      cacheSeconds: parseCacheSeconds(process.env.PRICE_CACHE_SECONDS),
      log: console.error,
    });
    // Also fetches the first price, so a bad PRICE_URL shows up in the log at startup.
    const currency = await defaultCurrency(process.env.PRICE_DEFAULT_CURRENCY, feed);
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
    bot = new PriceBot({
      store,
      net,
      feed,
      defaultCurrency: currency,
      cooldown,
      name: process.env.NAME,
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
        : 'Cannot start Bitcoin Price. Check configuration and state.json; existing keys are never replaced.',
    );
    process.exitCode = 1;
  });
}
