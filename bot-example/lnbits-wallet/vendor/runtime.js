// Shared plumbing. The three chat handlers contain the actual bot behavior.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { randomInt } from 'node:crypto';
import WebSocket from 'ws';
import { SimplePool } from 'nostr-tools/pool';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
  nip44,
  verifyEvent,
} from 'nostr-tools';

export const now = () => Math.floor(Date.now() / 1000);
export const HEX = /^[a-f0-9]{64}$/;
export const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
export const single = (event, name) => {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 && tags[0].length === 2 ? tags[0][1] : undefined;
};
export const integer = (text) =>
  /^(0|[1-9][0-9]*)$/.test(text ?? '') && Number.isSafeInteger(Number(text))
    ? Number(text)
    : undefined;
export const newer = (a, b) =>
  !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
export const sign = (key, kind, tags, content = '', created_at = now()) =>
  finalizeEvent({ kind, tags, content, created_at }, key);
export function valid(event) {
  try {
    return (
      JSON.stringify(event).length <= 262144 &&
      Number.isSafeInteger(event.created_at) &&
      event.created_at >= 0 &&
      event.created_at <= now() + 60 &&
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
export function rumor(key, tags, content) {
  const event = { kind: 14, pubkey: getPublicKey(key), created_at: now(), tags, content };
  return { ...event, id: getEventHash(event) };
}
export function wrap(event, key, recipient, sealTags = []) {
  const encrypt = (value, secret, pubkey) =>
    nip44.v2.encrypt(JSON.stringify(value), nip44.v2.utils.getConversationKey(secret, pubkey));
  const timestamp = () => now() - randomInt(2 * 86400);
  const seal = sign(key, 13, sealTags, encrypt(event, key, recipient), timestamp());
  const ephemeral = generateSecretKey();
  return sign(
    ephemeral,
    1059,
    [['p', recipient]],
    encrypt(seal, ephemeral, recipient),
    timestamp(),
  );
}
export function unwrap(event, key) {
  if (event.kind !== 1059 || single(event, 'p') !== getPublicKey(key) || !valid(event)) return null;
  try {
    const decrypt = (outer) =>
      JSON.parse(
        nip44.v2.decrypt(outer.content, nip44.v2.utils.getConversationKey(key, outer.pubkey)),
      );
    const seal = decrypt(event);
    if (seal.kind !== 13 || !valid(seal)) return null;
    const message = decrypt(seal);
    if (
      message.sig ||
      message.pubkey !== seal.pubkey ||
      message.id !== getEventHash(message) ||
      !Number.isSafeInteger(message.created_at) ||
      message.created_at < 0 ||
      message.created_at > now() + 60
    )
      return null;
    // Anagram preserves a signed invitation's proof in its seal. Ordinary seals have no tags.
    if (message.kind !== 1014 && seal.tags.length) return null;
    return { message, seal };
  } catch {
    return null;
  }
}
export function mentions(content, pubkey) {
  for (const match of content.matchAll(
    /(?<![\p{L}\p{N}_:/?=&#.%])(?:nostr:)?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)(?![\p{L}\p{N}_])/giu,
  )) {
    try {
      const decoded = nip19.decode(match[1]);
      if ((decoded.type === 'npub' ? decoded.data : decoded.data.pubkey) === pubkey) return true;
    } catch {
      /* A malformed mention is ordinary text. */
    }
  }
  return false;
}

export class ConfigurationError extends Error {}

// One process owns an atomic, permission-restricted state file. Never silently replace a bad key.
export class State {
  constructor(directory, { nsec = '' } = {}) {
    let configuredKey;
    if (nsec.trim()) {
      try {
        const decoded = nip19.decode(nsec.trim());
        if (decoded.type !== 'nsec') throw new Error();
        configuredKey = decoded.data;
        getPublicKey(configuredKey);
      } catch {
        throw new ConfigurationError('NSEC must be a valid nsec private key.');
      }
    }
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.file = resolve(this.directory, 'state.json');
    this.lock = resolve(this.directory, 'process.lock');
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Invalid process.lock; inspect it before removing it.');
      try {
        process.kill(pid, 0);
        throw new Error('Another bot process owns this data directory.');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      unlinkSync(this.lock);
    }
    writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      if (existsSync(this.file)) {
        this.data = JSON.parse(readFileSync(this.file, 'utf8'));
        const d = this.data;
        if (
          d.version !== 1 ||
          !Number.isSafeInteger(d.startedAt) ||
          !d.groups ||
          !d.rooms ||
          !d.seen ||
          !Array.isArray(d.outbox)
        )
          throw new Error('Invalid state.json; restore your backup.');
        const decoded = nip19.decode(d.nsec);
        if (decoded.type !== 'nsec') throw new Error('Invalid saved nsec.');
        this.key = decoded.data;
        getPublicKey(this.key); // Validate the scalar too.
        if (configuredKey && nip19.nsecEncode(configuredKey) !== nip19.nsecEncode(this.key))
          throw new ConfigurationError(
            'NSEC differs from the saved identity. Use its original NSEC or a different DATA_DIR for the new account.',
          );
        chmodSync(this.file, 0o600);
      } else {
        this.key = configuredKey ?? generateSecretKey();
        this.data = {
          version: 1,
          nsec: nip19.nsecEncode(this.key),
          startedAt: now(),
          groups: {},
          rooms: {},
          seen: {},
          outbox: [],
        };
        this.save();
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  save() {
    const temp = `${this.file}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      chmodSync(temp, 0o600);
      writeFileSync(fd, JSON.stringify(this.data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
    const dir = openSync(this.directory, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  close() {
    if (existsSync(this.lock)) unlinkSync(this.lock);
  }
}

// Relay hints arrive from strangers. Permit local endpoints only when explicitly configured.
const privateRanges = new BlockList();
for (const [ip, mask] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
])
  privateRanges.addSubnet(ip, mask);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const excludedV6 = new BlockList();
excludedV6.addSubnet('2001::', 23, 'ipv6');
excludedV6.addSubnet('2002::', 16, 'ipv6');
export function publicIP(address) {
  return isIP(address) === 4
    ? !privateRanges.check(address)
    : isIP(address) === 6 && globalV6.check(address, 'ipv6') && !excludedV6.check(address, 'ipv6');
}
export function relayURLs(values, configured = []) {
  const allowed = new Set(configured.map((value) => new URL(value).href));
  return [
    ...new Set(
      values.flatMap((value) => {
        try {
          const u = new URL(value);
          const host = u.hostname.replace(/^\[|\]$/g, '');
          if (u.username || u.password || u.hash || !['ws:', 'wss:'].includes(u.protocol))
            return [];
          if (
            !allowed.has(u.href) &&
            (u.protocol !== 'wss:' ||
              (isIP(host) && !publicIP(host)) ||
              host === 'localhost' ||
              host.endsWith('.local'))
          )
            return [];
          return [u.href];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(0, 16);
}

export class Network {
  constructor(configured) {
    this.configured = relayURLs(configured, configured);
    if (!this.configured.length) throw new Error('Configure at least one RELAYS websocket URL.');
    this.closed = false;
    this.sockets = new Set();
    const sockets = this.sockets;
    const allowed = new Set(this.configured);
    this.WebSocket = class SafeWebSocket extends WebSocket {
      constructor(url) {
        const trusted = allowed.has(new URL(url).href);
        super(url, {
          maxPayload: 512 * 1024,
          handshakeTimeout: 10000,
          followRedirects: false,
          lookup(host, options, callback) {
            lookup(host, options, (error, address, family) => {
              const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
              if (!error && !trusted && addresses.some((a) => !publicIP(a)))
                return callback(new Error('Non-public relay address rejected.'));
              callback(error, address, family);
            });
          },
        });
        // nostr-tools clears ws.onerror during timeout/close cleanup. Node's ws
        // emits an asynchronous error when a connecting socket is closed, so keep
        // an EventEmitter listener attached even after that DOM handler is removed.
        // The pool still rejects the failed operation and our watcher retries it.
        this.on('error', () => {});
        sockets.add(this);
        // A half-open TCP connection may never emit close. Terminate it if a
        // WebSocket ping gets no pong, so subscriptions can reconnect promptly.
        let heartbeat, deadline;
        this.on('open', () => {
          heartbeat = setInterval(() => {
            if (this.readyState !== WebSocket.OPEN) return;
            deadline = setTimeout(() => this.terminate(), 10000);
            this.ping(undefined, undefined, (error) => {
              if (error) this.terminate();
            });
          }, 30000);
        });
        this.on('pong', () => clearTimeout(deadline));
        this.once('close', () => {
          clearInterval(heartbeat);
          clearTimeout(deadline);
          sockets.delete(this);
        });
      }
    };
    // Reopen subscriptions ourselves: NIP-59 timestamps are randomized, so a reconnect
    // cursor based on the latest outer event would silently skip some new gift wraps.
    this.pools = new Map();
    this.stops = new Set();
  }
  routes(hints = []) {
    return relayURLs([...this.configured, ...hints], this.configured);
  }
  pool(key) {
    // AUTH is connection-scoped. A group epoch must not share its authenticated
    // connection with the bot's personal inbox or another group's epoch.
    if (this.closed) throw new Error('Network is closed.');
    const id = key ? getPublicKey(key) : 'public';
    if (!this.pools.has(id))
      this.pools.set(
        id,
        new SimplePool({ websocketImplementation: this.WebSocket, enableReconnect: false }),
      );
    return this.pools.get(id);
  }
  auth(key) {
    return async (event) => finalizeEvent(event, key);
  }
  async query(relays, filter) {
    return this.pool().querySync(this.routes(relays), filter, { maxWait: 6000 });
  }
  async publish(event, relays, key) {
    await Promise.any(
      this.pool(key).publish(this.routes(relays), event, {
        maxWait: 10000,
        onauth: this.auth(key),
      }),
    );
  }
  watch(relays, filter, onEvent, key) {
    const pool = this.pool(key);
    const closers = this.routes(relays).map((url) => {
      let stopped = false,
        retry,
        current,
        attempts = 0;
      const open = async () => {
        if (stopped || this.closed) return;
        const attempt = { closed: false };
        current = attempt;
        const dispose = () => {
          attempt.closed = true;
          clearTimeout(attempt.stable);
          clearTimeout(attempt.renew);
          const sub = attempt.sub;
          attempt.sub = undefined;
          sub?.close();
        };
        attempt.dispose = dispose;
        const failed = () => {
          if (attempt.closed) return;
          dispose();
          if (!stopped && !this.closed) {
            const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6));
            retry = setTimeout(open, Math.min(60000, delay * (1 + Math.random() / 4)));
          }
        };
        try {
          const relay = await pool.ensureRelay(url, { connectionTimeout: 10000 });
          if (attempt.closed) return;
          const filters = [filter()];
          const subscribe = (authenticated = false) => {
            if (attempt.closed) return;
            attempt.sub = relay.subscribe(filters, {
              onevent: (event) => {
                if (!attempt.closed) onEvent(event);
              },
              onclose: (reason) => {
                attempt.sub = undefined;
                if (attempt.closed) return;
                if (!authenticated && reason.startsWith('auth-required:')) {
                  // Track the replacement subscription too, including when a watch
                  // is stopped while AUTH is still in flight (e.g. key rotation).
                  relay
                    .auth(this.auth(key))
                    .then(() => subscribe(true))
                    .catch(failed);
                } else failed();
              },
            });
          };
          subscribe();
          // EOSE can be synthetic on failure. Only a stable connection resets backoff.
          attempt.stable = setTimeout(() => {
            attempts = 0;
          }, 30000);
          // Periodically replay bounded history if a relay stops streaming new events.
          attempt.renew = setTimeout(() => {
            dispose();
            void open();
          }, 5 * 60000);
        } catch {
          failed();
        }
      };
      void open();
      return () => {
        stopped = true;
        clearTimeout(retry);
        current?.dispose();
      };
    });
    const stop = () => {
      closers.forEach((close) => close());
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }
  close() {
    this.closed = true;
    for (const stop of [...this.stops]) stop();
    for (const pool of this.pools.values()) pool.destroy();
    for (const socket of this.sockets) socket.terminate();
    this.pools.clear();
  }
}
