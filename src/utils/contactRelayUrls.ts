import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { ContactRelay } from '#src/types/contact.ts';

export function resolvePreferredContactRelayUrls(relays: ContactRelay[] | undefined): string[] {
  const contactRelays = Array.isArray(relays) ? relays : [];
  // Flags describe the contact's usage: deliver to where they READ. NIP-17
  // inboxes are stored as read:true/write:false, so selecting their outbox
  // silently excluded those inboxes whenever a write-only relay also existed.
  const preferredRelays = contactRelays
    .filter((relay) => relay.read !== false)
    .map((relay) => relay.url);
  const fallbackRelays = contactRelays.map((relay) => relay.url);

  return inputSanitizerService.normalizeStringArray(
    preferredRelays.length > 0 ? preferredRelays : fallbackRelays
  );
}
