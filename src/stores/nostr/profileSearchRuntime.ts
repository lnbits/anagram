import type NostrClient from '#src/lib/nostr/client.ts';
import { nip19, type ClientEvent, type NostrFilter } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';

export interface ProfileSearchResult {
  publicKey: string;
  name: string;
  picture: string;
  nip05: string;
  relayUrls: string[];
  createdAt?: number;
  eventId?: string;
}
export type ProfileSearchStatus = 'complete' | 'unavailable' | 'invalid';
export const profileSearchAllowed = (
  query: string,
  privateKeys: (string | null | undefined)[] = [],
) =>
  query.trim().length >= 2 &&
  query.length <= 200 &&
  !/nsec1|bunker:\/\/|nostrconnect:\/\//i.test(query) &&
  !privateKeys.some((key) => key && query.toLowerCase().includes(key.toLowerCase()));
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Short-lived public discovery. It never replaces the message subscriptions,
 * creates contacts, or reads message history. Results stream before EOSE. */
export function searchRelayProfiles(
  client: NostrClient,
  query: string,
  relayUrls: string[],
  options: {
    signal: AbortSignal;
    onResults: (results: ProfileSearchResult[]) => void;
    isBlocked: (key: string) => boolean;
    resolveNip05: (
      identifier: string,
    ) => Promise<{ isValid: boolean; normalizedPubkey: string | null; relays: string[] }>;
  },
): Promise<ProfileSearchStatus> {
  if (!profileSearchAllowed(query)) return Promise.resolve('invalid');
  const value = query
    .trim()
    .replace(/^nostr:/i, '')
    .replace(/^@/, '');
  const results = new Map<string, ProfileSearchResult>();
  const subscriptions: Array<{ stop: () => void }> = [];
  const urls = (values: string[]) => [
    ...new Set(
      values
        .map((url) => inputSanitizerService.normalizeRelayWs(url))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  let stopped = false;
  return new Promise((resolve) => {
    const finish = (status: ProfileSearchStatus) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      options.signal.removeEventListener('abort', abort);
      subscriptions.forEach((subscription) => subscription.stop());
      resolve(status);
    };
    const abort = () => finish('complete');
    let receivedEose = false;
    const deadline = setTimeout(
      () => finish(results.size || receivedEose ? 'complete' : 'unavailable'),
      6000,
    );
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) {
      abort();
      return;
    }
    const emit = () => {
      if (!stopped)
        options.onResults(
          [...results.values()]
            .sort((a, b) => {
              const rank = (profile: ProfileSearchResult) =>
                Number(profile.name.toLowerCase() === value.toLowerCase());
              return (
                rank(b) - rank(a) ||
                a.name.localeCompare(b.name) ||
                a.publicKey.localeCompare(b.publicKey)
              );
            })
            .slice(0, 20),
        );
    };
    void (async () => {
      let publicKey = '',
        nip05 = '';
      let hints: string[] = [];
      if (value.includes('@')) {
        if (!/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value)) {
          finish('invalid');
          return;
        }
        const resolved = await options.resolveNip05(value.toLowerCase()).catch(() => null);
        if (stopped) return;
        if (!resolved?.isValid || !resolved.normalizedPubkey) {
          finish('complete');
          return;
        }
        publicKey = resolved.normalizedPubkey;
        hints = resolved.relays;
        nip05 = value.toLowerCase();
      } else if (/^[a-f0-9]{64}$/i.test(value)) publicKey = value.toLowerCase();
      else if (/^(npub|nprofile)1/i.test(value)) {
        try {
          const decoded = nip19.decode(value);
          if (decoded.type === 'npub') publicKey = decoded.data;
          else if (decoded.type === 'nprofile') {
            publicKey = decoded.data.pubkey;
            hints = decoded.data.relays ?? [];
          }
        } catch {
          finish('invalid');
          return;
        }
      }
      if (publicKey && (!/^[a-f0-9]{64}$/.test(publicKey) || options.isBlocked(publicKey))) {
        finish('complete');
        return;
      }
      const targets = urls([...hints, ...relayUrls]);
      if (publicKey) {
        results.set(publicKey, {
          publicKey,
          name: nip05 || publicKey.slice(0, 16),
          picture: '',
          nip05,
          relayUrls: targets,
        });
        emit();
      }
      if (!targets.length) {
        finish(results.size ? 'complete' : 'unavailable');
        return;
      }
      const filter: NostrFilter = publicKey
        ? { kinds: [0], authors: [publicKey], limit: 1 }
        : { kinds: [0], search: value, limit: 20 };
      // Ordinary metadata reads must survive rejection of the optional NIP-50 filter.
      const filters: NostrFilter[] = publicKey ? [filter] : [filter, { kinds: [0], limit: 100 }];
      let pending = targets.length * filters.length;
      const receive = (event: ClientEvent) => {
        if (
          stopped ||
          event.kind !== 0 ||
          !/^[a-f0-9]{64}$/.test(event.pubkey) ||
          options.isBlocked(event.pubkey) ||
          (publicKey && event.pubkey !== publicKey)
        )
          return;
        let profile: Record<string, unknown>;
        try {
          profile = JSON.parse(event.content);
        } catch {
          return;
        }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return;
        const name =
          text(profile.display_name) ||
          text(profile.displayName) ||
          text(profile.name) ||
          event.pubkey.slice(0, 16);
        const claimedNip05 = text(profile.nip05);
        // Relays without NIP-50 may ignore `search` and return arbitrary profiles.
        if (
          !publicKey &&
          ![name, text(profile.name), claimedNip05, event.pubkey].some((field) =>
            field.toLowerCase().includes(value.toLowerCase()),
          )
        )
          return;
        const previous = results.get(event.pubkey);
        if (
          previous?.createdAt !== undefined &&
          ((event.created_at ?? 0) < previous.createdAt ||
            (event.created_at === previous.createdAt && event.id >= (previous.eventId ?? '')))
        )
          return;
        if (!previous && results.size >= 40) return;
        const picture = text(profile.picture) || text(profile.image);
        results.set(event.pubkey, {
          publicKey: event.pubkey,
          name,
          picture: /^https?:\/\//i.test(picture) ? picture : '',
          nip05: nip05 || claimedNip05,
          relayUrls: targets,
          createdAt: event.created_at,
          eventId: event.id,
        });
        emit();
      };
      for (const relay of targets)
        for (const requestedFilter of filters) {
          let done = false,
            received = 0;
          const complete = () => {
            if (done) return;
            done = true;
            if (--pending === 0) finish(results.size || receivedEose ? 'complete' : 'unavailable');
          };
          try {
            const sub = client.subscribe(requestedFilter, {
              relayUrls: [relay],
              closeOnEose: true,
              onEvent: (event) => {
                if (!done && received++ < 256) receive(event);
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
    })().catch(() => finish('unavailable'));
  });
}
