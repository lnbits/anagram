// The self-service connection page, behind a TLS-terminating reverse proxy. It listens on
// loopback only; CONNECT_PUBLIC_URL is the address people see.
//
// Holding a link is never enough to connect a wallet:
//   1. /connect gives a one-time link. Its token (hashed here, ten minutes, one use) opens a
//      session bound to the requester's Nostr account.
//   2. The person enters an LNbits address and invoice key. They are checked, and kept in
//      memory only. Admin keys are refused.
//   3. The bot sends a code in an encrypted DM to that account. Typing it on the page proves
//      the person at the browser can read that account's messages. Only then is the
//      connection made and the credential encrypted and stored.
// So a leaked link gives no code, and a link someone else sent you gets the code to them, not
// to you, while the credentials stay in your browser's session: neither side can finish on
// its own. What this cannot stop is someone who sends you their link AND talks you through
// typing the code they received. The page names the account at each step and warns about it.
//
// Everything here is in memory, on purpose: a restart cancels whatever was unfinished, and
// nothing unconfirmed is ever on disk. Nothing from a request body is logged.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { nip19 } from 'nostr-tools';
import { formatMsat, sanitizeMemo, walletName } from './commands.js';
import { PAGE, SCRIPT, STYLE } from './connect-page.js';
import { LNbitsError } from './lnbits.js';
import { GuardError } from './net-guard.js';
import { NwcError, parseConnection } from './nwc.js';
import { StoreError } from './store.js';
import { LNBITS_KEY } from './wallets.js';
import { ConfigurationError } from './vendor/runtime.js';

const MINUTE = 60000;
// What a connection is shown to allow, in the page's words.
const PERMISSION = {
  pay_invoice: 'Pay Lightning invoices, after you confirm each one in your chat',
  get_balance: 'Read your balance',
  make_invoice: 'Create invoices to receive',
  lookup_invoice: 'Check the status of an invoice or payment',
  list_transactions: 'Read your transaction history',
  get_budget: 'Read the spending limit set in your wallet',
  get_info: 'Read basic details of the wallet connection',
};
const limitText = ({ totalMsat, usedMsat }) =>
  `Spending limit set in your wallet: ${formatMsat(totalMsat)}, of which ${formatMsat(usedMsat)} is used.`;
const MAX_BODY = 4096;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const digest = (text) => createHash('sha256').update(text).digest();
const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// Forgiving when typed: case, separators and the letters people confuse with digits.
const normalCode = (text) =>
  String(text ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
function newCode() {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code = CROCKFORD[Number(bits & 31n)] + code;
    bits >>= 5n;
  }
  return code;
}
// Shown in chat, on buttons and in payment previews: plain words only.
const cleanLabel = (value) => (typeof value === 'string' ? sanitizeMemo(value).slice(0, 40) : '');
const readable = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

// What the page says about a failure. Failures that could reveal a private network all read
// the same, so the page cannot be used to probe one.
const MESSAGE = {
  bad_request: 'That request could not be understood. Please reload the page.',
  forbidden: 'This request was refused. Please reload the page.',
  session: 'This page has expired. Send /connect in your chat with the bot for a new link.',
  token:
    'This link has expired or was already used. Send /connect in your chat with the bot for a new one.',
  busy: 'Too many attempts. Please wait a few minutes and try again.',
  url: 'That LNbits address cannot be used. It must be a public https:// address, like https://lnbits.example.',
  not_allowed: 'This bot does not connect to that LNbits server. Please ask its operator.',
  key_format: 'That does not look like an LNbits key: it should be 32 letters and numbers.',
  unreachable:
    'That LNbits server could not be reached or did not answer as expected. Check the address and try again.',
  rejected: 'LNbits did not accept that key. Check that you copied the Invoice key of this wallet.',
  admin_key:
    'That is an Admin key, which can spend your funds. It was not saved. Use the Invoice key instead.',
  duplicate: 'That wallet cannot be connected: it is already connected to an account.',
  limit: 'You have reached the limit of connected wallets. Disconnect one with /wallets first.',
  full: 'This bot cannot take more wallets right now. Please ask its operator.',
  code: 'That code is not right. Check your chat with the bot and try again.',
  code_expired:
    'That code has expired, so nothing was connected. Send /connect in your chat for a new link.',
  no_pending: 'Enter your wallet details first.',
  nwc_format:
    'That does not look like a connection string. It starts with nostr+walletconnect:// and comes from your wallet.',
  nwc_relay:
    'That connection uses a relay that cannot be used here. It must be a public wss:// relay.',
  nwc_spending:
    'That connection is allowed to do more than receive, such as spending your funds, so it was refused and not saved. Create a new connection in your wallet that can only read your balance and history and create invoices.',
  nwc_extra:
    'That connection can do more than this bot allows, such as paying without an invoice, so it was refused and not saved. Create a new connection in your wallet that can pay and look up invoices, and read its balance, history and spending limit.',
  nwc_methods:
    'That connection cannot do everything this needs. To receive, allow it to read your balance or history, or create invoices. To send, allow it to pay and look up invoices.',
  nwc_encryption: 'That wallet does not offer the encryption this bot requires (NIP-44).',
  nwc_unreachable:
    'That wallet did not answer through the relay in its connection string. Check that the wallet is online and the connection is still valid, and try again.',
  nwc_budget:
    'I could not confirm a spending limit on that connection. Set a budget for it in your wallet first, so that the wallet itself limits what can be spent. Some wallets cannot report one, and this bot does not accept those.',
  nwc_acknowledge: 'Please confirm that you understand this connection can spend your funds.',
};

export class ConnectService {
  #tokens = new Map();
  #sessions = new Map();
  constructor({
    publicUrl,
    host = '127.0.0.1',
    port = 8787,
    allowHttpLocal = false,
    origins,
    // The NWC client, if the operator enabled NWC connections.
    nwc,
    // Whether connections that can spend are offered (the experimental /send).
    sending = false,
    registry,
    sendCode,
    finished,
    log = () => {},
    clock = Date.now,
    tokenMs = 10 * MINUTE,
    sessionMs = 15 * MINUTE,
    codeMs = 5 * MINUTE,
    linksPerHour = 5,
  }) {
    const url = new URL(publicUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(allowHttpLocal && loopback))
      throw new ConfigurationError('CONNECT_PUBLIC_URL must use HTTPS.');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new ConfigurationError(
        'CONNECT_PUBLIC_URL must be just an address, like https://connect.example.',
      );
    if (!['127.0.0.1', '::1', 'localhost'].includes(host))
      throw new ConfigurationError(
        'The connection page listens on this computer only: put a reverse proxy in front.',
      );
    this.url = url;
    this.secure = url.protocol === 'https:';
    this.host = host;
    this.port = port;
    this.origins = origins;
    this.nwc = nwc;
    this.sending = sending;
    this.registry = registry;
    this.sendCode = sendCode;
    this.finished = finished;
    this.log = log;
    this.clock = clock;
    this.tokenMs = tokenMs;
    this.sessionMs = sessionMs;
    this.codeMs = codeMs;
    this.linksPerHour = linksPerHour;
    this.issued = new Map();
    this.server = http.createServer((req, res) => void this.#handle(req, res));
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    this.server.maxRequestsPerSocket = 100;
    this.sweeper = setInterval(() => this.#sweep(), MINUTE);
    this.sweeper.unref?.();
  }
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve(this.server.address().port);
      });
    });
  }
  close() {
    clearInterval(this.sweeper);
    for (const session of this.#sessions.values()) session.pending = undefined;
    this.#sessions.clear();
    this.#tokens.clear();
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // A one-time link for this account, or null over the limit. Only the bot calls this, for
  // the authenticated sender of a /connect.
  issue(owner) {
    const time = this.clock();
    const recent = (this.issued.get(owner) ?? []).filter((t) => t > time - 60 * MINUTE);
    if (recent.length >= this.linksPerHour || this.#tokens.size >= 2000) return null;
    recent.push(time);
    this.issued.set(owner, recent);
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(digest(token).toString('hex'), { owner, expires: time + this.tokenMs });
    return `${this.url.origin}/c#${token}`;
  }

  // Whole minutes until this account can have another link, if it has used them all.
  linkWait(owner) {
    const time = this.clock();
    const recent = (this.issued.get(owner) ?? []).filter((t) => t > time - 60 * MINUTE);
    if (recent.length < this.linksPerHour) return undefined;
    return Math.ceil((recent[0] + 60 * MINUTE - time) / MINUTE);
  }

  #sweep() {
    const time = this.clock();
    for (const [key, token] of this.#tokens) if (token.expires <= time) this.#tokens.delete(key);
    for (const [key, session] of this.#sessions)
      if (session.expires <= time) {
        session.pending = undefined;
        this.#sessions.delete(key);
      }
    for (const [owner, times] of this.issued) {
      const recent = times.filter((t) => t > time - 60 * MINUTE);
      if (recent.length) this.issued.set(owner, recent);
      else this.issued.delete(owner);
    }
  }

  #headers(extra = {}) {
    return {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      ...(this.secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
      ...extra,
    };
  }
  #send(res, status, type, body, extra) {
    res.writeHead(status, this.#headers({ 'content-type': type, ...extra }));
    res.end(body);
  }
  #json(res, status, data, extra) {
    this.#send(res, status, 'application/json', JSON.stringify(data), extra);
  }
  #fail(res, status, code) {
    this.#json(res, status, { error: code, message: MESSAGE[code] });
  }

  async #handle(req, res) {
    try {
      // A page reached through another name (DNS rebinding) is refused: its Host is wrong.
      if (req.headers.host !== this.url.host) return this.#fail(res, 421, 'forbidden');
      const path = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET') {
        if (path === '/c') return this.#send(res, 200, 'text/html; charset=utf-8', PAGE);
        if (path === '/c/app.js')
          return this.#send(res, 200, 'text/javascript; charset=utf-8', SCRIPT);
        if (path === '/c/app.css') return this.#send(res, 200, 'text/css; charset=utf-8', STYLE);
        return this.#send(res, 404, 'text/plain', 'Not found.');
      }
      if (req.method !== 'POST')
        return this.#send(res, 405, 'text/plain', 'Not allowed.', { allow: 'GET, POST' });
      const route = {
        '/c/session': 'session',
        '/c/lnbits': 'lnbits',
        '/c/nwc': 'nwc',
        '/c/code': 'code',
        '/c/cancel': 'cancel',
      }[path];
      if (!route) return this.#send(res, 404, 'text/plain', 'Not found.');
      // Cross-site requests cannot set this content type or pass these checks.
      if (
        req.headers.origin !== this.url.origin ||
        !(req.headers['content-type'] ?? '').startsWith('application/json') ||
        !['same-origin', undefined].includes(req.headers['sec-fetch-site'])
      )
        return this.#fail(res, 403, 'forbidden');
      const body = await this.#body(req);
      if (body === undefined) return this.#fail(res, 400, 'bad_request');
      if (route === 'session') return this.#openSession(res, body);
      const session = this.#session(req);
      if (!session) return this.#fail(res, 401, 'session');
      if (
        !sameBytes(
          Buffer.from(String(req.headers['x-csrf-token'] ?? '')),
          Buffer.from(session.csrf),
        )
      )
        return this.#fail(res, 403, 'forbidden');
      if (route === 'lnbits') return await this.#lnbits(res, session, body);
      if (route === 'nwc') return await this.#nwc(res, session, body);
      if (route === 'code') return this.#code(res, session, body);
      this.#end(session);
      return this.#json(res, 200, { ok: true });
    } catch (error) {
      this.log(`The connection page hit an error (${error?.code ?? error?.name ?? 'unknown'}).`);
      if (!res.headersSent)
        this.#json(res, 500, { error: 'bad_request', message: MESSAGE.bad_request });
      else res.destroy();
    }
  }
  #body(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          resolve(undefined);
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('error', () => resolve(undefined));
      req.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  #openSession(res, body) {
    const time = this.clock();
    // No throttle on wrong tokens: at 256 bits there is nothing to guess, and one would let
    // anyone lock everyone else out.
    this.#sweep();
    const key = digest(String(body.token ?? '')).toString('hex');
    const token = this.#tokens.get(key);
    // Single use: gone from here on, whatever happens next.
    this.#tokens.delete(key);
    if (!token || token.expires <= time) return this.#fail(res, 401, 'token');
    if (this.#sessions.size >= 2000) return this.#fail(res, 429, 'busy');
    const id = randomBytes(32).toString('base64url');
    const session = {
      owner: token.owner,
      csrf: randomBytes(32).toString('base64url'),
      expires: time + this.sessionMs,
      tries: 0,
    };
    this.#sessions.set(digest(id).toString('hex'), session);
    const cookie = this.secure
      ? `__Host-alw=${id}; Path=/; Secure; HttpOnly; SameSite=Strict`
      : `alw=${id}; Path=/; HttpOnly; SameSite=Strict`;
    return this.#json(
      res,
      200,
      {
        csrf: session.csrf,
        account: nip19.npubEncode(token.owner),
        kinds: [
          { id: 'lnbits', label: 'LNbits wallet (receive only)' },
          ...(this.nwc ? [{ id: 'nwc', label: 'Nostr Wallet Connect, receive only' }] : []),
          ...(this.nwc && this.sending
            ? [{ id: 'nwc', spend: true, label: 'Nostr Wallet Connect, can send payments' }]
            : []),
        ],
      },
      { 'set-cookie': cookie },
    );
  }
  #session(req) {
    const name = this.secure ? '__Host-alw' : 'alw';
    const id = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .find(([key]) => key === name)?.[1];
    if (!id) return undefined;
    const session = this.#sessions.get(digest(id).toString('hex'));
    if (!session) return undefined;
    if (session.expires > this.clock()) return session;
    this.#end(session);
    return undefined;
  }
  // Ends a session and forgets anything it held.
  #end(session) {
    session.pending = undefined;
    for (const [key, value] of this.#sessions) if (value === session) this.#sessions.delete(key);
  }

  async #lnbits(res, session, body) {
    if (++session.tries > 6) {
      this.#end(session);
      return this.#fail(res, 429, 'busy');
    }
    let origin;
    try {
      origin = this.origins.check(body.url);
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
      return this.#fail(res, 400, error.reason === 'not_allowed' ? 'not_allowed' : 'url');
    }
    const invoiceKey = String(body.invoiceKey ?? '').trim();
    if (!LNBITS_KEY.test(invoiceKey)) return this.#fail(res, 400, 'key_format');
    const label = cleanLabel(body.label);
    const secret = { invoiceKey };
    const refused = this.#refusal(session.owner, 'lnbits', origin, secret);
    if (refused) return this.#fail(res, 400, refused);
    try {
      await this.origins.client(origin).wallet(invoiceKey);
    } catch (error) {
      if (!(error instanceof LNbitsError)) throw error;
      if (error.code === 'admin_key') return this.#fail(res, 400, 'admin_key');
      return this.#fail(res, 400, error.code === 'rejected' ? 'rejected' : 'unreachable');
    }
    return this.#askForCode(res, session, {
      kind: 'lnbits',
      origin,
      label,
      secret,
      host: new URL(origin).host,
    });
  }
  async #nwc(res, session, body) {
    if (!this.nwc) return this.#fail(res, 404, 'bad_request');
    if (++session.tries > 6) {
      this.#end(session);
      return this.#fail(res, 429, 'busy');
    }
    let secret;
    try {
      secret = parseConnection(body.connection, { trustedRelays: [...this.nwc.trusted] });
    } catch (error) {
      if (!(error instanceof NwcError)) throw error;
      return this.#fail(res, 400, error.code === 'relay' ? 'nwc_relay' : 'nwc_format');
    }
    const spend = body.spend === true;
    if (spend && !this.sending) return this.#fail(res, 400, 'nwc_spending');
    if (spend && body.acknowledged !== true) return this.#fail(res, 400, 'nwc_acknowledge');
    if (spend) secret.scope = 'spend';
    const origin = `nwc:${secret.walletPubkey}`;
    const refused = this.#refusal(session.owner, 'nwc', origin, secret);
    if (refused) return this.#fail(res, 400, refused);
    let details;
    try {
      details = await this.nwc.inspect(secret);
    } catch (error) {
      if (error instanceof NwcError)
        return this.#fail(
          res,
          400,
          spend && error.code === 'spending' ? 'nwc_extra' : `nwc_${error.code}`,
        );
      if (!(error instanceof LNbitsError)) throw error;
      return this.#fail(res, 400, 'nwc_unreachable');
    }
    // Always a name: a preview must say which wallet pays.
    const label =
      cleanLabel(body.label) ||
      cleanLabel(details.alias) ||
      `Wallet ${secret.walletPubkey.slice(0, 8)}`;
    return this.#askForCode(res, session, {
      kind: 'nwc',
      origin,
      label,
      secret,
      host: spend
        ? 'Nostr Wallet Connect, can send payments'
        : 'Nostr Wallet Connect, receive only',
      permissions: details.methods.flatMap((m) => PERMISSION[m] ?? []),
      ...(spend ? { limit: limitText(details.budget) } : {}),
    });
  }
  async #askForCode(res, session, { kind, origin, label, secret, host, permissions, limit }) {
    const name = walletName({ label, origin }) || 'Wallet';
    const code = newCode();
    session.pending = {
      kind,
      origin,
      label,
      secret,
      code: digest(code),
      expires: this.clock() + this.codeMs,
      attempts: 0,
    };
    await this.sendCode(session.owner, { name, host, code: readable(code) });
    return this.#json(res, 200, {
      state: 'code',
      name,
      ...(permissions ? { permissions } : {}),
      ...(limit ? { limit } : {}),
    });
  }
  #refusal(owner, kind, origin, secret) {
    try {
      this.registry.canConnect({ owner, kind, origin, secret });
      return undefined;
    } catch (error) {
      if (error instanceof StoreError) return error.code;
      throw error;
    }
  }
  #code(res, session, body) {
    const { pending } = session;
    if (!pending) return this.#fail(res, 400, 'no_pending');
    if (pending.expires <= this.clock()) {
      this.#end(session);
      return this.#fail(res, 400, 'code_expired');
    }
    if (!sameBytes(digest(normalCode(body.code)), pending.code)) {
      // Five wrong tries end it: forty bits are not guessable at five tries per session.
      if (++pending.attempts >= 5) {
        this.#end(session);
        return this.#fail(res, 429, 'busy');
      }
      return this.#fail(res, 400, 'code');
    }
    const { owner } = session;
    let connection;
    try {
      connection = this.registry.connect({
        owner,
        kind: pending.kind,
        source: 'self',
        label: pending.label,
        origin: pending.origin,
        secret: pending.secret,
        actor: 'user',
      });
    } catch (error) {
      this.#end(session);
      if (!(error instanceof StoreError)) throw error;
      return this.#fail(res, 400, error.code);
    }
    this.#end(session);
    this.log(`${nip19.npubEncode(owner)} connected a wallet.`);
    this.finished(owner, connection);
    return this.#json(res, 200, { ok: true });
  }
}
