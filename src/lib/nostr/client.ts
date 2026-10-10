import { paceRelayRequests } from '#src/lib/nostr/relayPacing.ts';
import { normalizeRumor } from '#src/lib/nostr/normalizeRumor.ts';
import { guardRelayAuthentication } from '#src/lib/nostr/relayAuthentication.ts';
import { unwrapInWorker } from './cryptoWorker';
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  verifyEvent,
  nip19,
  nip04,
  nip44,
  nip05,
  type Event,
  type VerifiedEvent,
  type EventTemplate,
  type Filter,
} from 'nostr-tools';
import { BunkerSigner, type BunkerPointer } from 'nostr-tools/nip46';
import { normalizeURL } from 'nostr-tools/utils';
export { nip19 };
export type NostrEvent = EventTemplate & { pubkey: string; id?: string; sig?: string };
export type NostrFilter = Filter;
export type NostrUserProfile = Record<string, any>;
export type NostrRelayInformation = Record<string, any>;
export type NostrRelayConnectionStats = {
  attempts: number;
  success: number;
  durations: number[];
  connectedAt?: number;
  nextReconnectAt?: number;
  validationRatio?: number;
};
export const NostrKind = {
  Metadata: 0,
  EventDeletion: 5,
  Reaction: 7,
  PrivateDirectMessage: 14,
  GiftWrapSeal: 13,
  GiftWrap: 1059,
  RelayList: 10002,
  DirectMessageReceiveRelayList: 10050,
  PrivateStorageRelayList: 10013,
  FollowSet: 30000,
} as const;
export enum NostrRelayStatus {
  DISCONNECTED = 0,
  CONNECTING = 1,
  RECONNECTING = 2,
  CONNECTED = 5,
  AUTH = 6,
  AUTH_REQUESTED = 6,
  AUTHENTICATING = 7,
  AUTHENTICATED = 8,
}
export enum NostrSubscriptionCacheUsage {
  ONLY_RELAY = 'ONLY_RELAY',
}
export function normalizeRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol))
    throw new Error('Invalid relay protocol');
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  return normalizeURL(url.href);
}
export const isValidPubkey = (value: string) => /^[0-9a-f]{64}$/i.test(value);
export const isValidNip05 = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
export const serializeProfile = (profile: NostrUserProfile) => JSON.stringify(profile);
const hex = (value: Uint8Array) =>
  Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
function bytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid secret key');
  return Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
}
class Emitter {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(name: string, fn: (...args: any[]) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
    return this;
  }
  once(name: string, fn: (...args: any[]) => void) {
    const once = (...args: any[]) => {
      this.off(name, once);
      fn(...args);
    };
    return this.on(name, once);
  }
  off(name: string, fn: (...args: any[]) => void) {
    this.listeners.get(name)?.delete(fn);
    return this;
  }
  emit(name: string, ...args: any[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
  removeAllListeners() {
    this.listeners.clear();
  }
}
// Never expose third-party signer/crypto exceptions containing input or plaintext.
async function privateOperation<T>(operation: () => T | Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}
function parsePrivateJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Invalid encrypted message payload');
  }
}
export interface NostrSigner {
  pubkey: string;
  user(): Promise<NostrUser>;
  blockUntilReady(): Promise<NostrUser>;
  sign(event: NostrEvent): Promise<string>;
  encrypt(user: NostrUser, value: string, scheme?: 'nip04' | 'nip44'): Promise<string>;
  decrypt(user: NostrUser, value: string, scheme?: 'nip04' | 'nip44'): Promise<string>;
}
export class NostrPrivateKeySigner implements NostrSigner {
  readonly privateKey: string;
  readonly pubkey: string;
  readonly secretKey: Uint8Array;
  constructor(
    key?: string | Uint8Array,
    public ndk?: NostrClient,
  ) {
    const decoded =
      typeof key === 'string' && key.startsWith('nsec') ? nip19.decode(key).data : key;
    this.secretKey =
      decoded instanceof Uint8Array
        ? decoded
        : typeof decoded === 'string'
          ? bytes(decoded)
          : generateSecretKey();
    this.privateKey = hex(this.secretKey);
    this.pubkey = getPublicKey(this.secretKey);
    Object.defineProperty(this, 'privateKey', { enumerable: false });
    Object.defineProperty(this, 'secretKey', { enumerable: false });
  }
  toJSON() {
    return { pubkey: this.pubkey };
  }
  static generate() {
    return new NostrPrivateKeySigner();
  }
  async user() {
    const user = new NostrUser({ pubkey: this.pubkey });
    user.ndk = this.ndk;
    return user;
  }
  blockUntilReady() {
    return this.user();
  }
  async sign(event: NostrEvent) {
    return privateOperation(() => finalizeEvent(event, this.secretKey).sig, 'Unable to sign event');
  }
  async encrypt(user: NostrUser, value: string, scheme = 'nip44') {
    return privateOperation(
      () =>
        scheme === 'nip04'
          ? nip04.encrypt(this.secretKey, user.pubkey, value)
          : nip44.v2.encrypt(value, nip44.v2.utils.getConversationKey(this.secretKey, user.pubkey)),
      'Unable to encrypt private content',
    );
  }
  async decrypt(user: NostrUser, value: string, scheme = 'nip44') {
    return privateOperation(
      () =>
        scheme === 'nip04'
          ? nip04.decrypt(this.secretKey, user.pubkey, value)
          : nip44.v2.decrypt(value, nip44.v2.utils.getConversationKey(this.secretKey, user.pubkey)),
      'Unable to decrypt private content',
    );
  }
}
export class NostrNip07Signer implements NostrSigner {
  pubkey = '';
  constructor(
    _?: unknown,
    public ndk?: NostrClient,
  ) {}
  private extension(): any {
    const ext = (globalThis as any).nostr;
    if (!ext) throw new Error('Install a NIP-07 signer extension');
    return ext;
  }
  async user() {
    this.pubkey = await this.extension().getPublicKey();
    return new NostrUser({ pubkey: this.pubkey });
  }
  blockUntilReady() {
    return this.user();
  }
  async sign(event: NostrEvent) {
    const signed = await privateOperation(
      () => this.extension().signEvent(event),
      'Unable to sign event',
    );
    if (!verifyEvent(signed) || signed.id !== getEventHash(event))
      throw new Error('Signer returned an invalid event');
    return signed.sig;
  }
  async encrypt(user: NostrUser, value: string, scheme = 'nip44') {
    return privateOperation(
      () => this.extension()[scheme].encrypt(user.pubkey, value),
      'Unable to encrypt private content',
    );
  }
  async decrypt(user: NostrUser, value: string, scheme = 'nip44') {
    return privateOperation(
      () => this.extension()[scheme].decrypt(user.pubkey, value),
      'Unable to decrypt private content',
    );
  }
}
export class NostrNip46Signer extends Emitter implements NostrSigner {
  pubkey = '';
  bunkerPubkey = '';
  relayUrls: string[] = [];
  localSigner = NostrPrivateKeySigner.generate();
  nostrConnectSecret = '';
  nostrConnectUri = '';
  private remote?: BunkerSigner;
  private ready?: Promise<NostrUser>;
  private pointer?: BunkerPointer;
  private abort = new AbortController();
  static bunker(_client: NostrClient, uri: string) {
    const signer = new NostrNip46Signer();
    const url = new URL(uri);
    signer.pointer = {
      pubkey: url.hostname,
      relays: url.searchParams.getAll('relay'),
      secret: url.searchParams.get('secret'),
    };
    signer.bunkerPubkey = url.hostname;
    signer.relayUrls = signer.pointer.relays;
    return signer;
  }
  static nostrconnect(_client: NostrClient, relay: string, _?: unknown, _meta?: unknown) {
    const signer = new NostrNip46Signer();
    signer.relayUrls = [relay];
    return signer;
  }
  static fromPayload(payload: string, _client?: NostrClient) {
    const data = JSON.parse(payload).payload;
    const signer = new NostrNip46Signer();
    signer.localSigner = new NostrPrivateKeySigner(
      data.localPrivateKey ?? data.localSigner?.privateKey ?? data.localSigner,
    );
    signer.pubkey = data.pubkey ?? '';
    signer.bunkerPubkey = data.bunkerPubkey;
    signer.relayUrls = data.relayUrls;
    signer.pointer = { pubkey: data.bunkerPubkey, relays: data.relayUrls, secret: null };
    return signer;
  }
  // Session persistence is explicit; incidental serialization exposes public identity only.
  toJSON() {
    return { type: 'nip46', pubkey: this.pubkey, bunkerPubkey: this.bunkerPubkey };
  }
  toPayload() {
    return JSON.stringify({
      type: 'nip46',
      payload: {
        pubkey: this.pubkey,
        bunkerPubkey: this.bunkerPubkey,
        relayUrls: this.relayUrls,
        localPrivateKey: this.localSigner.privateKey,
      },
    });
  }
  blockUntilReady() {
    return (this.ready ??= privateOperation(async () => {
      const options = { onauth: (url: string) => this.emit('authUrl', url) };
      if (this.pointer) {
        this.remote = BunkerSigner.fromBunker(this.localSigner.secretKey, this.pointer, options);
        await this.remote.connect({ name: 'Anagram' });
      } else {
        this.remote = await BunkerSigner.fromURI(
          this.localSigner.secretKey,
          this.nostrConnectUri,
          options,
          this.abort.signal,
        );
      }
      this.pubkey = await this.remote.getPublicKey();
      this.bunkerPubkey = this.remote.bp.pubkey;
      this.relayUrls = this.remote.bp.relays;
      return new NostrUser({ pubkey: this.pubkey });
    }, 'Unable to connect to remote signer'));
  }
  user() {
    return this.blockUntilReady();
  }
  async sign(event: NostrEvent) {
    await this.blockUntilReady();
    const signed = await privateOperation(
      () => this.remote!.signEvent(event),
      'Unable to sign event',
    );
    if (!verifyEvent(signed) || signed.id !== getEventHash(event))
      throw new Error('Remote signer returned an invalid event');
    return signed.sig;
  }
  async encrypt(user: NostrUser, value: string, scheme = 'nip44') {
    await this.blockUntilReady();
    return privateOperation(
      () =>
        scheme === 'nip04'
          ? this.remote!.nip04Encrypt(user.pubkey, value)
          : this.remote!.nip44Encrypt(user.pubkey, value),
      'Unable to encrypt private content',
    );
  }
  async decrypt(user: NostrUser, value: string, scheme = 'nip44') {
    await this.blockUntilReady();
    return privateOperation(
      () =>
        scheme === 'nip04'
          ? this.remote!.nip04Decrypt(user.pubkey, value)
          : this.remote!.nip44Decrypt(user.pubkey, value),
      'Unable to decrypt private content',
    );
  }
  stop() {
    this.abort.abort();
    void this.remote?.close();
  }
}
export class NostrUser {
  pubkey: string;
  ndk?: NostrClient;
  profile?: NostrUserProfile;
  relayUrls: string[] = [];
  constructor(input: { pubkey?: string; npub?: string }) {
    this.pubkey = input.pubkey ?? (input.npub ? (nip19.decode(input.npub).data as string) : '');
  }
  get nprofile() {
    return nip19.nprofileEncode({ pubkey: this.pubkey, relays: this.relayUrls });
  }
  get npub() {
    return nip19.npubEncode(this.pubkey);
  }
  static async fromNip05(value: string, ndk: NostrClient, _?: boolean) {
    const profile = await nip05.queryProfile(value);
    if (!profile) return undefined;
    const user = new NostrUser(profile);
    user.relayUrls = profile.relays ?? [];
    user.ndk = ndk;
    return user;
  }
  async fetchProfile() {
    const event = await this.ndk?.fetchEvent({ kinds: [0], authors: [this.pubkey] });
    if (event) this.profile = JSON.parse(event.content);
    return this.profile;
  }
}
export class ClientEvent {
  id = '';
  sig?: string;
  kind = 1;
  pubkey = '';
  content = '';
  tags: string[][] = [];
  created_at = Math.floor(Date.now() / 1000);
  relay?: NostrRelay;
  onRelays: NostrRelay[] = [];
  constructor(
    public ndk?: NostrClient,
    event: Partial<NostrEvent> = {},
  ) {
    Object.assign(this, event);
  }
  get author() {
    const user = new NostrUser({ pubkey: this.pubkey });
    user.ndk = this.ndk;
    return user;
  }
  set author(user: NostrUser) {
    this.pubkey = user.pubkey;
  }
  rawEvent(): NostrEvent {
    return {
      kind: this.kind,
      pubkey: this.pubkey,
      created_at: this.created_at,
      content: this.content,
      tags: this.tags,
      ...(this.id ? { id: this.id } : {}),
      ...(this.sig ? { sig: this.sig } : {}),
    };
  }
  async toNostrEvent(): Promise<NostrEvent> {
    if (!this.pubkey && this.ndk?.signer) this.pubkey = (await this.ndk.signer.user()).pubkey;
    this.id = getEventHash(this.rawEvent());
    return this.rawEvent();
  }
  async sign(signer = this.ndk?.signer) {
    if (!signer) throw new Error('No active signer');
    this.pubkey = (await signer.user()).pubkey;
    this.id = getEventHash(this.rawEvent());
    this.sig = await signer.sign(this.rawEvent());
    return this.sig;
  }
  verifySignature(_?: boolean) {
    try {
      return verifyEvent(this.rawEvent() as Event);
    } catch {
      return false;
    }
  }
  isValid() {
    return this.verifySignature();
  }
  tagValue(name: string) {
    return this.tags.find((tag) => tag[0] === name)?.[1];
  }
  getMatchingTags(name: string) {
    return this.tags.filter((tag) => tag[0] === name);
  }
  deduplicationKey() {
    return this.kind === 0 || this.kind === 3 || (this.kind >= 10000 && this.kind < 20000)
      ? `${this.kind}:${this.pubkey}`
      : this.kind >= 30000 && this.kind < 40000
        ? `${this.kind}:${this.pubkey}:${this.tagValue('d') ?? ''}`
        : this.id;
  }
  async encrypt(user: NostrUser, signer = this.ndk?.signer, scheme: 'nip04' | 'nip44' = 'nip44') {
    if (!signer) throw new Error('No signer');
    this.content = await signer.encrypt(user, this.content, scheme);
  }
  async decrypt(
    user = this.author,
    signer = this.ndk?.signer,
    scheme: 'nip04' | 'nip44' = 'nip44',
  ) {
    if (!signer) throw new Error('No signer');
    this.content = await signer.decrypt(user, this.content, scheme);
    return this.content;
  }
  publishReplaceable(relaySet?: NostrRelaySet) {
    return this.publish(relaySet);
  }
  async publish(relaySet?: NostrRelaySet, timeoutMs = 5000) {
    if (!this.sig) await this.sign();
    const relays = relaySet?.relays ?? new Set(this.ndk?.pool.relays.values());
    const result = await Promise.allSettled(
      [...relays].map(async (relay) => {
        await relay.publish(this, timeoutMs);
        return relay;
      }),
    );
    const success = new Set(result.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
    if (!success.size) throw new Error('No relay acknowledged the event');
    return success;
  }
}
export async function giftWrap(
  event: ClientEvent,
  recipient: NostrUser,
  signer: NostrSigner,
  options?: { rumorKind?: number },
) {
  const rumor = await event.toNostrEvent();
  rumor.pubkey = (await signer.user()).pubkey;
  rumor.kind = options?.rumorKind ?? rumor.kind;
  delete rumor.sig;
  rumor.id = getEventHash(rumor);
  const time = () => Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800);
  const seal = new ClientEvent(event.ndk, {
    kind: 13,
    tags: [],
    created_at: time(),
    content: await signer.encrypt(recipient, JSON.stringify(rumor), 'nip44'),
  });
  await seal.sign(signer);
  const ephemeral = NostrPrivateKeySigner.generate();
  const wrap = new ClientEvent(event.ndk, {
    kind: 1059,
    tags: [['p', recipient.pubkey]],
    created_at: time(),
    content: await ephemeral.encrypt(recipient, JSON.stringify(seal.rawEvent()), 'nip44'),
  });
  await wrap.sign(ephemeral);
  return wrap;
}
export async function giftUnwrap(
  wrap: ClientEvent,
  options?: { requireEmptySealTags?: boolean },
  signer = wrap.ndk?.signer,
) {
  if (signer instanceof NostrPrivateKeySigner && typeof Worker !== 'undefined')
    return new ClientEvent(
      wrap.ndk,
      await unwrapInWorker(
        wrap.rawEvent() as Event,
        signer.secretKey,
        options?.requireEmptySealTags,
      ),
    );
  if (!signer || wrap.kind !== 1059 || !wrap.verifySignature())
    throw new Error('Invalid gift wrap');
  const seal = new ClientEvent(
    wrap.ndk,
    parsePrivateJson(
      await privateOperation(
        () => signer.decrypt(wrap.author, wrap.content, 'nip44'),
        'Unable to decrypt gift wrap',
      ),
    ),
  );
  if (
    seal.kind !== 13 ||
    !seal.verifySignature() ||
    (options?.requireEmptySealTags && seal.tags.length !== 0)
  )
    throw new Error('Invalid seal');
  const rumor: NostrEvent = parsePrivateJson(
    await privateOperation(
      () => signer.decrypt(seal.author, seal.content, 'nip44'),
      'Unable to decrypt seal',
    ),
  );
  if (options?.requireEmptySealTags && rumor.sig)
    throw new Error('Group rumor must be unsigned');
  return new ClientEvent(wrap.ndk, normalizeRumor(rumor, seal.pubkey));
}
export class NostrRelayList extends ClientEvent {
  constructor(ndk?: NostrClient, event?: Partial<NostrEvent>) {
    super(ndk, { kind: 10002, ...event });
  }
  static from(event: ClientEvent) {
    return new NostrRelayList(event.ndk, event.rawEvent());
  }
  get readRelayUrls() {
    return this.tags.filter((t) => t[0] === 'r' && t[2] !== 'write').map((t) => t[1]);
  }
  set readRelayUrls(urls: string[]) {
    this.tags = [
      ...this.tags.filter((t) => t[0] !== 'r' || t[2] !== 'read'),
      ...urls.map((url) => ['r', url, 'read']),
    ];
  }
  get writeRelayUrls() {
    return this.tags.filter((t) => t[0] === 'r' && t[2] !== 'read').map((t) => t[1]);
  }
  set writeRelayUrls(urls: string[]) {
    this.tags = [
      ...this.tags.filter((t) => t[0] !== 'r' || t[2] !== 'write'),
      ...urls.map((url) => ['r', url, 'write']),
    ];
  }
  get bothRelayUrls() {
    return this.readRelayUrls.filter((url) => this.writeRelayUrls.includes(url));
  }
  set bothRelayUrls(urls: string[]) {
    this.tags = [
      ...this.tags.filter((t) => t[0] !== 'r' || Boolean(t[2])),
      ...urls.map((url) => ['r', url]),
    ];
  }
  get relays() {
    return [...new Set([...this.readRelayUrls, ...this.writeRelayUrls])];
  }
}
export class NostrRelay extends Emitter {
  status = NostrRelayStatus.DISCONNECTED;
  connectivity: any = {};
  connectionStats: NostrRelayConnectionStats = { attempts: 0, success: 0, durations: [] };
  private pending?: Promise<void>;
  constructor(
    public url: string,
    private client: NostrClient,
  ) {
    super();
  }
  get connected() {
    return this.client.transport.listConnectionStatus().get(this.url) === true;
  }
  connect(timeoutMs = 5000, _?: boolean): Promise<void> {
    if (this.client.relayConnectionFilter?.(this.url) === false)
      return Promise.reject(new Error('Relay connection rejected by URL policy'));
    if (this.connected) return Promise.resolve();
    return (this.pending ??= (async () => {
      this.status = NostrRelayStatus.CONNECTING;
      this.client.pool.emit('relay:connecting', this);
      this.connectionStats.attempts++;
      try {
        const relay = await this.client.transport.ensureRelay(this.url, {
          connectionTimeout: timeoutMs,
        });
        this.status = NostrRelayStatus.CONNECTED;
        this.connectionStats.success++;
        this.connectionStats.connectedAt = Date.now();
        relay.onclose = () => {
          this.status = NostrRelayStatus.DISCONNECTED;
          this.client.pool.emit('relay:disconnect', this);
        };
        this.client.pool.emit('relay:connect', this);
        this.client.pool.emit('relay:ready', this);
      } catch (error) {
        this.status = NostrRelayStatus.DISCONNECTED;
        throw error;
      } finally {
        this.pending = undefined;
      }
    })());
  }
  disconnect() {
    this.client.transport.close([this.url]);
    this.status = NostrRelayStatus.DISCONNECTED;
  }
  async publish(event: ClientEvent, timeoutMs = 5000) {
    await this.client.transport.publish([this.url], event.rawEvent() as Event, {
      maxWait: timeoutMs,
    })[0];
    return true;
  }
  async fetchInfo(_?: unknown) {
    const response = await fetch(this.url.replace(/^ws/, 'http'), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Relay information unavailable');
    return response.json() as Promise<NostrRelayInformation>;
  }
}
class RelayPool extends Emitter {
  relays = new Map<string, NostrRelay>();
  constructor(private client: NostrClient) {
    super();
  }
  getRelay(url: string, connect = true, _?: unknown) {
    url = normalizeRelayUrl(url);
    let relay = this.relays.get(url);
    if (!relay) {
      relay = new NostrRelay(url, this.client);
      this.relays.set(url, relay);
    }
    if (connect) void relay.connect().catch(() => {});
    return relay;
  }
  stats() {
    const all = [...this.relays.values()];
    return {
      total: all.length,
      connected: all.filter((r) => r.connected).length,
      disconnected: all.filter((r) => !r.connected).length,
      connecting: all.filter((r) => r.status === NostrRelayStatus.CONNECTING).length,
    };
  }
}
export class NostrRelaySet {
  constructor(
    public relays: Set<NostrRelay>,
    public ndk?: NostrClient,
  ) {}
  get size() {
    return this.relays.size;
  }
  get relayUrls() {
    return [...this.relays].map((r) => r.url);
  }
  static fromRelayUrls(urls: string[], ndk: NostrClient, connect = true) {
    return new NostrRelaySet(new Set(urls.map((url) => ndk.pool.getRelay(url, connect))), ndk);
  }
}
export interface NostrSubscriptionOptions {
  // Delivery diagnostics may need observations from each replica, not only the first.
  includeRelayDuplicates?: boolean;
  closeOnEose?: boolean;
  relaySet?: NostrRelaySet;
  relayUrls?: string[];
  subId?: string;
  cacheUsage?: NostrSubscriptionCacheUsage;
  onEvent?: (event: ClientEvent, relay?: NostrRelay) => void;
  onEvents?: (events: ClientEvent[]) => void;
  onEose?: (subscription?: NostrSubscription) => void;
  onClose?: () => void;
  [key: string]: unknown;
}
export class NostrSubscription extends Emitter {
  get relaySet() {
    return this.opts.relaySet;
  }
  eosesSeen = new Set<NostrRelay>();
  subId: string;
  filters: Filter[];
  relayFilters = new Map<string, Filter[]>();
  eoseReceived = false;
  closed = false;
  private closers: { close(): void }[] = [];
  private failedTargets = new Set<NostrRelay>();
  private started = false;
  constructor(
    private client: NostrClient,
    filters: Filter | Filter[],
    public opts: NostrSubscriptionOptions,
  ) {
    super();
    this.filters = Array.isArray(filters) ? filters : [filters];
    this.subId = opts.subId ?? crypto.randomUUID();
  }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    const urls = this.opts.relaySet?.relayUrls ??
      this.opts.relayUrls ?? [...this.client.pool.relays.keys()];
    const seen = new Set<string>();
    const targets = urls.map((url) => this.client.pool.getRelay(url, false));
    this.opts.relaySet ??= new NostrRelaySet(new Set(targets), this.client);
    urls.forEach((url) => this.relayFilters.set(url, this.filters));
    for (const target of targets) {
      // One cleanup slot per relay, not one retained object per reconnect.
      let currentSubscription: { close(): void } | undefined;
      let cancelAuth: (() => void) | undefined;
      this.closers.push({
        close: () => {
          cancelAuth?.();
          currentSubscription?.close();
          currentSubscription = undefined;
        },
      });
      const startTarget = async () => {
        this.failedTargets.delete(target);
        try {
          await target.connect();
          if (this.closed) return;
          // A guarded connect can be deferred during backoff. Do not bypass it
          // with ensureRelay(), which would reopen the socket on every request.
          const relay = this.client.transport.getExistingRelay(target.url);
          if (!relay?.connected) throw new Error('Relay connection unavailable; will retry');
          let authRetried = false;
          const fail = (reason: unknown) => {
            if (this.closed) return;
            this.failedTargets.add(target);
            this.emit('closed', reason, target);
            if (targets.every((item) => this.failedTargets.has(item))) this.stop();
          };
          const subscribeTarget = () => {
            if (this.closed) return;
            this.failedTargets.delete(target);
            let ended = false;
            const sub = relay.subscribe(this.filters, {
              id: this.subId,
              // Only an actual EOSE is coverage evidence. Query owners enforce their own
              // deadlines; a silent/disconnected relay must never advance history cursors.
              eoseTimeout: 2147483647,
              onevent: (raw) => {
                if (this.closed || (seen.has(raw.id) && !this.opts.includeRelayDuplicates)) return;
                seen.add(raw.id);
                if (seen.size > 10000) seen.delete(seen.values().next().value!);
                const event = new ClientEvent(this.client, raw);
                event.relay = target;
                event.onRelays = [target];
                this.opts.onEvent?.(event, target);
                this.opts.onEvents?.([event]);
                this.emit('event', event, target);
              },
              oneose: () => {
                if (this.closed) return;
                this.eosesSeen.add(target);
                if (targets.every((item) => this.eosesSeen.has(item))) {
                  this.eoseReceived = true;
                  this.opts.onEose?.(this);
                  this.emit('eose', this);
                  if (this.opts.closeOnEose) this.stop();
                }
              },
              onclose: (reason) => {
                ended = true;
                currentSubscription = undefined;
                if (this.closed) return;
                this.eosesSeen.delete(target);
                // AUTH often finishes after the first REQ was rejected. Recover
                // this relay in place; another healthy relay must not hide it from
                // the watchdog, and authentication itself is never EOSE evidence.
                if (!authRetried && relay.onauth && reason.startsWith('auth-required:')) {
                  authRetried = true;
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  const cleanup = () => {
                    cancelAuth = undefined;
                    clearTimeout(timer);
                    target.off('authed', retry);
                    target.off('auth:failed', failed);
                  };
                  const retry = () => {
                    cleanup();
                    if (!this.closed) {
                      try {
                        subscribeTarget();
                      } catch (error) {
                        fail(error);
                      }
                    }
                  };
                  const failed = () => {
                    cleanup();
                    fail(reason);
                  };
                  cancelAuth = cleanup;
                  if (target.status === NostrRelayStatus.AUTHENTICATED) queueMicrotask(retry);
                  else {
                    target.on('authed', retry);
                    target.on('auth:failed', failed);
                    timer = setTimeout(failed, 15000);
                  }
                  return;
                }
                fail(reason);
              },
            });
            if (ended || this.closed) sub.close();
            else currentSubscription = sub;
          };
          subscribeTarget();
        } catch (error) {
          if (!this.closed) {
            this.failedTargets.add(target);
            this.emit('closed', error, target);
            if (targets.every((item) => this.failedTargets.has(item))) this.stop();
          }
        }
      };
      // A partial failure keeps healthy deliveries alive. When this particular
      // transport reconnects, its REQ must be restored too: a connected socket
      // alone does not mean a live subscription exists on it.
      const reconnected = (relay: NostrRelay) => {
        if (relay === target && !this.closed && this.failedTargets.has(target)) void startTarget();
      };
      this.client.pool.on('relay:connect', reconnected);
      this.closers.push({ close: () => this.client.pool.off('relay:connect', reconnected) });
      void startTarget();
    }
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    this.closers.forEach((s) => s.close());
    this.closers = [];
    this.emit('close');
    this.opts.onClose?.();
    this.removeAllListeners();
  }
}
export function filterFromId(id: string): Filter {
  if (/^[0-9a-f]{64}$/i.test(id)) return { ids: [id.toLowerCase()] };
  const decoded = nip19.decode(id);
  if (decoded.type === 'note') return { ids: [decoded.data] };
  if (decoded.type === 'nevent') return { ids: [decoded.data.id] };
  if (decoded.type === 'naddr')
    return {
      kinds: [decoded.data.kind],
      authors: [decoded.data.pubkey],
      '#d': [decoded.data.identifier],
    };
  throw new Error('Invalid event identifier');
}
class RelayTransport extends SimplePool {
  getExistingRelay(url: string) {
    return this.relays.get(url);
  }
}
export default class NostrClient {
  // Reconnection belongs to the app scheduler. Transport auto-reconnect rewrites
  // subscription `since` after the last event, which can skip backward history.
  transport = new RelayTransport({ enableReconnect: false });
  pool = new RelayPool(this);
  signer?: NostrSigner;
  relayConnectionFilter?: (relay: string) => boolean;
  relayAuthDefaultPolicy?: (...args: any[]) => any;
  constructor(
    options: {
      explicitRelayUrls?: string[];
      signer?: NostrSigner;
      enableOutboxModel?: boolean;
      authenticate?: boolean;
    } = {},
  ) {
    this.signer = options.signer;
    this.transport.trackRelays = false;
    const guarded = new WeakSet<object>();
    this.transport.automaticallyAuth = (url) => {
      // SimplePool creates/stores the transport before invoking this hook, and
      // invokes it before connect(): even an immediate AUTH challenge is guarded.
      const transport = this.transport.getExistingRelay(url);
      const relay = this.pool.getRelay(url, false);
      if (transport && !guarded.has(transport)) {
        guarded.add(transport);
        paceRelayRequests(transport);
        guardRelayAuthentication(transport, {
          authenticated: () => {
            relay.status = NostrRelayStatus.AUTHENTICATED;
            relay.emit('authed');
            this.pool.emit('relay:authed', relay);
          },
          failed: () => {
            relay.status = NostrRelayStatus.DISCONNECTED;
            relay.emit('auth:failed', new Error('Relay authentication failed; will retry'));
          },
        });
      }
      if (options.authenticate === false) return null;
      return async (event) => {
        const owner = this.signer?.pubkey;
        if (!owner) throw new Error('No active signer for relay authentication');
        relay.status = NostrRelayStatus.AUTHENTICATING;
        const challenge = event.tags.find((tag) => tag[0] === 'challenge')?.[1] ?? '';
        if (this.relayAuthDefaultPolicy && !(await this.relayAuthDefaultPolicy(relay, challenge)))
          throw new Error('Relay authentication declined');
        const signer = this.signer;
        if (!signer || signer.pubkey !== owner)
          throw new Error('Relay authentication account changed');
        const wrapped = new ClientEvent(this, event);
        await wrapped.sign(signer);
        if (this.signer !== signer) throw new Error('Relay authentication account changed');
        return wrapped.rawEvent() as VerifiedEvent;
      };
    };
    options.explicitRelayUrls?.forEach((url) => this.addExplicitRelay(url));
  }
  addExplicitRelay(url: string | NostrRelay, _?: unknown, connect = true) {
    return this.pool.getRelay(typeof url === 'string' ? url : url.url, connect);
  }
  assertSigner() {
    if (!this.signer) throw new Error('No active signer');
    return this.signer;
  }
  async connect(timeout = 5000) {
    await Promise.allSettled([...this.pool.relays.values()].map((r) => r.connect(timeout)));
  }
  async fetchUser(identifier: string, _?: boolean) {
    let pubkey = identifier;
    if (!isValidPubkey(pubkey)) {
      const decoded = nip19.decode(identifier);
      if (decoded.type === 'npub') pubkey = decoded.data;
      else if (decoded.type === 'nprofile') pubkey = decoded.data.pubkey;
      else throw new Error('Invalid public key');
    }
    return this.getUser({ pubkey });
  }
  getUser(input: { pubkey: string }) {
    const user = new NostrUser(input);
    user.ndk = this;
    return user;
  }
  subscribe(
    filters: Filter | Filter[],
    options: NostrSubscriptionOptions = {},
    relaySet?: NostrRelaySet,
    autoStart = true,
  ) {
    const sub = new NostrSubscription(this, filters, {
      ...options,
      relaySet: relaySet ?? options.relaySet,
    });
    if (autoStart) queueMicrotask(() => sub.start());
    return sub;
  }
  async fetchEvents(
    filters: Filter | Filter[],
    options: NostrSubscriptionOptions = {},
    relaySet?: NostrRelaySet,
  ): Promise<Set<ClientEvent>> {
    const urls = relaySet?.relayUrls ??
      options.relaySet?.relayUrls ??
      options.relayUrls ?? [...this.pool.relays.keys()];
    const results = await Promise.all(
      (Array.isArray(filters) ? filters : [filters]).map((f) =>
        this.transport.querySync(urls, f, { maxWait: 5000 }),
      ),
    );
    return new Set([
      ...new Map(results.flat().map((raw) => [raw.id, new ClientEvent(this, raw)])).values(),
    ]);
  }
  async fetchEvent(
    filter: string | Filter | Filter[],
    options?: NostrSubscriptionOptions,
    relaySet?: NostrRelaySet,
  ) {
    return (
      [
        ...(await this.fetchEvents(
          typeof filter === 'string' ? filterFromId(filter) : filter,
          options,
          relaySet,
        )),
      ].sort((a, b) => b.created_at - a.created_at)[0] ?? null
    );
  }
}
