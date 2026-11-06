// A small LNbits API client: read requests and one way to create an invoice, all with an
// invoice key, on the fixed base URL from the operator's configuration. Nothing from chat
// ever reaches a URL, and nothing here can send a payment.
//
// Every failure becomes an LNbitsError with a fixed code and message: no URL, key, status
// text or response body is ever included, so errors are safe to log. For invoice creation,
// error.definite says whether LNbits certainly created nothing; otherwise the outcome is
// unknown and must be checked with findInvoices(), never by asking again.
//
// Verified against LNbits v1.6.2 (see README, "LNbits API"):
//   GET  /api/v1/wallet      -> { name, balance (msat) } ; with the ADMIN key also { id }
//   GET  /api/v1/payments    -> [ payment, ... ] (pending and settled; never failed)
//   POST /api/v1/payments    -> 201 payment ; 400 invalid ; 520 InvoiceError (raised before
//                               the payment is stored, so nothing was created)
//   GET  /api/v1/payments/paginated?external_id=X -> { data, total }, exact match per wallet.
//        Unknown filter names are ignored by LNbits, so matches are checked here as well.
//   GET  /api/v1/payments/{hash} -> { paid, status?, details } with the wallet's own key. LNbits
//        first asks its funding source about a pending invoice, and marks an expired one failed
//        with the label "expired".
//   Wrong or reset key       -> 404 "Wallet not found."   Missing key -> 401
import { LNBITS_KEY } from './wallets.js';

export const MAX_HISTORY = 20;
const MAX_BYTES = 256 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
// Bounded throughout: a server's answer is stored and sent on, more than once.
export const BOLT11 = /^ln(?:bc|tb|bcrt|tbs)[0-9]{0,20}[munp]?1[02-9ac-hj-np-z]{100,3800}$/;
export const EXTERNAL_ID = /^alw-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Errors raised while connecting, before any part of the request reached the server.
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EGUARD', // net-guard.js refused the address before connecting
]);

const MESSAGES = {
  rejected: 'LNbits rejected the wallet key.',
  admin_key: 'The configured key is an admin key, which can spend.',
  refused: 'LNbits refused to create the invoice.',
  timeout: 'LNbits did not answer in time.',
  unavailable: 'LNbits could not be reached.',
  bad_response: 'LNbits returned an unexpected response.',
  mismatch: 'LNbits created an invoice that does not match the request.',
  busy: 'Too many LNbits requests are waiting.',
  not_found: 'The wallet has no such invoice.',
  not_offered: 'This wallet connection does not offer that.',
};
export class LNbitsError extends Error {
  constructor(code, { status, definite = false } = {}) {
    super(MESSAGES[code]);
    this.code = code;
    if (status) this.status = status;
    this.definite = definite;
  }
}

export class LNbitsClient {
  #base;
  #fetch;
  constructor({
    url,
    timeoutMs = 10000,
    maxConcurrent = 4,
    maxWaiting = 100,
    fetch = globalThis.fetch,
    // Extra options for the payment socket (net-guard.js).
    socketOptions = {},
  }) {
    this.socketOptions = socketOptions;
    // The URL was validated by config.js (HTTPS unless local HTTP was explicitly allowed).
    this.#base = new URL(url);
    this.#fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxWaiting = maxWaiting;
    this.active = 0;
    this.waiting = [];
  }
  toJSON() {
    return { lnbits: 'client' };
  }

  // Balance in msat. Throws admin_key if LNbits reveals that the key can spend.
  async wallet(key, { signal } = {}) {
    const body = await this.#request('GET', 'api/v1/wallet', key, signal);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new LNbitsError('bad_response');
    // LNbits adds the wallet id (and newer versions may add more) only for admin keys.
    if ('id' in body || 'adminkey' in body) throw new LNbitsError('admin_key');
    if (!Number.isSafeInteger(body.balance) || body.balance < 0)
      throw new LNbitsError('bad_response');
    return { balanceMsat: body.balance };
  }

  // The most recent settled payments, newest first, reduced to what the bot shows. offset
  // skips that many newer ones (history buttons page through; LNbits v1.6.2 honours it).
  async payments(key, limit, { signal, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY)
      throw new RangeError('History limit out of range.');
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000)
      throw new RangeError('History offset out of range.');
    const query = new URLSearchParams({
      limit: String(limit),
      ...(offset ? { offset: String(offset) } : {}),
      sortby: 'time',
      direction: 'desc',
      status: 'success',
    });
    const body = await this.#request('GET', `api/v1/payments?${query}`, key, signal);
    if (!Array.isArray(body)) throw new LNbitsError('bad_response');
    // Never trust the server to honour the limit or the status filter (LNbits drops filters
    // it does not understand): only settled rows are history.
    return (
      body
        .slice(0, limit)
        // Well-formed but unsettled rows are dropped; malformed ones still fail below.
        .filter((item) => !(typeof item?.status === 'string' && item.status !== 'success'))
        .map(payment)
    );
  }

  // Asks LNbits for ONE incoming invoice. Called once per invoice request, never retried:
  // when the outcome is unknown (error.definite === false) use findInvoices().
  async createInvoice(key, { sats, memo, expiry, externalId }, { signal } = {}) {
    if (!Number.isSafeInteger(sats) || sats < 1) throw new RangeError('Invalid invoice amount.');
    if (!EXTERNAL_ID.test(externalId)) throw new RangeError('Invalid external id.');
    const body = await this.#request('POST', 'api/v1/payments', key, signal, {
      out: false,
      amount: sats,
      unit: 'sat',
      memo,
      expiry,
      external_id: externalId,
    });
    // LNbits answered 201, so an invoice exists. If it is not exactly what was asked for,
    // it must not be shown, and it must not be replaced by a second one either.
    const invoice = invoiceItem(body);
    if (!invoice) throw new LNbitsError('bad_response');
    if (invoice.amountMsat !== sats * 1000 || invoice.externalId !== externalId)
      throw new LNbitsError('mismatch');
    return invoice;
  }

  // Every invoice of this wallet with exactly this external id (normally zero or one).
  async findInvoices(key, externalId, { signal } = {}) {
    if (!EXTERNAL_ID.test(externalId)) throw new RangeError('Invalid external id.');
    const query = new URLSearchParams({ external_id: externalId, limit: '10' });
    const body = await this.#request('GET', `api/v1/payments/paginated?${query}`, key, signal);
    if (!body || typeof body !== 'object' || !Array.isArray(body.data))
      throw new LNbitsError('bad_response');
    // LNbits silently ignores filters it does not understand and would then return every
    // payment: only an exact external id counts as a match.
    return body.data
      .filter((item) => item?.external_id === externalId)
      .map((item) => {
        const invoice = invoiceItem(item);
        if (!invoice) throw new LNbitsError('bad_response');
        return invoice;
      });
  }

  // The wallet's own answer about one of its invoices, after LNbits has asked its funding source
  // (see the top of this file). Only what comes with "details" counts: that is what LNbits
  // keeps for the wallet that owns it.
  async confirmInvoice(key, hash, { signal } = {}) {
    if (!HEX64.test(hash ?? '')) throw new RangeError('Invalid payment hash.');
    const body = await this.#request('GET', `api/v1/payments/${hash}`, key, signal);
    const invoice = invoiceItem(body?.details);
    if (!invoice || invoice.paymentHash !== hash) throw new LNbitsError('bad_response');
    return invoice;
  }

  // Settled incoming payments, most recently settled first (LNbits sets updated_at when a
  // payment settles). updated_at cannot be filtered on, so callers page and stop at their
  // own cursor. Rows LNbits returns despite the filters (it ignores ones it does not know)
  // are dropped here: only positive, settled payments are returned.
  async incoming(key, { limit = 50, offset = 0 } = {}, { signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Bad limit.');
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
      throw new RangeError('Bad offset.');
    const query = new URLSearchParams({
      status: 'success',
      'amount[gt]': '0',
      sortby: 'updated_at',
      direction: 'desc',
      limit: String(limit),
      offset: String(offset),
    });
    const body = await this.#request('GET', `api/v1/payments/paginated?${query}`, key, signal);
    if (!body || typeof body !== 'object' || !Array.isArray(body.data))
      throw new LNbitsError('bad_response');
    const rows = body.data.slice(0, limit);
    // A malformed row is skipped and counted, not fatal: one bad row must not stop every
    // later notification of the wallet.
    let malformed = 0;
    const payments = rows.flatMap((item) => {
      const settled = settledItem(item);
      if (settled === undefined) malformed++;
      return settled ? [settled] : [];
    });
    // rows: how many the server returned, so a caller can tell the last page.
    return { payments, rows: rows.length, malformed };
  }

  // The URL of the wallet's payment-event socket. It contains the key: never log it.
  socketURL(key) {
    if (typeof key !== 'string' || !LNBITS_KEY.test(key)) throw new LNbitsError('rejected');
    const url = new URL(`api/v1/ws/${key}`, this.#base);
    url.protocol = this.#base.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  async #request(method, path, key, signal, json) {
    // Keys only ever come from wallets.json; this also keeps them out of headers if not.
    if (typeof key !== 'string' || !LNBITS_KEY.test(key))
      throw new LNbitsError('rejected', { definite: true });
    const url = new URL(path, this.#base);
    if (url.origin !== this.#base.origin) throw new LNbitsError('bad_response', { definite: true });
    if (signal?.aborted) throw new LNbitsError('unavailable', { definite: true });
    await this.#slot(signal);
    try {
      let response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            'X-Api-Key': key,
            accept: 'application/json',
            ...(json ? { 'content-type': 'application/json' } : {}),
          },
          body: json ? JSON.stringify(json) : undefined,
          // A redirect could forward the key to another server: never follow one.
          redirect: 'manual',
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
            : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const cause = error?.cause?.code ?? error?.code;
        if (error?.name === 'TimeoutError') throw new LNbitsError('timeout');
        // Only a failure to connect proves that nothing reached LNbits.
        throw new LNbitsError('unavailable', { definite: NOT_SENT.has(cause) });
      }
      const status = response.status;
      if ([401, 403, 404].includes(status))
        throw new LNbitsError('rejected', { status, definite: true });
      // 400/422: the request was invalid, nothing was stored.
      if (method === 'POST' && [400, 422].includes(status))
        throw new LNbitsError('refused', { status, definite: true });
      // 520 is LNbits' InvoiceError (raised before storing), but proxies such as Cloudflare
      // also answer 520 when the origin's reply was lost. Only LNbits' own body is certain.
      if (method === 'POST' && status === 520) {
        let body;
        try {
          body = await this.#json(response);
        } catch {
          /* unreadable: not LNbits' InvoiceError */
        }
        const invoiceError =
          body &&
          typeof body === 'object' &&
          typeof body.detail === 'string' &&
          ['failed', 'pending'].includes(body.status);
        throw new LNbitsError(invoiceError ? 'refused' : 'unavailable', {
          status,
          definite: Boolean(invoiceError),
        });
      }
      if (status !== (method === 'POST' ? 201 : 200))
        throw new LNbitsError(status >= 300 && status < 400 ? 'bad_response' : 'unavailable', {
          status,
        });
      return await this.#json(response);
    } finally {
      this.#release();
    }
  }

  async #json(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new LNbitsError('bad_response');
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new LNbitsError('bad_response');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof LNbitsError) throw error;
      throw new LNbitsError(error?.name === 'TimeoutError' ? 'timeout' : 'unavailable');
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new LNbitsError('bad_response');
    }
  }

  // At most maxConcurrent requests at once and maxWaiting queued, whoever asks.
  async #slot(signal) {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    if (this.waiting.length >= this.maxWaiting) throw new LNbitsError('busy', { definite: true });
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return; // Already handed a slot; #request releases it.
        this.waiting.splice(index, 1);
        reject(new LNbitsError('unavailable', { definite: true }));
      };
      // The listener goes as soon as the slot is granted: the bot's signal lives as long as
      // the process, so leftover listeners would pile up.
      const entry = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  #release() {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.active--;
  }
}

// Only the fields the bot shows. Anything else in the payment is ignored.
function payment(item) {
  if (!item || typeof item !== 'object') throw new LNbitsError('bad_response');
  const { amount, fee, memo, time, payment_hash: hash } = item;
  const at = Date.parse(time);
  if (
    !Number.isSafeInteger(amount) ||
    amount === 0 ||
    !Number.isSafeInteger(fee ?? 0) ||
    !(memo === null || memo === undefined || typeof memo === 'string') ||
    !Number.isFinite(at) ||
    (hash !== undefined && !HEX64.test(hash))
  )
    throw new LNbitsError('bad_response');
  return {
    amountMsat: amount,
    feeMsat: Math.abs(fee ?? 0),
    memo: memo ?? '',
    time: Math.floor(at / 1000),
  };
}

// A settled incoming payment, null if the row is not one (outgoing or not settled), or
// undefined if it is malformed.
function settledItem(item) {
  if (!item || typeof item !== 'object') return undefined;
  const { amount, status, payment_hash: hash, memo, time, updated_at: updated } = item;
  // A time without a zone would be read as local time and shift the cursor: refuse it.
  const zoned = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const settledAt = zoned(updated) ? Date.parse(updated) : NaN;
  const createdAt = zoned(time) ? Date.parse(time) : NaN;
  if (
    !Number.isSafeInteger(amount) ||
    typeof status !== 'string' ||
    !HEX64.test(hash ?? '') ||
    !(memo === null || memo === undefined || typeof memo === 'string') ||
    !Number.isFinite(settledAt) ||
    !Number.isFinite(createdAt)
  )
    return undefined;
  if (amount <= 0 || status !== 'success') return null;
  return { paymentHash: hash, amountMsat: amount, memo: memo ?? '', settledAt, createdAt };
}

// An incoming invoice as LNbits returns it, or undefined if it does not look like one.
function invoiceItem(item) {
  if (!item || typeof item !== 'object') return undefined;
  const { amount, bolt11, payment_hash: hash, status, memo, external_id: externalId } = item;
  const expired = Array.isArray(item.labels) && item.labels.includes('expired');
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof bolt11 !== 'string' ||
    !BOLT11.test(bolt11) ||
    !HEX64.test(hash ?? '') ||
    !['pending', 'success', 'failed'].includes(status) ||
    !(memo === null || memo === undefined || typeof memo === 'string')
  )
    return undefined;
  return {
    amountMsat: amount,
    bolt11,
    paymentHash: hash,
    status,
    memo: memo ?? '',
    externalId,
    expired,
  };
}
