import { writable } from 'svelte/store';
import type { VerifiedEvent } from 'nostr-tools';
import { parseRatchetCapability, type RatchetCapability } from './ratchetCapability.ts';

export type DirectMessageProtocol = 'nip17' | 'ndr';
export type DirectMessagePreference = DirectMessageProtocol | 'auto';

export function createRatchetPreferences(deps: {
  owner: () => string | null;
  history: (peer: string) => Promise<Array<{ id: number; meta: Record<string, unknown> }>>;
  subscribe: (peer: string, event: (event: VerifiedEvent) => void, ready: () => void) => () => void;
}) {
  const mode = writable<{ peer: string | null; protocol: DirectMessageProtocol }>({
    peer: null,
    protocol: 'nip17',
  });
  const pendingStops = new Set<() => void>();
  const discoveries = new Map<string, Promise<void>>();
  let activePeer: string | null = null;
  let stopWatching: (() => void) | undefined;
  let revision = 0;
  const key = (owner = deps.owner()) => `anagram-ndr:${owner}`;
  const read = (suffix = ''): Record<string, DirectMessagePreference> => {
    try {
      return JSON.parse(localStorage.getItem(key() + suffix) ?? '{}');
    } catch {
      return {};
    }
  };
  function save(peer: string, value: DirectMessagePreference, suffix = '') {
    localStorage.setItem(key() + suffix, JSON.stringify({ ...read(suffix), [peer]: value }));
  }
  const getPreference = (peer: string): DirectMessagePreference => read()[peer] ?? 'auto';
  const getPreferRatchet = () => localStorage.getItem(key() + ':prefer') !== '0';
  function effective(peer: string): DirectMessageProtocol {
    const preference = getPreference(peer);
    if (preference !== 'auto') return preference;
    return read(':selected')[peer] === 'ndr' ? 'ndr' : 'nip17';
  }
  function refresh() {
    mode.set({ peer: activePeer, protocol: activePeer ? effective(activePeer) : 'nip17' });
  }
  async function initialize(peer: string, excludeId?: number) {
    if (read()[peer]) return;
    const owner = deps.owner();
    const rows = await deps.history(peer);
    if (owner !== deps.owner()) throw new Error('Messaging account changed.');
    if (read()[peer]) return;
    const previous = [...rows].reverse().find((row) => row.id !== excludeId);
    // Existing NIP-17 conversations retain their mode until Auto is explicitly chosen.
    save(peer, previous && !previous.meta.protocol ? 'nip17' : 'auto');
    if (previous?.meta.protocol === 'ndr') save(peer, 'ndr', ':selected');
  }
  function discovery(peer: string, live: boolean) {
    const owner = deps.owner();
    let stopped = false,
      initial = true;
    let latest: RatchetCapability | null = null;
    let processing = Promise.resolve();
    let done!: () => void;
    let unsubscribe = () => {};
    const ready = new Promise<void>((resolve) => {
      done = resolve;
    });
    const current = () => !stopped && owner === deps.owner();
    const apply = () => {
      if (current() && latest?.available && getPreference(peer) === 'auto' && getPreferRatchet()) {
        // A failed or queued ratchet send never silently falls back to NIP-17.
        save(peer, 'ndr', ':selected');
        refresh();
      }
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      pendingStops.delete(stop);
      done();
    };
    const finish = () => {
      void processing.then(() => {
        if (!current()) return;
        initial = false;
        clearTimeout(timer);
        apply();
        done();
        if (!live) stop();
      });
    };
    const timer = setTimeout(finish, 5000);
    pendingStops.add(stop);
    unsubscribe = deps.subscribe(
      peer,
      (event) => {
        processing = processing
          .then(async () => {
            if (!current()) return;
            const capability = await parseRatchetCapability(event, peer);
            if (!current() || !capability) return;
            if (
              !latest ||
              capability.createdAt > latest.createdAt ||
              (capability.createdAt === latest.createdAt && capability.id < latest.id)
            )
              latest = capability;
            if (!initial) apply();
          })
          .catch(() => {});
      },
      finish,
    );
    return { ready, stop };
  }
  async function watch(peer: string | null) {
    const version = ++revision;
    stopWatching?.();
    stopWatching = undefined;
    if (activePeer) discoveries.delete(activePeer);
    activePeer = peer;
    refresh();
    if (!peer) return;
    await initialize(peer);
    if (revision !== version) return;
    refresh();
    if (getPreference(peer) !== 'auto' || !getPreferRatchet() || effective(peer) === 'ndr') return;
    const next = discovery(peer, true);
    stopWatching = next.stop;
    discoveries.set(peer, next.ready);
    await next.ready;
  }
  async function resolve(peer: string, excludeId?: number): Promise<DirectMessageProtocol> {
    await initialize(peer, excludeId);
    if (getPreference(peer) === 'auto' && getPreferRatchet() && effective(peer) !== 'ndr') {
      if (!discoveries.has(peer)) discoveries.set(peer, discovery(peer, false).ready);
      await discoveries.get(peer);
    }
    return effective(peer);
  }
  async function setPreference(peer: string, value: DirectMessagePreference) {
    save(peer, value);
    if (value === 'auto') {
      const selected = read(':selected');
      delete selected[peer];
      localStorage.setItem(key() + ':selected', JSON.stringify(selected));
    }
    discoveries.delete(peer);
    if (activePeer === peer) await watch(peer);
    else refresh();
  }
  async function setPreferRatchet(value: boolean) {
    localStorage.setItem(key() + ':prefer', value ? '1' : '0');
    discoveries.clear();
    if (activePeer) await watch(activePeer);
  }
  function received(peer: string) {
    if (!read()[peer]) save(peer, 'auto');
    if (getPreference(peer) === 'auto') {
      save(peer, 'ndr', ':selected');
      refresh();
    }
  }
  function close() {
    revision++;
    pendingStops.forEach((stop) => stop());
    stopWatching = undefined;
    activePeer = null;
    discoveries.clear();
    refresh();
  }
  return {
    mode,
    getPreference,
    setPreference,
    getPreferRatchet,
    setPreferRatchet,
    resolve,
    watch,
    received,
    close,
  };
}
