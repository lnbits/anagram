import type NostrClient from '#src/lib/nostr/client.ts';
import type { NostrSubscription } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { profileSearchAllowed, type ProfileSearchStatus } from './profileSearchRuntime.ts';
import { newerRoom, parsePublicRoom, ROOM_KIND, type PublicRoom } from './publicGroups.ts';

export function publicGroupMatches(room: PublicRoom, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/);
  const text = `${room.name} ${room.about} ${room.slug}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Bounded discovery of signed room definitions. Never joins rooms or loads messages. */
export function searchRelayPublicGroups(
  client: NostrClient,
  query: string,
  relayUrls: string[],
  options: {
    signal: AbortSignal;
    onResults: (rooms: PublicRoom[]) => void;
    isBlocked: (key: string) => boolean;
  },
): Promise<ProfileSearchStatus> {
  if (!profileSearchAllowed(query)) return Promise.resolve('invalid');
  const urls = [
    ...new Set(
      relayUrls
        .map((url) => inputSanitizerService.normalizeRelayWs(url))
        .filter((url): url is string => Boolean(url)),
    ),
  ].slice(0, 16);
  if (options.signal.aborted) return Promise.resolve('complete');
  if (!urls.length) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    const rooms = new Map<string, PublicRoom>();
    const subscriptions: NostrSubscription[] = [];
    let stopped = false,
      pending = urls.length * 2,
      receivedEose = false,
      matches = 0;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      subscriptions.forEach((sub) => sub.stop());
      resolve(matches || receivedEose || options.signal.aborted ? 'complete' : 'unavailable');
    };
    const abort = () => finish();
    const timer = setTimeout(finish, 6000);
    options.signal.addEventListener('abort', abort, { once: true });
    // Keep ordinary reads separate: relays may reject an entire REQ containing `search`.
    const filters = [
      { kinds: [ROOM_KIND], search: query.trim(), limit: 40 },
      { kinds: [ROOM_KIND], limit: 100 },
    ];
    for (const url of urls)
      for (const filter of filters) {
        let done = false,
          received = 0;
        const complete = () => {
          if (done) return;
          done = true;
          if (--pending === 0) finish();
        };
        try {
          const sub = client.subscribe(filter, {
            relayUrls: [url],
            closeOnEose: true,
            onEvent: (event) => {
              if (stopped || done || received++ >= 256) return;
              let room: PublicRoom;
              try {
                room = parsePublicRoom(event.rawEvent());
              } catch {
                return;
              }
              if (options.isBlocked(room.owner)) return;
              const previous = rooms.get(room.address);
              if (previous && !newerRoom(room, previous)) return;
              if (!previous && rooms.size >= 200) return;
              rooms.set(room.address, room);
              const found = [...rooms.values()]
                .filter((room) => publicGroupMatches(room, query))
                .sort(
                  (a, b) =>
                    Number(b.name.toLowerCase() === query.trim().toLowerCase()) -
                      Number(a.name.toLowerCase() === query.trim().toLowerCase()) ||
                    a.name.localeCompare(b.name) ||
                    a.address.localeCompare(b.address),
                )
                .slice(0, 20);
              matches = found.length;
              options.onResults(found);
            },
            onEose: () => {
              receivedEose = true;
              complete();
            },
            onClose: complete,
          });
          if (stopped) sub.stop();
          else subscriptions.push(sub);
        } catch {
          complete();
        }
      }
  });
}
