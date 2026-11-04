import type { VerifiedEvent } from 'nostr-tools';
import type NostrClient from '#src/lib/nostr/client.ts';
import type { ClientEvent } from '#src/lib/nostr/client.ts';
import { parseRatchetRoster, type RatchetRoster } from './ratchetCapability.ts';
import { readRatchetDevicePublicKey } from './ratchetStorage.ts';

export type MessagingDevice = { identityPubkey: string; isCurrent: boolean };

// A short, read-only Settings request; this module never loads or creates NdrRuntime.
export async function readMessagingDevices(deps: {
  client: Pick<NostrClient, 'subscribe'>;
  owner: string;
  isCurrent: () => boolean;
  relays: () => Promise<string[]>;
  signal?: AbortSignal;
}): Promise<MessagingDevice[]> {
  const { owner, signal } = deps;
  if (!/^[a-f0-9]{64}$/.test(owner) || !deps.isCurrent() || signal?.aborted)
    throw new Error('Messaging account changed.');
  const events = await new Promise<VerifiedEvent[]>((resolve, reject) => {
    const candidates: VerifiedEvent[] = [];
    const seen = new Set<string>();
    let stop: (() => void) | undefined;
    let hasCoverage = () => false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stop?.();
      if (error) reject(error);
      else if (!deps.isCurrent()) reject(new Error('Messaging account changed.'));
      else resolve(candidates);
    };
    const abort = () => finish(new Error('Messaging device lookup cancelled.'));
    const timer = setTimeout(
      () => finish(hasCoverage() ? undefined : new Error('Could not load messaging devices.')),
      5000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    void deps
      .relays()
      .then((relays) => {
        if (settled) return;
        if (!deps.isCurrent() || !relays.length) {
          finish(new Error('No messaging relay available.'));
          return;
        }
        const sub = deps.client.subscribe(
          { kinds: [37368], authors: [owner], limit: 10 },
          { relayUrls: relays },
        );
        stop = () => sub.stop();
        hasCoverage = () => sub.eosesSeen.size > 0;
        sub.on('event', (event: ClientEvent) => {
          if (settled || seen.has(event.id) || candidates.length >= 10) return;
          seen.add(event.id);
          candidates.push(event.rawEvent() as VerifiedEvent);
        });
        sub.on('eose', () => {
          if (sub.eosesSeen.size > 0) finish();
        });
      })
      .catch(() => finish(new Error('Could not load messaging devices.')));
  });
  let latest: RatchetRoster | null = null;
  for (const event of events) {
    if (!deps.isCurrent() || signal?.aborted) throw new Error('Messaging account changed.');
    const roster = await parseRatchetRoster(event, owner);
    if (
      roster &&
      (!latest ||
        roster.createdAt > latest.createdAt ||
        (roster.createdAt === latest.createdAt && roster.id < latest.id))
    )
      latest = roster;
  }
  if (!deps.isCurrent() || signal?.aborted) throw new Error('Messaging account changed.');
  if (events.length && !latest) throw new Error('Could not verify messaging devices.');
  if (!latest?.devices.length) return [];
  // Optional local identification must not prevent showing the authenticated public roster.
  const local = await readRatchetDevicePublicKey(owner).catch(() => null);
  if (!deps.isCurrent() || signal?.aborted) throw new Error('Messaging account changed.');
  return (latest?.devices ?? [])
    .map(({ identityPubkey }) => ({
      identityPubkey,
      isCurrent: identityPubkey === local,
    }))
    .sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        a.identityPubkey.localeCompare(b.identityPubkey),
    );
}
