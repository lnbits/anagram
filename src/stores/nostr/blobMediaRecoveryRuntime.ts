import NostrClient, {
  ClientEvent,
  NostrKind,
  NostrSubscriptionCacheUsage,
} from '#src/lib/nostr/client.ts';
import {
  createBlossomMediaRecoveryService,
  type BlossomMediaRecoveryTarget,
} from '#src/services/blossomMediaRecoveryService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { metadataIndexerFallbacks } from '#src/stores/nostr/metadataIndexers.ts';
import {
  createReadyRelaySet,
  fetchEventWithRelayTimeout,
} from '#src/stores/nostr/relayQueryUtils.ts';
import { blossomServerUrlsFromTagsValue } from '#src/utils/blossomServerList.ts';
import { resolvePreferredContactRelayUrls } from '#src/utils/contactRelayUrls.ts';
import { uniqueRelayUrls } from '#src/utils/relayUrls.ts';

const AUTHOR_SERVER_LIST_TTL_MS = 10 * 60 * 1000;

interface BlobMediaRecoveryRuntimeDeps {
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  getLoggedInPublicKeyHex: () => string | null;
  ndk: NostrClient;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
}

/**
 * Recovers dead media links the way NIP-B7 describes: when a stored Blossom link 404s, the
 * same file is looked for on the other servers the author published in their kind 10063
 * list. Only bytes whose SHA-256 matches the hash in the link are handed back.
 *
 * Nothing is read until a link actually fails, and each author's list is kept for ten
 * minutes - the list is public data, so it is safe to hold for the session, but the
 * verified media itself is dropped on logout.
 */
export function createBlobMediaRecoveryRuntime({
  ensureRelayConnections,
  getLoggedInPublicKeyHex,
  ndk,
  resolveLoggedInReadRelayUrls,
}: BlobMediaRecoveryRuntimeDeps) {
  const authorServerLists = new Map<string, { fetchedAt: number; serverUrls: string[] }>();
  const pendingAuthorLookups = new Map<string, Promise<string[]>>();
  const recoveryService = createBlossomMediaRecoveryService({
    readAuthorBlossomServerUrls: (publicKey) => readAuthorBlossomServerUrls(publicKey),
  });

  async function resolveAuthorRelayUrls(publicKey: string): Promise<string[]> {
    const readRelayUrls = await resolveLoggedInReadRelayUrls();
    let contactRelayUrls: string[] = [];
    try {
      await contactsService.init();
      const contact = await contactsService.getContactByPublicKey(publicKey);
      contactRelayUrls = resolvePreferredContactRelayUrls(contact?.relays);
    } catch {
      // A missing contact only costs the author's own relays; ours still answer.
    }

    return uniqueRelayUrls([
      ...contactRelayUrls,
      ...readRelayUrls,
      ...metadataIndexerFallbacks(readRelayUrls),
    ]);
  }

  async function fetchAuthorBlossomServerUrls(publicKey: string): Promise<string[]> {
    if (!getLoggedInPublicKeyHex()) {
      return [];
    }

    const relayUrls = await resolveAuthorRelayUrls(publicKey);
    if (!relayUrls.length) {
      return [];
    }

    await ensureRelayConnections(relayUrls);
    const serverListEvent = await fetchEventWithRelayTimeout(
      ndk,
      { kinds: [NostrKind.BlossomServerList], authors: [publicKey], limit: 1 },
      { cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY },
      createReadyRelaySet(ndk, relayUrls),
    );
    if (!serverListEvent) {
      return [];
    }

    const event =
      serverListEvent instanceof ClientEvent
        ? serverListEvent
        : new ClientEvent(ndk, serverListEvent);
    return blossomServerUrlsFromTagsValue(event.tags);
  }

  function readAuthorBlossomServerUrls(publicKey: string): Promise<string[]> {
    const cached = authorServerLists.get(publicKey);
    if (cached && Date.now() - cached.fetchedAt < AUTHOR_SERVER_LIST_TTL_MS) {
      return Promise.resolve(cached.serverUrls);
    }

    const pending = pendingAuthorLookups.get(publicKey);
    if (pending) {
      return pending;
    }

    const lookup = fetchAuthorBlossomServerUrls(publicKey)
      .then((serverUrls) => {
        // Only a query that actually answered is remembered: a relay failure is retried.
        authorServerLists.set(publicKey, { fetchedAt: Date.now(), serverUrls });
        return serverUrls;
      })
      .catch(() => [])
      .finally(() => {
        pendingAuthorLookups.delete(publicKey);
      });
    pendingAuthorLookups.set(publicKey, lookup);
    return lookup;
  }

  function recoverMedia(target: BlossomMediaRecoveryTarget): Promise<Blob | null> {
    return recoveryService.recoverMedia(target);
  }

  function resetBlobMediaRecoveryRuntimeState(): void {
    authorServerLists.clear();
    pendingAuthorLookups.clear();
    recoveryService.reset();
  }

  return { readAuthorBlossomServerUrls, recoverMedia, resetBlobMediaRecoveryRuntimeState };
}
