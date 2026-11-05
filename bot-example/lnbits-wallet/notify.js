// Incoming payment notifications for linked wallets.
//
// The source of truth is the wallet's payment history, read with its invoice key. LNbits'
// payment socket is only a hint that something changed: it sends each internal payment
// twice and never replays what was missed. So a frame's
// content is never read; it only starts a history scan.
//
// Per wallet, state.json keeps a cursor (the newest settlement time seen) and the payment
// hashes already handled. A notification is queued in the same save that records its
// payments as handled, so a crash can neither send one twice nor lose one: what was not
// saved is found again by the next scan.
//
// state.payments[ref] = { owner, baselineAt, cursor, known: { paymentHash: settledAt } }
//   ref: a digest of the invoice key, so a wallet newly linked to the same person starts
//   with its own baseline instead of announcing its whole history.
import { nip19 } from 'nostr-tools';
import WebSocket from 'ws';
import { HEX } from './vendor/runtime.js';
import { LNbitsError } from './lnbits.js';
import { receivedText } from './commands.js';

export { walletRef } from './wallets.js';

export const DEFAULTS = {
  pageSize: 50,
  maxPages: 5, // at most 250 payments read per scan
  overlapMs: 10 * 60000, // re-read this far behind the cursor (late commits, equal times)
  retentionMs: 30 * 86400000, // handled hashes kept this long; older payments never announced
  maxKnown: 5000,
  maxKnownTotal: 50000, // all wallets together: everyone shares the file this is saved in
  maxListed: 20,
  outboxLimit: 500, // notifications wait above this, so replies always have room
  queuedPerWallet: 50, // one wallet cannot use all of that
  noticeEveryMs: 10000, // at most one notification per wallet in this time: the next one lists all
  triggerDelayMs: 1000, // after a socket frame...
  recheckMs: 10000, // ...and again, in case the frame came before the row was committed
  periodicMs: 5 * 60000,
  backoffMs: [1000, 60000],
  pingMs: 30000,
  pongTimeoutMs: 10000,
};

export function validPaymentState(payments) {
  if (!payments || typeof payments !== 'object' || Array.isArray(payments)) return false;
  return Object.entries(payments).every(
    ([ref, entry]) =>
      /^[a-f0-9]{32}$/.test(ref) &&
      entry &&
      typeof entry === 'object' &&
      HEX.test(entry.owner) &&
      Number.isSafeInteger(entry.cursor) &&
      entry.cursor >= 0 &&
      Number.isSafeInteger(entry.baselineAt) &&
      (entry.forgottenUpTo === undefined || Number.isSafeInteger(entry.forgottenUpTo)) &&
      entry.known &&
      typeof entry.known === 'object' &&
      Object.entries(entry.known).every(([hash, at]) => HEX.test(hash) && Number.isSafeInteger(at)),
  );
}

export class PaymentWatcher {
  constructor(bot, options = {}) {
    this.bot = bot;
    this.options = { ...DEFAULTS, ...options };
    this.watched = new Map(); // connection id -> watch
    this.stopped = false;
    bot.state.payments ??= {};
    if (!validPaymentState(bot.state.payments))
      throw new Error('Invalid payment notification state in state.json. Restore it from backup.');
  }
  get payments() {
    return this.bot.state.payments;
  }

  // Starts watching a linked wallet whose key LNbits accepted as a non-admin key.
  watch(id) {
    const { bot } = this;
    if (this.stopped || !bot.started || !bot.verified.has(id)) return;
    const lease = bot.wallets.leaseById(id);
    if (!lease) return;
    const current = this.watched.get(id);
    if (current?.lease.valid()) return;
    if (current) this.drop(id);
    const watch = {
      id,
      owner: lease.owner,
      key: lease.key,
      ref: lease.ref,
      lease,
      client: bot.api(lease),
      timers: new Map(),
      attempts: 0,
    };
    this.watched.set(id, watch);
    // A wallet without a payment socket (NWC) is checked more often.
    watch.interval = setInterval(
      () => this.schedule(watch, 0),
      Math.min(this.options.periodicMs, watch.client.pollMs ?? Infinity),
    );
    this.connect(watch);
    this.schedule(watch, 0);
  }
  // Stops watching (link removed or switched off). Saved state is kept.
  drop(id) {
    const watch = this.watched.get(id);
    if (!watch) return;
    this.watched.delete(id);
    this.release(watch);
  }
  // The person's watch. With several wallets, the first one.
  watchOf(owner) {
    return [...this.watched.values()].find((watch) => watch.owner === owner);
  }
  release(watch) {
    clearInterval(watch.interval);
    clearTimeout(watch.retry);
    for (const timer of watch.timers.values()) clearTimeout(timer);
    watch.timers.clear();
    this.closeSocket(watch);
  }
  // Forgets saved state of wallets that are no longer linked to anyone.
  prune() {
    const linked = new Set(this.bot.wallets.refs());
    let changed = false;
    for (const ref of Object.keys(this.payments))
      if (!linked.has(ref)) {
        delete this.payments[ref];
        changed = true;
      }
    if (changed) this.bot.save();
  }

  // ---- The socket: a trigger only -----------------------------------------------------

  connect(watch) {
    if (this.stopped || this.watched.get(watch.id) !== watch || !watch.client.socketURL) return;
    const { options } = this;
    // The URL contains the key: it is passed to the socket and never logged or stored.
    let socket;
    try {
      socket = new WebSocket(watch.client.socketURL(watch.key), {
        handshakeTimeout: 10000,
        maxPayload: 64 * 1024,
        followRedirects: false,
        perMessageDeflate: false,
        ...watch.client.socketOptions,
      });
    } catch {
      // Its message could contain the URL: not logged. Retry like a closed socket.
      return this.reconnectLater(watch);
    }
    watch.socket = socket;
    // Socket errors can name the URL: they are never logged. 'close' follows.
    socket.on('error', () => {});
    let heartbeat, deadline, stable;
    socket.on('open', () => {
      // Backoff resets only once a socket stays up: one that is accepted and closed at
      // once must not turn into a reconnect (and a scan) every second.
      stable = setTimeout(() => (watch.attempts = 0), 30000);
      heartbeat = setInterval(() => {
        deadline = setTimeout(() => socket.terminate(), options.pongTimeoutMs);
        socket.ping();
      }, options.pingMs);
      // Nothing is replayed after a reconnect: catch up from the history.
      this.schedule(watch, 0);
    });
    socket.on('pong', () => clearTimeout(deadline));
    socket.on('message', () => {
      this.schedule(watch, options.triggerDelayMs);
      this.schedule(watch, options.recheckMs);
    });
    socket.once('close', () => {
      clearInterval(heartbeat);
      clearTimeout(stable);
      clearTimeout(deadline);
      if (watch.socket === socket) watch.socket = null;
      this.reconnectLater(watch);
    });
  }
  reconnectLater(watch) {
    if (this.stopped || this.watched.get(watch.id) !== watch) return;
    const [min, max] = this.options.backoffMs;
    const delay = Math.min(max, min * 2 ** Math.min(watch.attempts++, 10));
    watch.retry = setTimeout(() => this.connect(watch), delay * (1 + Math.random() / 4));
  }
  closeSocket(watch) {
    const socket = watch.socket;
    watch.socket = null;
    socket?.terminate();
  }

  // ---- Scans ----------------------------------------------------------------------------

  // Runs a scan after delayMs. Scans of one wallet never overlap; requests that arrive
  // during a scan are folded into one more scan after it.
  // At most one pending timer per delay: a flood of frames costs one scan, not one each.
  schedule(watch, delayMs) {
    if (this.stopped || watch.timers.has(delayMs)) return;
    const timer = setTimeout(() => {
      watch.timers.delete(delayMs);
      void this.scan(watch);
    }, delayMs);
    watch.timers.set(delayMs, timer);
  }
  scan(watch) {
    if (this.stopped) return Promise.resolve();
    if (watch.scanning) {
      watch.again = true;
      return watch.scanning;
    }
    watch.scanning = (async () => {
      do {
        watch.again = false;
        await this.scanOnce(watch);
      } while (watch.again && !this.stopped);
    })()
      .catch((error) => this.bot.fail(error))
      .finally(() => {
        watch.scanning = null;
      });
    return watch.scanning;
  }

  async scanOnce(watch) {
    const { bot, options } = this;
    if (this.stopped || this.watched.get(watch.id) !== watch) return;
    if (!watch.lease.valid()) return this.drop(watch.id);
    // Busy: try later rather than drop a notification. Notifications stop well before the
    // outbox is full, because a full one refuses everyone's messages and button presses.
    if (bot.state.outbox.length >= options.outboxLimit) return;
    const entry = this.payments[watch.ref];
    if (entry) this.healCursor(entry);
    let read;
    try {
      read = await this.read(watch, entry);
    } catch (error) {
      if (!(error instanceof LNbitsError) || this.stopped) {
        if (error instanceof LNbitsError) return;
        throw error;
      }
      if (error.code === 'admin_key') return bot.switchOff(watch.id, watch.owner);
      bot.note(
        `payments:${watch.owner}`,
        `Payment check for ${nip19.npubEncode(watch.owner)} failed (${error.code}${error.status ? ` ${error.status}` : ''}); retrying.`,
      );
      return;
    }
    // Disconnected while reading: nothing may be written for it, not even a new baseline.
    if (this.stopped || !watch.lease.valid()) return;
    const who = nip19.npubEncode(watch.owner);
    if (read.malformed)
      bot.note(
        `malformed:${watch.owner}`,
        `Skipped ${read.malformed} unreadable payment row(s) for ${who}; they are not announced.`,
      );
    if (!entry) {
      // First run for this wallet: what exists now is the baseline and is never announced.
      const baseline = { owner: watch.owner, baselineAt: Date.now(), cursor: 0, known: {} };
      this.remember(baseline, read.items);
      this.payments[watch.ref] = baseline;
      bot.save();
      bot.log(
        `Payment notifications for ${who} started; ${read.items.length} recent payment(s) are the baseline and are not announced.`,
      );
      return;
    }
    // Payments created long before the baseline or the newest known payment are never new,
    // even if their row is updated later. baselineAt (local clock) covers wallets that were
    // empty at baseline; minutes of clock skew do not matter against the retention period.
    const oldest = Math.max(entry.cursor, entry.baselineAt) - options.retentionMs;
    const fresh = [
      ...new Map(
        read.items
          .filter(
            (p) =>
              !entry.known[p.paymentHash] &&
              p.createdAt >= oldest &&
              Math.min(p.settledAt, Date.now()) > (entry.forgottenUpTo ?? 0),
          )
          .map((p) => [p.paymentHash, p]),
      ).values(),
    ].sort((a, b) => a.settledAt - b.settledAt);
    if (!fresh.length) {
      const before = JSON.stringify([entry.cursor, Object.keys(entry.known).length]);
      this.remember(entry, read.items);
      if (JSON.stringify([entry.cursor, Object.keys(entry.known).length]) !== before) bot.save();
      return;
    }
    // It may have filled up while this scan was reading, or while the relays are looked up.
    const queueFull = () =>
      bot.state.outbox.length >= options.outboxLimit ||
      bot.state.outbox.filter((item) => item.connection === watch.lease.id).length >=
        options.queuedPerWallet;
    if (queueFull()) return;
    // What is not recorded now is found again by the next scan, so nothing is lost by waiting.
    const wait = (watch.lastNotice ?? 0) + options.noticeEveryMs - Date.now();
    if (wait > 0) return this.schedule(watch, wait);
    watch.lastNotice = Date.now();
    const listed = fresh.slice(-options.maxListed);
    const text = receivedText(listed, watch.lease.label, {
      earlier: fresh.length - listed.length,
      incomplete: !read.complete,
    });
    await bot.announce(watch.lease, text, () => this.remember(entry, read.items), queueFull);
    if (!read.complete)
      bot.log(`More payments for ${who} than one check reads; older ones were summarized.`);
  }

  // Newest settlements first, back to overlapMs before the cursor (or before the newest
  // payment, for a baseline), and never more than maxPages pages.
  // A baseline reads as far as one check may (maxPages), so that older payments whose rows
  // are updated later are already known.
  async read(watch, entry) {
    const { pageSize, maxPages, overlapMs } = this.options;
    const signal = this.bot.signal(watch.lease);
    const stopBelow = entry ? entry.cursor - overlapMs : -Infinity;
    const items = [];
    let malformed = 0;
    for (let page = 0; page < maxPages; page++) {
      const read = await watch.client.incoming(
        watch.key,
        { limit: pageSize, offset: page * pageSize },
        { signal },
      );
      malformed += read.malformed;
      for (const payment of read.payments) {
        if (payment.settledAt < stopBelow) return { items, complete: true, malformed };
        items.push(payment);
      }
      if (read.rows < pageSize) return { items, complete: true, malformed };
    }
    return { items, complete: false, malformed };
  }

  // A row dated in the future (LNbits' clock stepped) must not push the cursor past later real
  // payments: every scan would stop before reaching them, silently.
  // Dedupe is by hash, so a clock that is merely a little ahead costs nothing.
  // Repairs a cursor saved while it could still run ahead, so what it hid is found again.
  healCursor(entry) {
    const limit = Date.now();
    if (entry.cursor <= limit) return;
    for (const [hash, at] of Object.entries(entry.known)) if (at > limit) entry.known[hash] = limit;
    entry.cursor = Math.max(0, ...Object.values(entry.known));
    this.bot.save();
  }

  // Marks payments as handled and moves the cursor; keeps the set bounded.
  remember(entry, items) {
    const { retentionMs, maxKnown } = this.options;
    const limit = Date.now();
    for (const p of items) {
      const settledAt = Math.min(p.settledAt, limit);
      if (settledAt <= (entry.forgottenUpTo ?? 0)) continue;
      entry.known[p.paymentHash] = Math.max(entry.known[p.paymentHash] ?? 0, settledAt);
      entry.cursor = Math.max(entry.cursor, settledAt);
    }
    for (const [hash, at] of Object.entries(entry.known))
      if (at < entry.cursor - retentionMs) delete entry.known[hash];
    const known = Object.entries(entry.known);
    if (known.length > maxKnown)
      this.#forget(entry, known.sort((a, b) => a[1] - b[1]).slice(0, known.length - maxKnown));
    this.#capAll();
  }

  // Forgotten hashes are not read as new again: everything up to the newest forgotten settlement
  // counts as handled. A payment settling within that range, late, goes unannounced. It is still in
  // the wallet's history, and only someone holding more than a fair share can run into this.
  #forget(entry, rows) {
    for (const [hash, at] of rows) {
      delete entry.known[hash];
      entry.forgottenUpTo = Math.max(entry.forgottenUpTo ?? 0, at);
    }
  }
  // A wallet can claim as many payments as it likes, and each costs a connection nothing. So nobody
  // holding up to an equal share of the total loses anything, whatever others do. Above that,
  // everyone comes down to one level, oldest first.
  #capAll() {
    const { maxKnownTotal } = this.options;
    const entries = Object.values(this.bot.state.payments);
    const sizes = new Map(entries.map((entry) => [entry, Object.keys(entry.known).length]));
    const excess = [...sizes.values()].reduce((sum, size) => sum + size, 0) - maxKnownTotal;
    if (excess <= 0) return;
    const overLevel = (level) =>
      [...sizes.values()].reduce((sum, size) => sum + Math.max(0, size - level), 0);
    // The lowest level that takes no more than the excess. It is never below an equal share.
    let level = Math.floor(maxKnownTotal / entries.length);
    let top = Math.max(...sizes.values());
    while (level < top) {
      const middle = Math.floor((level + top) / 2);
      if (overLevel(middle) <= excess) top = middle;
      else level = middle + 1;
    }
    let oneMore = excess - overLevel(level);
    for (const entry of entries) {
      if (sizes.get(entry) < level) continue;
      const drop = sizes.get(entry) - level + (oneMore > 0 ? 1 : 0);
      if (oneMore > 0) oneMore--;
      if (!drop) continue;
      const oldest = Object.entries(entry.known).sort((a, b) => a[1] - b[1]);
      this.#forget(entry, oldest.slice(0, drop));
    }
  }

  async stop() {
    this.stopped = true;
    for (const watch of this.watched.values()) this.release(watch);
    const scans = [...this.watched.values()].map((w) => w.scanning);
    this.watched.clear();
    await Promise.all(scans);
  }
}
