import { relayFailureKind } from '#src/stores/nostr/relayTrafficPolicy.ts';
import type { StartupTrackId } from '#src/stores/nostr/startupState.ts';
import { resolveStartupStepIdValue } from '#src/stores/nostr/startupState.ts';

export type RelaySyncStatus = 'pending' | 'retrying' | 'success' | 'error';
export type RelaySyncReason = 'timeout' | 'unavailable' | 'closed' | 'auth' | 'rate-limited';
export interface RelaySyncUpdate {
  relayUrl: string;
  status: RelaySyncStatus;
  reason?: RelaySyncReason;
}
export interface StartupRelaySnapshot extends RelaySyncUpdate {}
export type RelaySyncObserver = ((update: RelaySyncUpdate) => void) & { dispose?: () => void };

interface Operation {
  tracks: string[];
  snapshot: boolean;
  relays: Map<string, StartupRelaySnapshot>;
}
interface Session {
  controller: AbortController;
  operations: Map<string, Operation>;
  listener?: (track: string, relays: StartupRelaySnapshot[]) => void;
}
const sessions = new WeakMap<object, Session>();
function session(client: object): Session {
  let value = sessions.get(client);
  if (!value) {
    value = { controller: new AbortController(), operations: new Map() };
    sessions.set(client, value);
  }
  return value;
}

// Store only an allowlisted reason, never relay-provided text, filters or ciphertext.
export function relaySyncReason(reason: unknown): RelaySyncReason {
  const text = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
  const kind = relayFailureKind(text);
  if (kind === 'auth') return 'auth';
  if (kind === 'rate-limited') return 'rate-limited';
  if (kind === 'terminal') return 'closed';
  return 'unavailable';
}

export function startupRelaySignal(client: object): AbortSignal {
  return session(client).controller.signal;
}
export function resetStartupRelayTracking(client: object): void {
  const value = session(client);
  value.controller.abort();
  value.controller = new AbortController();
  value.operations.clear();
}
export function setStartupRelayListener(
  client: object,
  listener: NonNullable<Session['listener']>,
): void {
  session(client).listener = listener;
}

export function startupRelayStatuses(client: object, track: string): StartupRelaySnapshot[] {
  const byUrl = new Map<string, StartupRelaySnapshot[]>();
  for (const op of session(client).operations.values()) {
    if (!op.tracks.includes(track)) continue;
    for (const relay of op.relays.values()) {
      const values = byUrl.get(relay.relayUrl) ?? [];
      values.push(relay);
      byUrl.set(relay.relayUrl, values);
    }
  }
  // Green requires every operation for this relay to finish. A completed batch
  // cannot hide a failed/pending batch on the same relay.
  return [...byUrl]
    .map(([relayUrl, values]) => {
      const value =
        values.find((r) => r.status === 'error') ??
        values.find((r) => r.status === 'retrying') ??
        values.find((r) => r.status === 'pending') ??
        values[0]!;
      return { ...value, relayUrl };
    })
    .sort((a, b) => a.relayUrl.localeCompare(b.relayUrl));
}
export function needsStartupRelayRetry(client: object, track: string): boolean {
  return [...session(client).operations.values()].some(
    (op) =>
      op.snapshot &&
      op.tracks.includes(track) &&
      [...op.relays.values()].some((relay) => relay.status !== 'success'),
  );
}

export function retainStartupRelayQueries(client: object, track: string, keys: Set<string>): void {
  const value = session(client);
  const changed = new Set<string>();
  for (const [key, op] of value.operations) {
    if (!op.snapshot || !key.startsWith(`${track}:`) || keys.has(key.slice(track.length + 1)))
      continue;
    value.operations.delete(key);
    op.tracks.forEach((id) => changed.add(id));
  }
  for (const id of changed) value.listener?.(id, startupRelayStatuses(client, id));
}

export function startupRelayObserver(
  client: object,
  tracks: string[],
  key: string,
  relayUrls: string[],
  options: { snapshot?: boolean; parentStepId?: StartupTrackId } = {},
): RelaySyncObserver {
  const value = session(client);
  const signal = value.controller.signal;
  const ids = [
    ...new Set(
      tracks.flatMap((track) => [
        track,
        options.parentStepId ?? resolveStartupStepIdValue(track as StartupTrackId),
      ]),
    ),
  ];
  if (options.parentStepId) ids.push(options.parentStepId);
  const opKey = `${tracks.join('|')}:${key}`;
  const previous = value.operations.get(opKey);
  const operation: Operation = {
    tracks: ids,
    snapshot: options.snapshot === true,
    relays: new Map(
      relayUrls.map((relayUrl) => [
        relayUrl,
        {
          relayUrl,
          status: previous ? 'retrying' : 'pending',
        },
      ]),
    ),
  };
  value.operations.set(opKey, operation);
  const notify = () => {
    for (const track of ids) value.listener?.(track, startupRelayStatuses(client, track));
  };
  notify();
  const observer: RelaySyncObserver = (update) => {
    if (signal.aborted || value.operations.get(opKey) !== operation) return;
    operation.relays.set(update.relayUrl, { ...update });
    notify();
  };
  observer.dispose = () => {
    if (signal.aborted || value.operations.get(opKey) !== operation) return;
    value.operations.delete(opKey);
    notify();
  };
  return observer;
}
