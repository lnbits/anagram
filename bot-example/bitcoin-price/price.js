// Bitcoin price retrieval: one fixed URL, validated JSON, a short cache and no user input.
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ConfigurationError, publicIP } from './runtime.js';

export const DEFAULT_PRICE_URL = 'https://mempool.space/api/v1/prices';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const RETRY_AFTER_FAILURE_MS = 10000;
// The oldest price ever shown, and so the longest a price may be cached: a cached price
// older than this would be treated as fresh yet never shown.
export const MAX_PRICE_AGE_SECONDS = 300;

// PRICE_CACHE_SECONDS from the environment. Unset or blank uses the default; anything else
// must be a whole number of seconds from 0 to 300. Forms like "1e2" or "0x10" are refused.
export function parseCacheSeconds(value, fallback = 60) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!/^[0-9]{1,4}$/.test(text) || Number(text) > MAX_PRICE_AGE_SECONDS)
    throw new ConfigurationError(
      `PRICE_CACHE_SECONDS must be a whole number from 0 to ${MAX_PRICE_AGE_SECONDS}.`,
    );
  return Number(text);
}

// The URL comes from the operator's configuration, never from a chat message.
export function priceURL(value, allowHttp = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('PRICE_URL must be a valid URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.hash)
    throw new ConfigurationError('PRICE_URL must not contain credentials or a fragment.');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))
    throw new ConfigurationError('PRICE_URL must use HTTPS. Set PRICE_ALLOW_HTTP=1 for local use.');
  // Names are checked again against their resolved addresses in httpGet. IP literals skip
  // DNS entirely, so they must be checked here.
  if (
    !allowHttp &&
    ((isIP(host) && !publicIP(host)) || host === 'localhost' || host.endsWith('.local'))
  )
    throw new ConfigurationError(
      'PRICE_URL points at a local or private address. Set PRICE_ALLOW_HTTP=1 to allow it.',
    );
  return url.href;
}

// GET a small response body. Redirects are not followed: any non-200 status is a failure.
// The DNS lookup hook runs for the connection actually used, so a name that later
// resolves to a private address (DNS rebinding) is rejected unless local use is allowed.
export function httpGet(url, { allowLocal = false, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'https:' ? https : http;
    const request = client.get(
      url,
      {
        headers: { accept: 'application/json', 'user-agent': 'anagram-bitcoin-price-bot' },
        signal: AbortSignal.timeout(timeout),
        lookup(host, options, callback) {
          lookup(host, options, (error, address, family) => {
            const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
            if (!error && !allowLocal && addresses.some((a) => !publicIP(a)))
              return callback(new Error('Non-public price provider address rejected.'));
            callback(error, address, family);
          });
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Price provider returned HTTP ${response.statusCode}.`));
          return;
        }
        // Count raw bytes: a string length would let multi-byte text exceed the limit.
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            reject(new Error('Price provider response is too large.'));
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        // Also covers a timeout or reset in the middle of the body. A settled promise ignores this.
        response.on('close', () => reject(new Error('Price provider connection closed.')));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
  });
}

// mempool.space answers {"time":1700000000,"USD":67123,"EUR":58234,...}. Every three-letter
// uppercase key is a currency. One bad price rejects the whole response.
export function parsePrices(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Price response is not an object.');
  const prices = new Map();
  for (const [key, value] of Object.entries(data)) {
    if (!/^[A-Z]{3}$/.test(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1e12)
      throw new Error('Price response contains an invalid price.');
    prices.set(key, value);
  }
  if (!prices.size) throw new Error('Price response contains no prices.');
  return prices;
}

export class PriceFeed {
  constructor({
    url = DEFAULT_PRICE_URL,
    allowHttp = false,
    cacheSeconds = 60,
    staleSeconds = MAX_PRICE_AGE_SECONDS,
    fetchText,
    // A monotonic clock: cache ages must not jump when the system clock is corrected.
    now = () => performance.now(),
    log = console.log,
  } = {}) {
    if (
      !Number.isInteger(cacheSeconds) ||
      cacheSeconds < 0 ||
      cacheSeconds > MAX_PRICE_AGE_SECONDS
    )
      throw new ConfigurationError(
        `PRICE_CACHE_SECONDS must be a whole number from 0 to ${MAX_PRICE_AGE_SECONDS}.`,
      );
    // A price still cached but too old to show would make every reply "unavailable".
    if (!Number.isFinite(staleSeconds) || staleSeconds < cacheSeconds)
      throw new ConfigurationError('The stale price window must not be shorter than the cache.');
    this.url = priceURL(url, allowHttp);
    this.fetchText = fetchText ?? ((u) => httpGet(u, { allowLocal: allowHttp }));
    this.cacheMs = cacheSeconds * 1000;
    this.staleMs = staleSeconds * 1000;
    this.now = now;
    this.log = log;
    this.cache = undefined;
    this.inflight = undefined;
    this.failedAt = undefined;
  }

  // Never throws. Returns { prices, ageSeconds, stale } or null when nothing usable exists.
  async get() {
    let fresh = Boolean(this.cache) && this.now() - this.cache.at < this.cacheMs;
    if (!fresh) {
      // One request serves every waiting caller. After a failure, wait a few seconds
      // before asking again so an outage cannot stall the message queue on every message.
      const backingOff =
        this.failedAt !== undefined && this.now() - this.failedAt < RETRY_AFTER_FAILURE_MS;
      if (!this.inflight && !backingOff)
        this.inflight = this.refresh().finally(() => {
          this.inflight = undefined;
        });
      if (this.inflight) fresh = await this.inflight;
    }
    const age = this.cache ? this.now() - this.cache.at : Infinity;
    if (age > this.staleMs) return null;
    return {
      prices: this.cache.prices,
      ageSeconds: Math.max(0, Math.floor(age / 1000)),
      stale: !fresh,
    };
  }

  // Resolves to true when new data was stored. A failure keeps the previous cache.
  async refresh() {
    try {
      this.cache = { prices: parsePrices(await this.fetchText(this.url)), at: this.now() };
      this.failedAt = undefined;
      return true;
    } catch (error) {
      // Log only the reason, never the URL: an operator's PRICE_URL may contain a token.
      // Anything can be thrown, including null, so read it defensively.
      const reason = typeof error?.code === 'string' ? error.code : String(error?.message ?? error);
      this.log(`Price provider request failed: ${reason.slice(0, 100)}`);
      this.failedAt = this.now();
      return false;
    }
  }
}
