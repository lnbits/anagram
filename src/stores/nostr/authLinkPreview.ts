import NostrClient, { type NostrEvent } from '#src/lib/nostr/client.ts';
import { chatLinkTarget } from '#src/utils/chatLink.ts';
import { DEFAULT_RELAYS } from '#src/constants/relays.ts';
import { decodeRoomLink, parsePublicRoom, verifiedPublicEvent } from './publicGroups.ts';
import { previewUrl } from '#src/utils/linkPreview.ts';
import { PUBLIC_METADATA_INDEXERS } from './metadataIndexers.ts';

export interface AuthLinkTarget {
  type: 'group' | 'profile';
  pubkey: string;
  address?: string;
  slug?: string;
  relays: string[];
}
export interface AuthLinkPreview {
  name: string;
  picture: string;
}

export function authLinkTarget(href: string): AuthLinkTarget | null {
  if (href.length > 8192) return null;
  try {
    const url = new URL(href);
    if (url.pathname.startsWith('/public/') || /^\/join\/chat(?:\.html)?\/?$/.test(url.pathname)) {
      const room = decodeRoomLink(url.href);
      return { type: 'group', pubkey: room.owner, ...room };
    }
    const profile = chatLinkTarget(url.pathname);
    if (profile) return { type: 'profile', ...profile };
  } catch {
    // Invalid links never trigger discovery or interfere with authentication.
  }
  return null;
}

export function authLinkMetadata(
  target: AuthLinkTarget,
  event: NostrEvent,
): AuthLinkPreview | null {
  if (event.pubkey !== target.pubkey) return null;
  try {
    if (target.type === 'group') {
      const room = parsePublicRoom(event, target.address);
      return { name: room.name, picture: room.picture };
    }
    if (event.kind !== 0 || !verifiedPublicEvent(event)) return null;
    const profile = JSON.parse(event.content);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    const name = [profile.display_name, profile.name].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    return {
      name: (name || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 100),
      picture: typeof profile.picture === 'string' ? previewUrl(profile.picture) || '' : '',
    };
  } catch {
    return null;
  }
}

const cache = new Map<string, { expires: number; preview: AuthLinkPreview }>();
type PreviewRequest = {
  target: AuthLinkTarget;
  listeners: Set<(preview: AuthLinkPreview) => void>;
  latest?: AuthLinkPreview;
  cancel?: () => void;
};
const requests = new Map<string, PreviewRequest>();
let activeRequests = 0;

function pumpPreviews() {
  for (const [key, request] of requests) {
    if (activeRequests >= 3) break;
    if (request.cancel) continue;
    activeRequests++;
    request.cancel = fetchLinkPreview(
      request.target,
      (preview) => {
        request.latest = preview;
        for (const listener of request.listeners) listener(preview);
      },
      () => {
        requests.delete(key);
        request.listeners.clear();
        activeRequests--;
        queueMicrotask(pumpPreviews);
      },
    );
  }
}

/** Short, unauthenticated discovery isolated from account connections and message storage. */
export function watchAuthLinkPreview(
  target: AuthLinkTarget,
  update: (preview: AuthLinkPreview) => void,
): () => void {
  const key = target.address || target.pubkey;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    update(cached.preview);
    return () => {};
  }
  cache.delete(key);
  let request = requests.get(key);
  if (!request) {
    if (requests.size >= 64) return () => {};
    request = { target, listeners: new Set() };
    requests.set(key, request);
  }
  request.listeners.add(update);
  if (request.latest) update(request.latest);
  pumpPreviews();
  return () => {
    request.listeners.delete(update);
    if (request.listeners.size || requests.get(key) !== request) return;
    if (request.cancel) request.cancel();
    else requests.delete(key);
  };
}

function fetchLinkPreview(
  target: AuthLinkTarget,
  update: (preview: AuthLinkPreview) => void,
  done: () => void,
): () => void {
  const key = target.address || target.pubkey;
  // Bare public keys carry no relay hints. Reserve discovery slots for metadata
  // indexers while still giving explicit nprofile hints priority.
  const candidates =
    target.type === 'profile'
      ? [
          ...target.relays.slice(0, 2),
          ...PUBLIC_METADATA_INDEXERS,
          ...target.relays.slice(2),
          ...DEFAULT_RELAYS,
        ]
      : [...target.relays, ...DEFAULT_RELAYS];
  const relays = [
    ...new Set(
      candidates.flatMap((value) => {
        try {
          const url = new URL(value);
          if (url.username || url.password || url.hash) return [];
          // Local fixture relays are only allowed in development builds.
          if (
            import.meta.env.DEV &&
            url.protocol === 'ws:' &&
            ['localhost', '127.0.0.1'].includes(url.hostname)
          )
            return [url.href];
          return url.protocol === 'wss:' && previewUrl(value.replace(/^wss:/, 'https:'))
            ? [url.href]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(0, 4);
  const client = new NostrClient({ authenticate: false });
  let stopped = false;
  let received = 0;
  let newest: NostrEvent | undefined;
  let preview: AuthLinkPreview | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    subscription.stop();
    // Let queued CLOSE frames flush before closing these dedicated sockets.
    queueMicrotask(() => {
      for (const relay of client.pool.relays.values()) relay.disconnect();
    });
    if (preview) {
      cache.set(key, { expires: Date.now() + 300_000, preview });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    done();
  };
  const timer = setTimeout(stop, 5000);
  const subscription = client.subscribe(
    {
      kinds: [target.type === 'group' ? 34550 : 0],
      authors: [target.pubkey],
      ...(target.type === 'group' ? { '#d': [target.slug!] } : {}),
      limit: 1,
    },
    {
      relayUrls: relays,
      closeOnEose: true,
      onClose: stop,
      onEvent(event) {
        if (stopped) return;
        if (++received > 32) return stop();
        const raw = event.rawEvent();
        const parsed = authLinkMetadata(target, raw);
        if (
          !parsed ||
          (newest &&
            (raw.created_at < newest.created_at ||
              (raw.created_at === newest.created_at && raw.id! >= newest.id!)))
        )
          return;
        newest = raw;
        preview = parsed;
        update(parsed);
      },
    },
  );
  return stop;
}
