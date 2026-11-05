// A wallet reached through Nostr Wallet Connect (NIP-47), with the same interface as the
// LNbits client, so commands, invoices and notifications work the same for both.
//
// A connection is receive only unless the person connected it to spend. Either way it is refused
// if it can do anything beyond a short list: paying single invoices is the only way to spend it
// may have, and only if it was made for that. This is checked when it is connected and again
// regularly, because a wallet can change what a connection may do.
//
// NIP-47 itself defines only get_info, get_balance, make_invoice, lookup_invoice and pay_invoice.
// A wallet need not offer them all: what it lacks is reported as not offered, and only what a
// connection is for is required (see inspect).
//
// NIP-47 says nothing about idempotency, so one request is all the bot ever sends for a payment,
// on one relay. It cannot promise more than that: exactly once also depends on the wallet.
//
// Limits, on purpose:
//   - NIP-44 only. NIP-04 is deprecated, and a wallet that does not offer NIP-44 is refused.
//   - Connection strings only. Nostr Wallet Auth is not implemented: it is not in the merged
//     NIP, and its approval is an event anyone who saw the app's public key could publish, so
//     a relay could pose as the wallet and have invoices pay someone else.
//   - Relays that require AUTH are not supported.
//   - NWC has no external id, so an invoice whose answer was lost cannot be found again. That
//     is harmless on the receiving side: an unseen invoice is never paid.
import { AsyncLocalStorage } from 'node:async_hooks';
import { finalizeEvent, getPublicKey, nip44, verifyEvent } from 'nostr-tools';
import WebSocket from 'ws';
import { BOLT11, LNbitsError } from './lnbits.js';
import { guardedLookup } from './net-guard.js';
import { bytes, relayURLs, single } from './vendor/runtime.js';

const HEX64 = /^[a-f0-9]{64}$/;
const INFO = 13194;
const REQUEST = 23194;
const RESPONSE = 23195;
// What a receive-only connection may be able to do. Anything else is refused.
export const RECEIVE_METHODS = new Set([
  'get_info',
  'get_balance',
  'get_budget',
  'make_invoice',
  'lookup_invoice',
  'list_transactions',
]);
// A connection made for /send may also pay single invoices. Never more than that.
const SPEND_METHODS = new Set([...RECEIVE_METHODS, 'pay_invoice']);
const allowedFor = (secret) => (secret.scope === 'spend' ? SPEND_METHODS : RECEIVE_METHODS);
// What a receive-only connection must be good for, at least one of.
const USEFUL_METHODS = ['get_balance', 'make_invoice', 'list_transactions'];
// What a connection made to spend must offer. Without lookup_invoice, a lost answer could never
// be settled.
const SPEND_NEEDED = ['pay_invoice', 'lookup_invoice'];
const NETWORKS = { mainnet: 'bc', testnet: 'tb', signet: 'tbs', regtest: 'bcrt' };
// get_info answered when the connection was checked, whatever list it gave.
const offers = (secret, method) =>
  method === 'get_info' || !secret.methods || secret.methods.includes(method);
const RECHECK_MS = 10 * 60000;
const MAX_CONCURRENT = 32;
const MAX_ROUTINE = 24;
const URGENT = new AsyncLocalStorage();
const MAX_WAITING = 100;
// One silent wallet cannot take every slot from everyone else.
const MAX_PER_WALLET = 3;

export class NwcError extends Error {
  constructor(code) {
    super(`NWC connection refused (${code}).`);
    this.code = code;
  }
}

// nostr+walletconnect://<wallet key>?relay=...&secret=... Throws NwcError('format'). Never
// includes the text in an error: it holds the connection's secret.
export function parseConnection(text, { trustedRelays = [] } = {}) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    throw new NwcError('format');
  }
  if (url.protocol !== 'nostr+walletconnect:') throw new NwcError('format');
  const walletPubkey = url.hostname || url.pathname.replace(/^\/+/, '');
  const clientSecret = url.searchParams.get('secret') ?? '';
  if (!HEX64.test(walletPubkey) || !HEX64.test(clientSecret)) throw new NwcError('format');
  try {
    getPublicKey(bytes(clientSecret));
  } catch {
    throw new NwcError('format');
  }
  // Relays named by a person: public wss only, unless the operator listed them.
  const relays = relayURLs(url.searchParams.getAll('relay'), trustedRelays).slice(0, 3);
  if (!relays.length) throw new NwcError('relay');
  return { walletPubkey, clientSecret, relays };
}

const conversation = (secret) =>
  nip44.v2.utils.getConversationKey(bytes(secret.clientSecret), secret.walletPubkey);

const errorFor = {
  UNAUTHORIZED: () => new LNbitsError('rejected', { definite: true }),
  RESTRICTED: () => new LNbitsError('rejected', { definite: true }),
  NOT_IMPLEMENTED: () => new LNbitsError('refused', { definite: true }),
  UNSUPPORTED_ENCRYPTION: () => new LNbitsError('refused', { definite: true }),
  QUOTA_EXCEEDED: () => new LNbitsError('refused', { definite: true }),
  RATE_LIMITED: () => new LNbitsError('busy', { definite: true }),
  NOT_FOUND: () => new LNbitsError('not_found', { definite: true }),
};

export class NwcClient {
  constructor({
    timeoutMs = 15000,
    trustedRelays = [],
    lookup = guardedLookup(),
    pollMs = 60000,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.trusted = new Set(trustedRelays.map((relay) => new URL(relay).href));
    this.lookup = lookup;
    // No payment socket here: notifications come from checking regularly.
    this.pollMs = pollMs;
    // An invoice whose answer was lost cannot be looked up (see above).
    this.findsLost = false;
    this.active = 0;
    this.waiting = [];
    this.waitingUrgent = [];
    this.perWallet = new Map();
    this.checked = new Map();
  }
  toJSON() {
    return { nwc: 'client' };
  }
  #socket(url) {
    // Checked here as well as when connecting: a connection stored while a test relay was listed
    // must not keep reaching it once it no longer is. An address by number skips the lookup guard.
    if (!relayURLs([url], [...this.trusted]).length) throw new Error('Relay not allowed.');
    return new WebSocket(url, {
      maxPayload: 256 * 1024,
      handshakeTimeout: 10000,
      followRedirects: false,
      perMessageDeflate: false,
      ...(this.trusted.has(new URL(url).href) ? {} : { lookup: this.lookup }),
    });
  }
  // Payments and the checks around them are urgent(), and may use every slot and go first. All else
  // leaves some free, so that silent wallets polled in the background cannot hold up a payment.
  urgent(action) {
    return URGENT.run(true, action);
  }
  async #slot(signal) {
    if (signal?.aborted) throw new LNbitsError('unavailable', { definite: true });
    const urgent = URGENT.getStore() === true;
    if (this.active < (urgent ? MAX_CONCURRENT : MAX_ROUTINE)) {
      this.active++;
      return;
    }
    const queue = urgent ? this.waitingUrgent : this.waiting;
    if (queue.length >= MAX_WAITING) throw new LNbitsError('busy', { definite: true });
    await new Promise((resolve, reject) => {
      const leave = (error) => {
        const index = queue.indexOf(entry);
        if (index < 0) return; // Already handed a slot; #call releases it.
        queue.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      const onAbort = () => leave(new LNbitsError('unavailable', { definite: true }));
      // Nothing has gone anywhere yet, so giving up here is certain.
      const timer = setTimeout(
        () => leave(new LNbitsError('busy', { definite: true })),
        this.timeoutMs,
      );
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  #release() {
    const next =
      this.waitingUrgent.shift() ?? (this.active <= MAX_ROUTINE ? this.waiting.shift() : undefined);
    if (next) next.resolve();
    else this.active--;
  }

  // Sends one request on every relay of the connection and waits for the first answer that is
  // signed by the wallet, addressed to this client and about this exact request.
  async request(secret, method, params = {}, { signal, timeoutMs = this.timeoutMs, once } = {}) {
    // Only pay() can pay, and only on a connection made for it.
    if (method === 'pay_invoice' || !allowedFor(secret).has(method))
      throw new RangeError(`Method not allowed: ${method}.`);
    if (!offers(secret, method)) throw new LNbitsError('not_offered', { definite: true });
    return this.#call(secret, method, params, signal, timeoutMs, once);
  }
  async #call(secret, method, params, signal, timeoutMs, once = false) {
    const wallet = secret.walletPubkey;
    const running = this.perWallet.get(wallet) ?? 0;
    if (running >= MAX_PER_WALLET) throw new LNbitsError('busy', { definite: true });
    this.perWallet.set(wallet, running + 1);
    try {
      await this.#slot(signal);
      try {
        // Cancelled while waiting for a slot: nothing has gone anywhere, and nothing may.
        if (signal?.aborted) throw new LNbitsError('unavailable', { definite: true });
        return await this.#exchange(secret, method, params, signal, timeoutMs, once);
      } finally {
        this.#release();
      }
    } finally {
      const left = this.perWallet.get(wallet) - 1;
      if (left) this.perWallet.set(wallet, left);
      else this.perWallet.delete(wallet);
    }
  }
  // once: the request goes on one relay, whichever is ready first, and never on another, even if
  // that one refuses it. It may have passed it on all the same, and a wallet may not recognize the
  // same event arriving twice. The others only listen for the answer.
  #exchange(secret, method, params, signal, timeoutMs, once) {
    const client = bytes(secret.clientSecret);
    const clientPubkey = getPublicKey(client);
    const key = conversation(secret);
    const event = finalizeEvent(
      {
        kind: REQUEST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', secret.walletPubkey],
          ['encryption', 'nip44_v2'],
          ['expiration', String(Math.floor((Date.now() + timeoutMs) / 1000))],
        ],
        content: nip44.v2.encrypt(JSON.stringify({ method, params }), key),
      },
      client,
    );
    return new Promise((resolve, reject) => {
      const sockets = new Set();
      let settled = false;
      let sent = false; // a relay may have passed the request on: the outcome is unknown
      let refusals = 0;
      const asked = new Set();
      const put = (socket) => {
        // A relay may repeat its EOSE: once per socket, whatever it does.
        if (asked.has(socket)) return;
        asked.add(socket);
        // Subscribed before asking, so the answer cannot be missed.
        sent = true;
        socket.send(JSON.stringify(['EVENT', event]));
      };
      const finish = (act, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        for (const socket of sockets) socket.terminate();
        act(value);
      };
      const onAbort = () => finish(reject, new LNbitsError('unavailable', { definite: !sent }));
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () =>
          finish(reject, new LNbitsError(sent ? 'timeout' : 'unavailable', { definite: !sent })),
        timeoutMs,
      );
      const gaveUp = () => {
        if (++refusals >= secret.relays.length)
          finish(reject, new LNbitsError('unavailable', { definite: !sent }));
      };
      for (const url of secret.relays) {
        let socket;
        try {
          socket = this.#socket(url);
        } catch {
          gaveUp();
          continue;
        }
        sockets.add(socket);
        let gone = false;
        const lost = () => {
          if (!gone) {
            gone = true;
            gaveUp();
          }
        };
        socket.on('error', () => {});
        socket.on('close', lost);
        socket.on('open', () =>
          socket.send(
            JSON.stringify([
              'REQ',
              'r',
              {
                kinds: [RESPONSE],
                authors: [secret.walletPubkey],
                '#p': [clientPubkey],
                '#e': [event.id],
              },
            ]),
          ),
        );
        onFrames(socket, (frame) => {
          if (frame[0] === 'EOSE') {
            if (!once || !sent) put(socket);
          } else if (frame[0] === 'OK' && frame[1] === event.id && frame[2] === false) {
            // Refused, it says. For a payment that settles nothing, and is not tried elsewhere.
            if (once) finish(reject, new LNbitsError('unavailable', { definite: false }));
            else lost();
          } else if (frame[0] === 'EVENT') {
            const answer = readAnswer(frame[2], secret, clientPubkey, event.id, method, key);
            if (answer === undefined) return;
            if (answer.error) {
              const known = Object.hasOwn(errorFor, answer.error.code);
              const error = known ? errorFor[answer.error.code]() : new LNbitsError('unavailable');
              error.walletCode = answer.error.code;
              finish(reject, error);
            } else finish(resolve, answer.result);
          }
        });
      }
    });
  }

  // The wallet's published info event: which encryption it offers. Null if none was found.
  info(secret, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve) => {
      const sockets = new Set();
      let waiting = secret.relays.length;
      const done = (value) => {
        clearTimeout(timer);
        for (const socket of sockets) socket.terminate();
        resolve(value);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      for (const url of secret.relays) {
        const socket = this.#socket(url);
        sockets.add(socket);
        const none = () => {
          if (--waiting <= 0) done(null);
        };
        socket.on('error', () => {});
        socket.once('close', none);
        socket.on('open', () =>
          socket.send(
            JSON.stringify([
              'REQ',
              'i',
              { kinds: [INFO], authors: [secret.walletPubkey], limit: 1 },
            ]),
          ),
        );
        onFrames(socket, (frame) => {
          if (frame[0] === 'EOSE') socket.close();
          else if (frame[0] === 'EVENT' && validEvent(frame[2], INFO, secret.walletPubkey))
            done(frame[2]);
        });
      }
    });
  }

  // Checks a connection before it is accepted, and notes on it what it offers. Throws NwcError:
  // 'encryption' (no NIP-44), 'spending' (it can do more than it was made for), 'methods' (it
  // lacks what it is for), 'budget' (no limit set in the wallet), or an
  // LNbitsError if the wallet cannot be reached. Returns what the page shows.
  async inspect(secret) {
    const allowed = allowedFor(secret);
    const info = await this.info(secret);
    if (!info) throw new LNbitsError('unavailable', { definite: true });
    const encryption = info.tags.find((t) => t[0] === 'encryption')?.[1]?.split(/\s+/) ?? [];
    if (!encryption.includes('nip44_v2')) throw new NwcError('encryption');
    const result = await this.request(secret, 'get_info');
    const methods = readMethods(result);
    if (methods.some((m) => !allowed.has(m))) throw new NwcError('spending');
    secret.methods = [...new Set(methods)];
    if (Object.hasOwn(NETWORKS, result?.network)) secret.network = NETWORKS[result.network];
    let budget;
    if (secret.scope === 'spend') {
      if (!SPEND_NEEDED.every((m) => methods.includes(m))) throw new NwcError('methods');
      // Only the wallet's own limit binds if this bot or its host is ever compromised.
      budget = await this.budget(secret);
      if (!(budget.totalMsat > 0)) throw new NwcError('budget');
    } else if (!USEFUL_METHODS.some((m) => methods.includes(m))) throw new NwcError('methods');
    return {
      alias: typeof result?.alias === 'string' ? result.alias : '',
      methods: secret.methods,
      budget,
    };
  }
  // Whether the key is good, for wallets that have no balance to read.
  verify(secret, { signal, fresh = false } = {}) {
    return this.#stillReceiveOnly(secret, signal, fresh);
  }
  // Again every few minutes: a connection that gained more power is switched off. This runs
  // for commands and for the regular payment checks, so an idle wallet is covered too.
  async #stillReceiveOnly(secret, signal, fresh = false) {
    const time = Date.now();
    const id = `${secret.walletPubkey}:${getPublicKey(bytes(secret.clientSecret))}`;
    if (!fresh && (this.checked.get(id) ?? 0) > time - RECHECK_MS) return;
    const allowed = allowedFor(secret);
    const methods = readMethods(await this.request(secret, 'get_info', {}, { signal }));
    if (methods.some((m) => !allowed.has(m))) throw new LNbitsError('admin_key');
    if (this.checked.size >= 5000) this.checked.clear();
    this.checked.set(id, time);
  }

  // The spending limit set in the wallet (not in the merged NIP-47; offered by some wallets).
  // Not offered, no limit, or an unreadable answer reads as none. totalMsat 0: none.
  async budget(secret, { signal } = {}) {
    if (!offers(secret, 'get_budget')) return { totalMsat: 0, usedMsat: 0 };
    let result;
    try {
      result = await this.request(secret, 'get_budget', {}, { signal });
    } catch (error) {
      // Offered in name only: a wallet saying so has no limit to report.
      if (error instanceof LNbitsError && error.walletCode === 'NOT_IMPLEMENTED')
        return { totalMsat: 0, usedMsat: 0 };
      throw error;
    }
    const total = result?.total_budget;
    const used = result?.used_budget;
    if (!Number.isSafeInteger(total) || total <= 0) return { totalMsat: 0, usedMsat: 0 };
    // A limit with no reading of what is left of it cannot be checked against.
    if (!Number.isSafeInteger(used) || used < 0) throw new LNbitsError('bad_response');
    return { totalMsat: total, usedMsat: used };
  }
  // One payment request. Never retried here: when the outcome is unknown the caller looks it
  // up. The request carries a short expiry, so a wallet seeing it late should ignore it.
  async pay(secret, invoice, { signal, timeoutMs = 60000 } = {}) {
    if (secret.scope !== 'spend') throw new RangeError('This connection cannot pay.');
    return this.#call(secret, 'pay_invoice', { invoice }, signal, timeoutMs, true);
  }
  // What the wallet records under a payment hash, or null if it has nothing under it. That null
  // proves nothing about a payment: NIP-47 does not require a wallet to find outgoing ones.
  async lookupPayment(secret, hash, { signal } = {}) {
    if (!HEX64.test(hash ?? '')) throw new RangeError('Invalid payment hash.');
    let result;
    try {
      result = await this.request(secret, 'lookup_invoice', { payment_hash: hash }, { signal });
    } catch (error) {
      if (error instanceof LNbitsError && error.code === 'not_found') return null;
      throw error;
    }
    if (!result || typeof result !== 'object') throw new LNbitsError('bad_response');
    const { type, state, amount, preimage, fees_paid: fees, settled_at: settled } = result;
    return {
      outgoing: type === undefined ? undefined : type === 'outgoing',
      state:
        typeof state === 'string' ? state : Number.isSafeInteger(settled) ? 'settled' : 'pending',
      amountMsat: Number.isSafeInteger(amount) ? Math.abs(amount) : undefined,
      preimage: typeof preimage === 'string' ? preimage : '',
      feesMsat: Number.isSafeInteger(fees) && fees >= 0 ? fees : undefined,
    };
  }

  // ---- The same interface as LNbitsClient ------------------------------------------------

  async wallet(secret, { signal } = {}) {
    await this.#stillReceiveOnly(secret, signal);
    const { balance } = (await this.request(secret, 'get_balance', {}, { signal })) ?? {};
    if (!Number.isSafeInteger(balance) || balance < 0) throw new LNbitsError('bad_response');
    return { balanceMsat: balance };
  }
  async payments(secret, limit, { signal, offset = 0 } = {}) {
    const rows = await this.#transactions(secret, { limit, offset }, signal);
    return rows.slice(0, limit).flatMap((item) => {
      const row = settledRow(item);
      if (row === undefined) throw new LNbitsError('bad_response');
      if (!row) return [];
      return [
        {
          amountMsat: row.outgoing ? -row.amount : row.amount,
          feeMsat: row.fee,
          memo: row.memo,
          time: row.settled,
        },
      ];
    });
  }
  // One request, on one relay, like LNbits. A lost answer is not retried.
  async createInvoice(secret, { sats, memo, expiry }, { signal } = {}) {
    if (!Number.isSafeInteger(sats) || sats < 1) throw new RangeError('Invalid invoice amount.');
    const result = await this.request(
      secret,
      'make_invoice',
      { amount: sats * 1000, description: memo, expiry },
      { signal, once: true },
    );
    const invoice = invoiceItem(result);
    if (!invoice) throw new LNbitsError('bad_response');
    if (invoice.amountMsat !== sats * 1000) throw new LNbitsError('mismatch');
    return invoice;
  }
  // An invoice can only be found by its payment hash, known once it was created.
  async findInvoices(secret, _externalId, { signal, paymentHash } = {}) {
    if (!paymentHash) return [];
    try {
      const invoice = invoiceItem(
        await this.request(secret, 'lookup_invoice', { payment_hash: paymentHash }, { signal }),
      );
      if (!invoice) throw new LNbitsError('bad_response');
      return [invoice];
    } catch (error) {
      if (error instanceof LNbitsError && error.code === 'not_found') return [];
      throw error;
    }
  }
  async incoming(secret, { limit = 50, offset = 0 } = {}, { signal } = {}) {
    await this.#stillReceiveOnly(secret, signal);
    // Nothing to watch: this wallet does not list its payments, so nobody is notified.
    if (!offers(secret, 'list_transactions')) return { payments: [], rows: 0, malformed: 0 };
    const rows = (
      await this.#transactions(secret, { limit, offset, type: 'incoming' }, signal)
    ).slice(0, limit);
    let malformed = 0;
    const payments = rows.flatMap((item) => {
      const row = settledRow(item);
      if (row === undefined) malformed++;
      if (!row || row.outgoing) return [];
      return [
        {
          paymentHash: row.hash,
          amountMsat: row.amount,
          memo: row.memo,
          settledAt: row.settled * 1000,
          createdAt: row.created * 1000,
        },
      ];
    });
    return { payments, rows: rows.length, malformed };
  }
  async #transactions(secret, params, signal) {
    const result = await this.request(secret, 'list_transactions', params, { signal });
    if (!Array.isArray(result?.transactions)) throw new LNbitsError('bad_response');
    return result.transactions;
  }
}

const readMethods = (result) => {
  const methods = result?.methods;
  if (!Array.isArray(methods) || !methods.every((m) => typeof m === 'string'))
    throw new LNbitsError('bad_response');
  return methods;
};

// A relay can send anything. Nothing it sends can be allowed to throw in a socket handler,
// where it would take the whole process down.
function onFrames(socket, handle) {
  socket.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw);
      if (Array.isArray(frame)) handle(frame);
    } catch {
      /* Not a frame this client can use. */
    }
  });
}

function validEvent(event, kind, author) {
  try {
    return (
      event?.kind === kind &&
      event.pubkey === author &&
      JSON.stringify(event).length <= 256 * 1024 &&
      verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      })
    );
  } catch {
    return false;
  }
}
// The decoded answer, or undefined if this is not the wallet's answer to this exact request.
function readAnswer(event, secret, clientPubkey, requestId, method, key) {
  if (
    !validEvent(event, RESPONSE, secret.walletPubkey) ||
    single(event, 'e') !== requestId ||
    single(event, 'p') !== clientPubkey
  )
    return undefined;
  try {
    const answer = JSON.parse(nip44.v2.decrypt(event.content, key));
    if (answer?.result_type !== method) return undefined;
    if (answer.error) {
      // A wallet's own words end up in logs: only a plain code gets that far.
      const code = String(answer.error.code);
      return { error: { code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'OTHER' } };
    }
    return { result: answer.result };
  } catch {
    return undefined;
  }
}

const STATUS = {
  settled: 'success',
  pending: 'pending',
  accepted: 'pending',
  expired: 'failed',
  failed: 'failed',
};
function invoiceItem(item) {
  if (!item || typeof item !== 'object') return undefined;
  const { amount, invoice, payment_hash: hash, description, settled_at: settled, state } = item;
  const status = STATUS[state] ?? (settled ? 'success' : 'pending');
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof invoice !== 'string' ||
    !BOLT11.test(invoice) ||
    !HEX64.test(hash ?? '') ||
    !(description === null || description === undefined || typeof description === 'string')
  )
    return undefined;
  return {
    amountMsat: amount,
    bolt11: invoice,
    paymentHash: hash,
    status,
    memo: description ?? '',
  };
}
// A wallet's timestamps end up in saved cursors and displayed dates: an absurd one must not
// reach either.
const sensibleTime = (seconds) =>
  Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= Date.now() / 1000 + 86400;
// A settled transaction reduced to what the bot shows; null if it is not settled, undefined if
// it is malformed.
function settledRow(item) {
  if (!item || typeof item !== 'object') return undefined;
  const {
    type,
    state,
    amount,
    fees_paid: fee,
    description,
    payment_hash: hash,
    created_at: created,
    settled_at: settled,
  } = item;
  if (
    !['incoming', 'outgoing'].includes(type) ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(fee ?? 0) ||
    !HEX64.test(hash ?? '') ||
    !(description === null || description === undefined || typeof description === 'string') ||
    !sensibleTime(created ?? 0)
  )
    return undefined;
  if (settled !== undefined && settled !== null && !sensibleTime(settled)) return undefined;
  if (!Number.isSafeInteger(settled) || (state && state !== 'settled')) return null;
  return {
    outgoing: type === 'outgoing',
    amount,
    fee: Math.abs(fee ?? 0),
    memo: description ?? '',
    hash,
    created: created ?? settled,
    settled,
  };
}
