import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { AppKeys } from 'nostr-double-ratchet';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools';
import { createRatchetPreferences } from '#src/stores/nostr/ratchetPreferences.ts';

const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  clear: () => stored.clear(),
});

const key = generateSecretKey();
const peer = getPublicKey(key);
const device = getPublicKey(generateSecretKey());
let owner = 'a'.repeat(64);
let events: VerifiedEvent[] = [];
let history: Array<{ id: number; meta: Record<string, unknown> }> = [];
let receive: ((event: VerifiedEvent) => void) | undefined;
const stop = vi.fn();
const subscribe = vi.fn(
  (_peer: string, onEvent: (event: VerifiedEvent) => void, ready: () => void) => {
    receive = onEvent;
    queueMicrotask(() => {
      events.forEach(onEvent);
      ready();
    });
    return stop;
  },
);
let preferences: ReturnType<typeof createRatchetPreferences>;
function roster(available = true, at = 1700000000) {
  const appKeys = new AppKeys(available ? [{ identityPubkey: device, createdAt: at }] : []);
  return finalizeEvent(appKeys.getEvent({ ownerPubkey: peer, createdAt: at }), key);
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  events = [];
  history = [];
  owner = 'a'.repeat(64);
  preferences = createRatchetPreferences({
    owner: () => owner,
    history: async () => history,
    subscribe,
  });
});
afterEach(() => preferences.close());
it('selects advertised double ratchet and does no per-message discovery', async () => {
  events = [roster()];
  await preferences.watch(peer);
  expect(get(preferences.mode)).toEqual({ peer, protocol: 'ndr' });
  expect(preferences.getPreference(peer)).toBe('auto');
  expect(await preferences.resolve(peer)).toBe('ndr');
  expect(await preferences.resolve(peer)).toBe('ndr');
  expect(subscribe).toHaveBeenCalledTimes(1);
});
it('keeps Auto after a negative result, then upgrades future sends when capability arrives', async () => {
  await preferences.watch(peer);
  expect(await preferences.resolve(peer)).toBe('nip17');
  expect(preferences.getPreference(peer)).toBe('auto');
  receive!(roster());
  await vi.waitFor(() => expect(get(preferences.mode).protocol).toBe('ndr'));
  expect(await preferences.resolve(peer)).toBe('ndr');
  receive!(roster(false, 1700000001));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await preferences.resolve(peer)).toBe('ndr');
  expect(subscribe).toHaveBeenCalledTimes(1);
});
it('uses the latest initial roster and checks again when a negative chat is reopened', async () => {
  events = [roster(false, 1700000001), roster(true, 1700000000)];
  await preferences.watch(peer);
  expect(await preferences.resolve(peer)).toBe('nip17');
  receive!(roster(true, 1699999999));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await preferences.resolve(peer)).toBe('nip17');
  await preferences.watch(null);
  events = [roster(true, 1700000002)];
  await preferences.watch(peer);
  expect(await preferences.resolve(peer)).toBe('ndr');
  expect(stop).toHaveBeenCalledTimes(1);
});
it('preserves legacy chats until explicitly set to Auto and excludes the optimistic first row', async () => {
  history = [{ id: 1, meta: {} }];
  events = [roster()];
  expect(await preferences.resolve(peer)).toBe('nip17');
  expect(preferences.getPreference(peer)).toBe('nip17');
  expect(subscribe).not.toHaveBeenCalled();
  await preferences.setPreference(peer, 'auto');
  expect(await preferences.resolve(peer)).toBe('ndr');
  preferences.close();
  localStorage.clear();
  expect(await preferences.resolve(peer, 1)).toBe('ndr');
  expect(preferences.getPreference(peer)).toBe('auto');
});
it('honors account preference and explicit chat overrides without automatic downgrades', async () => {
  events = [roster()];
  expect(preferences.getPreferRatchet()).toBe(true);
  await preferences.setPreferRatchet(false);
  await preferences.watch(peer);
  expect(await preferences.resolve(peer)).toBe('nip17');
  expect(subscribe).not.toHaveBeenCalled();
  await preferences.setPreference(peer, 'ndr');
  expect(await preferences.resolve(peer)).toBe('ndr');
  await preferences.setPreference(peer, 'nip17');
  await preferences.setPreferRatchet(true);
  expect(await preferences.resolve(peer)).toBe('nip17');
  expect(subscribe).not.toHaveBeenCalled();
  await preferences.setPreference(peer, 'auto');
  expect(await preferences.resolve(peer)).toBe('ndr');
  await preferences.setPreferRatchet(false);
  expect(await preferences.resolve(peer)).toBe('ndr');
  preferences.close();
  owner = 'b'.repeat(64);
  expect(preferences.getPreferRatchet()).toBe(true);
  expect(preferences.getPreference(peer)).toBe('auto');
});

it('keeps new incoming NIP-17 conversations in Auto for later capability upgrades', async () => {
  history = [{ id: 1, meta: { protocol: 'nip17' } }];
  await preferences.watch(peer);
  expect(preferences.getPreference(peer)).toBe('auto');
  expect(await preferences.resolve(peer)).toBe('nip17');
  receive!(roster());
  await vi.waitFor(() => expect(get(preferences.mode).protocol).toBe('ndr'));
});

it.each([false, true])(
  'chooses the lowest event ID for equal-time capability snapshots (reversed=%s)',
  async (reverse) => {
    const active = roster(true);
    const empty = roster(false);
    events = reverse ? [empty, active] : [active, empty];
    await preferences.watch(peer);
    expect(await preferences.resolve(peer)).toBe(active.id < empty.id ? 'ndr' : 'nip17');
  },
);
