import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  normalizeRelayStatusUrlsValue,
  resolveGroupChatEpochEntriesValue,
} from 'src/stores/nostr/valueUtils';

export async function resolvePrivateMessageRelayScopes(
  recipientPubkeys: string[],
  personalRelayUrls: string[]
): Promise<Array<{ publicKey: string; relayUrls: string[]; since?: number }>> {
  await Promise.all([contactsService.init(), chatDataService.init()]);
  const contacts = await contactsService.listContacts();
  const chats = await chatDataService.listChats();
  const routes = new Map<string, string[]>();
  const boundaries = new Map<string, number>();
  for (const chat of chats) {
    if (chat.type !== 'group') continue;
    const contact = contacts.find((entry) => entry.public_key === chat.public_key);
    const relayUrls = inputSanitizerService.normalizeReadableRelayUrls(contact?.relays);
    for (const epoch of resolveGroupChatEpochEntriesValue(chat)) {
      routes.set(epoch.epoch_public_key, relayUrls);
      const issued = Date.parse(epoch.invitation_created_at ?? '');
      if (Number.isFinite(issued))
        boundaries.set(
          epoch.epoch_public_key,
          Math.max(0, Math.floor(issued / 1000) - 2 * 24 * 60 * 60)
        );
    }
  }
  return [
    ...new Set(
      recipientPubkeys
        .map((key) => inputSanitizerService.normalizeHexKey(key))
        .filter((key): key is string => Boolean(key))
    ),
  ].map((publicKey) => {
    const known = routes.get(publicKey);
    return {
      publicKey,
      ...(boundaries.has(publicKey) ? { since: boundaries.get(publicKey) } : {}),
      relayUrls: known?.length
        ? known
        : normalizeRelayStatusUrlsValue(personalRelayUrls).slice(0, known ? 2 : undefined),
    };
  });
}
