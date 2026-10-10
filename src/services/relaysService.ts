import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { ContactRelay } from '#src/types/contact.ts';

function normalizeRelayValue(value: unknown): ContactRelay | null {
  if (typeof value === 'string') {
    const relayWs = inputSanitizerService.normalizeRelayWs(value);
    if (!relayWs) {
      return null;
    }

    return {
      url: relayWs,
      read: true,
      write: true,
    };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const relay = value as Partial<ContactRelay>;
  const relayWs = inputSanitizerService.normalizeRelayWs(String(relay.url ?? ''));
  if (!relayWs) {
    return null;
  }

  const normalizedRelay: ContactRelay = {
    url: relayWs,
    read: relay.read !== false,
    write: relay.write !== false,
  };

  if (!normalizedRelay.read && !normalizedRelay.write) {
    return null;
  }

  return normalizedRelay;
}

function compareRelayUrls(first: string, second: string): number {
  const byValue = first.localeCompare(second, undefined, { sensitivity: 'base' });
  if (byValue !== 0) {
    return byValue;
  }

  return first.localeCompare(second);
}

function normalizeRelayList(value: unknown): ContactRelay[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byUrl = new Map<string, ContactRelay>();
  for (const entry of value) {
    const relay = normalizeRelayValue(entry);
    if (!relay) {
      continue;
    }

    const key = relay.url.toLowerCase();
    const existingRelay = byUrl.get(key);
    if (existingRelay) {
      existingRelay.read = existingRelay.read || relay.read;
      existingRelay.write = existingRelay.write || relay.write;
      continue;
    }

    byUrl.set(key, relay);
  }

  return Array.from(byUrl.values()).sort((first, second) =>
    compareRelayUrls(first.url, second.url)
  );
}

class RelaysService {
  async init(): Promise<void> {
    await contactsService.init();
  }

  async listRelaysByPublicKey(publicKey: string): Promise<ContactRelay[]> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    if (!normalizedPublicKey) {
      return [];
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return [];
    }

    return normalizeRelayList(contact.relays ?? []);
  }

  async listAllRelays(): Promise<string[]> {
    await contactsService.init();
    const contacts = await contactsService.listContacts();
    const uniqueRelayUrls = new Set<string>();

    for (const contact of contacts) {
      for (const relay of normalizeRelayList(contact.relays ?? [])) {
        uniqueRelayUrls.add(relay.url);
      }
    }

    return Array.from(uniqueRelayUrls).sort(compareRelayUrls);
  }

  async createRelay(publicKey: string, relay: ContactRelay): Promise<boolean> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    const normalizedRelay = normalizeRelayValue(relay);
    if (!normalizedPublicKey || !normalizedRelay) {
      return false;
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return false;
    }

    const currentRelays = normalizeRelayList(contact.relays ?? []);
    if (
      currentRelays.some((entry) => entry.url.toLowerCase() === normalizedRelay.url.toLowerCase())
    ) {
      return false;
    }

    const nextRelays = normalizeRelayList([...currentRelays, normalizedRelay]);
    const updatedContact = await contactsService.updateContact(contact.id, { relays: nextRelays });
    return Boolean(updatedContact);
  }

  async updateRelay(
    publicKey: string,
    previousRelayWs: string,
    nextRelay: ContactRelay
  ): Promise<boolean> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    const normalizedPreviousRelayWs = inputSanitizerService.normalizeRelayWs(previousRelayWs);
    const normalizedNextRelay = normalizeRelayValue(nextRelay);
    if (!normalizedPublicKey || !normalizedPreviousRelayWs || !normalizedNextRelay) {
      return false;
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return false;
    }

    const currentRelays = normalizeRelayList(contact.relays ?? []);
    const previousRelayIndex = currentRelays.findIndex(
      (relayEntry) => relayEntry.url.toLowerCase() === normalizedPreviousRelayWs.toLowerCase()
    );
    if (previousRelayIndex < 0) {
      return false;
    }

    const hasConflict = currentRelays.some((relayEntry, index) => {
      return (
        index !== previousRelayIndex &&
        relayEntry.url.toLowerCase() === normalizedNextRelay.url.toLowerCase()
      );
    });
    if (hasConflict) {
      return false;
    }

    const nextRelays = [...currentRelays];
    nextRelays.splice(previousRelayIndex, 1, normalizedNextRelay);
    const updatedContact = await contactsService.updateContact(contact.id, {
      relays: normalizeRelayList(nextRelays),
    });

    return Boolean(updatedContact);
  }

  async deleteRelay(publicKey: string, relayWs: string): Promise<boolean> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    const normalizedRelayWs = inputSanitizerService.normalizeRelayWs(relayWs);
    if (!normalizedPublicKey || !normalizedRelayWs) {
      return false;
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return false;
    }

    const currentRelays = normalizeRelayList(contact.relays ?? []);
    const nextRelays = currentRelays.filter(
      (relayEntry) => relayEntry.url.toLowerCase() !== normalizedRelayWs.toLowerCase()
    );
    if (nextRelays.length === currentRelays.length) {
      return false;
    }

    const updatedContact = await contactsService.updateContact(contact.id, { relays: nextRelays });
    return Boolean(updatedContact);
  }

  async replaceRelaysForPublicKey(
    publicKey: string,
    relays: ContactRelay[]
  ): Promise<ContactRelay[]> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    if (!normalizedPublicKey) {
      return [];
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return [];
    }

    const nextRelays = normalizeRelayList(relays);
    const updatedContact = await contactsService.updateContact(contact.id, { relays: nextRelays });
    if (!updatedContact) {
      return this.listRelaysByPublicKey(normalizedPublicKey);
    }

    return normalizeRelayList(updatedContact.relays ?? []);
  }

  async deleteRelaysForPublicKey(publicKey: string): Promise<boolean> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    if (!normalizedPublicKey) {
      return false;
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return false;
    }

    if (normalizeRelayList(contact.relays ?? []).length === 0) {
      return false;
    }

    const updatedContact = await contactsService.updateContact(contact.id, { relays: [] });
    return Boolean(updatedContact);
  }
}

export const relaysService = new RelaysService();
