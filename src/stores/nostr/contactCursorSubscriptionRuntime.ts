import NostrClient, {
  ClientEvent,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
} from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import {
  CONTACT_CURSOR_FETCH_BATCH_SIZE,
  PRIVATE_PREFERENCES_KIND,
} from '#src/stores/nostr/constants.ts';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import type { ContactCursorContent } from '#src/stores/nostr/types.ts';
import type { ContactRecord } from '#src/types/contact.ts';

interface Deps {
  ndk: NostrClient;
  getLoggedInPublicKeyHex(): string | null;
  deriveContactCursorDTag(publicKey: string): Promise<string | null>;
  resolveLoggedInReadRelayUrls(seedRelayUrls?: string[]): Promise<string[]>;
  ensureRelayConnections(relayUrls: string[]): Promise<void>;
  decryptContactCursorContent(content: string): Promise<ContactCursorContent | null>;
  compareContactCursorState(first: ContactCursorContent, second: ContactCursorContent): number;
  observeContactCursorEvent(dTag: string, createdAt: number): void;
  applyContactCursorStateToContact(
    contact: ContactRecord,
    cursor: ContactCursorContent,
    current: () => boolean,
  ): Promise<boolean>;
  reloadReadState(current: () => boolean): Promise<void>;
}

// Keep account cursors live after startup. Each subscription requests only the
// encrypted records for known contacts; it never fetches message history.
export function createContactCursorSubscriptionRuntime(deps: Deps) {
  const subscriptions = createDesiredSubscriptions();
  let generation = 0;
  let refreshVersion = 0;
  let applyQueue = Promise.resolve();
  const applied = new Map<string, ContactCursorContent>();

  async function subscribe(seedRelayUrls: string[] = []): Promise<void> {
    const owner = deps.getLoggedInPublicKeyHex();
    const token = generation;
    const version = ++refreshVersion;
    const current = () => token === generation && owner === deps.getLoggedInPublicKeyHex();
    if (!owner) {
      reset();
      return;
    }
    const [contacts, relays] = await Promise.all([
      contactsService.listContacts(),
      deps.resolveLoggedInReadRelayUrls(seedRelayUrls),
    ]);
    if (!current() || version !== refreshVersion) return;
    const entries = await Promise.all(
      contacts.map(async (contact) => {
        const dTag = await deps.deriveContactCursorDTag(contact.public_key);
        return dTag ? ([dTag, contact.public_key] as const) : null;
      }),
    );
    if (!current() || version !== refreshVersion) return;
    const targets = new Map(entries.filter((entry) => entry !== null));
    const tags = [...targets.keys()].sort();
    const desired = [];
    for (
      let offset = 0;
      relays.length && offset < tags.length;
      offset += CONTACT_CURSOR_FETCH_BATCH_SIZE
    ) {
      const batch = tags.slice(offset, offset + CONTACT_CURSOR_FETCH_BATCH_SIZE);
      const filters = [{ kinds: [PRIVATE_PREFERENCES_KIND], authors: [owner], '#d': batch }];
      desired.push({
        key: `contact-cursors:${offset}`,
        signature: subscriptionSignature(filters, relays),
        prepare: () => deps.ensureRelayConnections(relays),
        applied: () => applyQueue,
        start: (
          onEose: () => void,
          onClose: () => void,
          onInitialSync: (completed: string[], pending: string[]) => void,
        ) =>
          deps.ndk.subscribe(filters, {
            relaySet: NostrRelaySet.fromRelayUrls(relays, deps.ndk, false),
            cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
            onEose,
            onClose,
            onInitialSync,
            onEvent: (incoming) => {
              const event =
                incoming instanceof ClientEvent ? incoming : new ClientEvent(deps.ndk, incoming);
              if (
                !current() ||
                event.pubkey !== owner ||
                event.kind !== PRIVATE_PREFERENCES_KIND ||
                !event.verifySignature()
              )
                return;
              const dTags = event.getMatchingTags('d');
              const dTag = dTags.length === 1 ? dTags[0]?.[1] : undefined;
              const publicKey = dTag && batch.includes(dTag) ? targets.get(dTag) : undefined;
              if (!publicKey) return;
              applyQueue = applyQueue
                .then(async () => {
                  if (!current()) return;
                  const cursor = await deps.decryptContactCursorContent(event.content);
                  if (!current() || !cursor) return;
                  deps.observeContactCursorEvent(dTag!, event.created_at ?? 0);
                  const previous = applied.get(publicKey);
                  if (previous && deps.compareContactCursorState(cursor, previous) <= 0) return;
                  const contact = await contactsService.getContactByPublicKey(publicKey);
                  if (!current() || !contact) return;
                  const changed = await deps.applyContactCursorStateToContact(
                    contact,
                    cursor,
                    current,
                  );
                  if (!current()) return;
                  applied.set(publicKey, cursor);
                  if (changed) await deps.reloadReadState(current);
                })
                .catch((error) => {
                  if (current()) console.warn('Failed to apply contact read status', error);
                });
            },
          }),
      });
    }
    await subscriptions.reconcile(desired);
  }

  function reset(): void {
    generation++;
    refreshVersion++;
    subscriptions.stop();
    applyQueue = Promise.resolve();
    applied.clear();
  }

  return { subscribe, reset };
}
