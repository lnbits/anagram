import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AppKeys } from 'nostr-double-ratchet';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools';
import type NostrClient from '#src/lib/nostr/client.ts';
import { createRatchetIntegration } from '#src/stores/nostr/ratchetIntegration.ts';
import { createRatchetRuntime } from '#src/stores/nostr/ratchetRuntime.ts';
import { RatchetStorage, readRatchetDevicePublicKey } from '#src/stores/nostr/ratchetStorage.ts';

vi.mock('#src/stores/nostr/ratchetRuntime.ts', () => ({
  createRatchetRuntime: vi.fn(() => {
    throw new Error('Settings must not start the runtime.');
  }),
}));

const secret = generateSecretKey();
const owner = getPublicKey(secret);
const local = getPublicKey(generateSecretKey());
const remote = getPublicKey(generateSecretKey());
const otherOwner = getPublicKey(generateSecretKey());
const now = Math.floor(Date.now() / 1000);
const publicKey = 'v1/device-manager/identity-public-key';

function roster(devices = [local, remote], createdAt = now) {
  return finalizeEvent(
    new AppKeys(devices.map((identityPubkey) => ({ identityPubkey, createdAt }))).getEvent({
      ownerPubkey: owner,
      createdAt,
    }),
    secret,
  );
}

function setup() {
  let activeOwner = owner;
  const handlers = new Map<string, (value?: unknown) => void>();
  const sub = {
    on: vi.fn((name: string, handler: (value?: unknown) => void) => handlers.set(name, handler)),
    stop: vi.fn(),
    eosesSeen: new Set<string>(),
  };
  const publish = vi.fn();
  const client = { subscribe: vi.fn(() => sub), transport: { publish } };
  const signer = vi.fn();
  const relays = vi.fn(async () => ['wss://relay.example']);
  const integration = createRatchetIntegration({
    client: client as unknown as NostrClient,
    owner: () => activeOwner,
    signer,
    relays,
    receive: vi.fn(),
  });
  const event = (value: VerifiedEvent) =>
    handlers.get('event')?.({ id: value.id, rawEvent: () => value });
  const ready = () => {
    sub.eosesSeen.add('wss://relay.example');
    handlers.get('eose')?.();
  };
  return {
    integration,
    client,
    signer,
    publish,
    relays,
    sub,
    event,
    ready,
    changeOwner: () => {
      activeOwner = otherOwner;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('read-only messaging devices', () => {
  it('loads the signed roster and identifies only this account’s saved browser identity', async () => {
    const current = new RatchetStorage(owner),
      other = new RatchetStorage(otherOwner);
    await current.put(publicKey, local);
    await other.put(publicKey, remote);
    const writes = vi.spyOn(IDBObjectStore.prototype, 'put');
    const read = vi.spyOn(IDBObjectStore.prototype, 'get');
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster());
    state.ready();
    expect(await lookup).toEqual([
      { identityPubkey: local, isCurrent: true },
      { identityPubkey: remote, isCurrent: false },
    ]);
    expect(state.client.subscribe).toHaveBeenCalledWith(
      { kinds: [37368], authors: [owner], limit: 10 },
      { relayUrls: ['wss://relay.example'] },
    );
    expect(state.sub.stop).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(`${owner}:${publicKey}`);
    expect(read).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(createRatchetRuntime).not.toHaveBeenCalled();
    expect(state.signer).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
    await Promise.all([current.close(), other.close()]);
    vi.restoreAllMocks();
  });

  it('does not create storage or keys when no local device exists', async () => {
    expect(await indexedDB.databases()).toEqual([]);
    expect(await readRatchetDevicePublicKey(owner)).toBeNull();
    expect(await indexedDB.databases()).toEqual([]);
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster());
    state.ready();
    expect((await lookup).every((device) => !device.isCurrent)).toBe(true);
    expect(await indexedDB.databases()).toEqual([]);
    expect(createRatchetRuntime).not.toHaveBeenCalled();
    expect(state.signer).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('ignores forged, unrelated and malformed rosters and honors the newest empty roster', async () => {
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster());
    const forged = JSON.parse(JSON.stringify(roster([remote], now + 2))) as VerifiedEvent;
    forged.sig = '0'.repeat(128);
    state.event(forged);
    state.event(finalizeEvent({ ...roster([remote], now + 3), content: 'malformed' }, secret));
    state.event(finalizeEvent({ ...roster([remote], now + 4), kind: 1 }, secret));
    state.event(finalizeEvent(roster([remote], now + 5), generateSecretKey()));
    state.event(roster([], now + 1));
    state.ready();
    expect(await lookup).toEqual([]);
  });

  it('reports unverifiable data instead of claiming there are no devices', async () => {
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(finalizeEvent({ ...roster(), content: 'malformed' }, secret));
    state.ready();
    await expect(lookup).rejects.toThrow('Could not verify');
  });

  it('rejects an account switch and stops on explicit cancellation', async () => {
    const state = setup();
    let lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster());
    state.changeOwner();
    state.ready();
    await expect(lookup).rejects.toThrow('account changed');
    const controller = new AbortController();
    lookup = state.integration.readMessagingDevices(controller.signal);
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(lookup).rejects.toThrow('cancelled');
    expect(state.sub.stop).toHaveBeenCalledTimes(2);
  });

  it('times out without real EOSE, closes the request and does not poll', async () => {
    vi.useFakeTimers();
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    const rejected = expect(lookup).rejects.toThrow('Could not load');
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster());
    // A synthetic EOSE callback without a relay acknowledgement is not coverage.
    state.sub.on.mock.calls.find(([name]) => name === 'eose')?.[1]();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(state.sub.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.client.subscribe).toHaveBeenCalledOnce();
  });

  it('uses a responding relay at the deadline even when another relay is silent', async () => {
    vi.useFakeTimers();
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster([remote]));
    state.sub.eosesSeen.add('wss://relay.example');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await lookup).toEqual([{ identityPubkey: remote, isCurrent: false }]);
    expect(state.sub.stop).toHaveBeenCalledOnce();
  });

  it('rejects a pending result after the integration closes', async () => {
    const state = setup();
    const lookup = state.integration.readMessagingDevices();
    await vi.waitFor(() => expect(state.client.subscribe).toHaveBeenCalledOnce());
    state.event(roster());
    await state.integration.close();
    state.ready();
    await expect(lookup).rejects.toThrow('account changed');
    expect(state.sub.stop).toHaveBeenCalledOnce();
  });
});
