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
): Promise<Array<{ publicKey: string; relayUrls: string[] }>> {
  await Promise.all([contactsService.init(), chatDataService.init()]);
  const contacts = await contactsService.listContacts();
  const chats = await chatDataService.listChats();
  const routes = new Map<string, string[]>();
  for (const chat of chats) {
    if (chat.type !== 'group') continue;
    const contact = contacts.find((entry) => entry.public_key === chat.public_key);
    const relayUrls = inputSanitizerService.normalizeReadableRelayUrls(contact?.relays);
    for (const epoch of resolveGroupChatEpochEntriesValue(chat))
      routes.set(epoch.epoch_public_key, relayUrls);
  }
  return recipientPubkeys.map((publicKey) => {
    const known = routes.get(publicKey);
    return {
      publicKey,
      relayUrls: known?.length
        ? known
        : normalizeRelayStatusUrlsValue(personalRelayUrls).slice(0, known ? 2 : undefined),
    };
  });
}
