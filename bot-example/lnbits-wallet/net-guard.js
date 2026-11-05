// Reaching a server a person named. An LNbits URL typed on the connection page must not turn
// the bot into a way to reach anything private: the operator's network, localhost, a cloud
// metadata service. So unless the operator listed an origin themselves:
//   - HTTPS on port 443 only, no credentials, query or fragment, and a real host name;
//   - every address the name resolves to must be public, checked at connection time, and the
//     connection goes to one of those addresses: DNS rebinding finds no second lookup to use;
//   - redirects are never followed (lnbits.js treats them as an unexpected answer).
import { lookup as dnsLookup } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { LNbitsClient, LNbitsError } from './lnbits.js';
import { lnbitsURL } from './config.js';
import { ConfigurationError, publicIP } from './vendor/runtime.js';

const MAX_CLIENTS = 2000;

export class GuardError extends Error {
  constructor(reason) {
    super('That address cannot be used.');
    this.code = 'EGUARD';
    this.reason = reason;
  }
}

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, '');

// A base URL a person typed, normalized. Throws GuardError unless it could be a public server.
export function publicOrigin(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    throw new GuardError('invalid');
  }
  if (url.protocol !== 'https:') throw new GuardError('https');
  if (url.username || url.password || url.search || url.hash) throw new GuardError('parts');
  if (url.port && url.port !== '443') throw new GuardError('port');
  const host = hostOf(url).toLowerCase();
  // An address written out is never a real instance name, and connecting to one would skip
  // the lookup below entirely.
  if (isIP(host)) throw new GuardError('address');
  if (
    !host.includes('.') ||
    host.endsWith('.') ||
    /\.(?:localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(host)
  )
    throw new GuardError('host');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}

// For net.connect and ws: every address must pass, and only those addresses are returned.
export function guardedLookup({ resolve = dnsLookup, allowed = publicIP } = {}) {
  return (host, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const wanted = typeof options === 'function' ? {} : options;
    resolve(host, { ...wanted, all: true }, (error, addresses) => {
      if (error) return done(error);
      if (!addresses.length || addresses.some((a) => !allowed(a.address)))
        return done(new GuardError('private'));
      if (wanted.all) return done(null, addresses);
      done(null, addresses[0].address, addresses[0].family);
    });
  };
}

// The part of fetch() lnbits.js uses, over a connection that went through guardedLookup.
export function guardedFetch({ lookup = guardedLookup(), request = https.request, port } = {}) {
  return (href, { method = 'GET', headers = {}, body, signal } = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(href);
      if (isIP(hostOf(url))) return reject(new GuardError('address'));
      const req = request({
        hostname: hostOf(url),
        port: port ?? (url.port || 443),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, host: url.host },
        lookup,
        agent: false,
        signal,
      });
      req.on('response', (res) => resolve({ status: res.statusCode, body: Readable.toWeb(res) }));
      req.on('error', (error) => reject(signal?.aborted ? signal.reason : error));
      req.end(body);
    });
}

// For a stored connection whose server the operator no longer allows: its commands get the
// usual "not reachable" answer, and nothing is sent anywhere.
const refuse = async () => {
  throw new LNbitsError('unavailable', { definite: true });
};
const REFUSING = {
  wallet: refuse,
  payments: refuse,
  createInvoice: refuse,
  findInvoices: refuse,
  incoming: refuse,
};

// Which LNbits servers people may connect to, and a client for each. LNBITS_URL and any
// origin the operator listed are trusted as they are (they may be private). "*" also allows
// any public server, through the guard above.
export class Origins {
  #clients = new Map();
  constructor({
    defaultUrl,
    allowHttp = false,
    allowed = '',
    timeoutMs = 10000,
    defaultClient,
    guard = {},
  }) {
    this.allowHttp = allowHttp;
    this.timeoutMs = timeoutMs;
    this.guard = guard;
    const items = String(allowed)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    this.any = items.includes('*');
    this.trusted = new Set([
      lnbitsURL(defaultUrl, allowHttp),
      ...items.filter((item) => item !== '*').map((item) => lnbitsURL(item, allowHttp)),
    ]);
    if (defaultClient) this.#clients.set(lnbitsURL(defaultUrl, allowHttp), defaultClient);
  }
  // The normalized origin of what a person typed. Throws GuardError if it may not be used.
  check(text) {
    let url;
    try {
      url = lnbitsURL(text, this.allowHttp);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      throw new GuardError('invalid');
    }
    if (this.trusted.has(url)) return url;
    if (!this.any) throw new GuardError('not_allowed');
    return publicOrigin(text);
  }
  // A client per origin, so one slow server only uses its own request slots.
  client(origin) {
    let client = this.#clients.get(origin);
    if (client) return client;
    if (this.trusted.has(origin))
      client = new LNbitsClient({ url: origin, timeoutMs: this.timeoutMs });
    else {
      if (!this.any) return REFUSING;
      let url;
      try {
        url = publicOrigin(origin);
      } catch (error) {
        if (!(error instanceof GuardError)) throw error;
        return REFUSING;
      }
      const lookup = guardedLookup(this.guard);
      client = new LNbitsClient({
        url,
        timeoutMs: this.timeoutMs,
        fetch: guardedFetch({ lookup, ...this.guard }),
        socketOptions: { lookup },
      });
    }
    // Bounded: refused attempts can name any number of servers. Connections keep their client.
    if (this.#clients.size >= MAX_CLIENTS) this.#clients.delete(this.#clients.keys().next().value);
    this.#clients.set(origin, client);
    return client;
  }
}
