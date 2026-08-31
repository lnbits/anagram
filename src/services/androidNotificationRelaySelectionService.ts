import { normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { useNip65RelayStore } from 'src/stores/nip65RelayStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { useRelayStore } from 'src/stores/relayStore';

const ANDROID_NOTIFICATION_RELAY_SELECTION_STORAGE_KEY =
  'ui-android-relay-notifications-selected-relays';
const DEFAULT_USER_RELAY_LIMIT = 3;

export type AndroidNotificationRelaySource = 'user' | 'app' | 'group';

export interface AndroidNotificationRelayCandidate {
  url: string;
  sources: AndroidNotificationRelaySource[];
  available: boolean;
}

export interface AndroidNotificationRelayChoices {
  candidates: AndroidNotificationRelayCandidate[];
  selectedRelayUrls: string[];
  hasSavedSelection: boolean;
}

export class AndroidNotificationRelaySelectionError extends Error {
  override readonly name = 'AndroidNotificationRelaySelectionError';
}

interface AndroidNotificationRelayCandidateInput {
  userRelayUrls: string[];
  appRelayUrls: string[];
  groupRelayUrls: string[];
  selectedRelayUrls?: string[];
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeRelayUrls(relayUrls: string[]): string[] {
  const normalizedRelayUrls = new Set<string>();
  for (const value of relayUrls) {
    try {
      const relayUrl = normalizeRelayUrl(value);
      if (relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://')) {
        normalizedRelayUrls.add(relayUrl);
      }
    } catch {}
  }
  return Array.from(normalizedRelayUrls);
}

function currentOwnerPubkey(): string | null {
  return inputSanitizerService.normalizeHexKey(useNostrStore().getLoggedInPublicKeyHex() ?? '');
}

function readStoredSelections(): Record<string, string[]> {
  if (!canUseStorage()) {
    return {};
  }

  try {
    const serialized = window.localStorage.getItem(
      ANDROID_NOTIFICATION_RELAY_SELECTION_STORAGE_KEY
    );
    if (!serialized) {
      return {};
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const selections: Record<string, string[]> = {};
    for (const [ownerPubkey, relayUrls] of Object.entries(parsed)) {
      const normalizedOwnerPubkey = inputSanitizerService.normalizeHexKey(ownerPubkey);
      if (!normalizedOwnerPubkey || !Array.isArray(relayUrls)) {
        continue;
      }
      selections[normalizedOwnerPubkey] = normalizeRelayUrls(
        relayUrls.filter((value): value is string => typeof value === 'string')
      );
    }
    return selections;
  } catch {
    return {};
  }
}

export function createAndroidNotificationRelayCandidates({
  userRelayUrls,
  appRelayUrls,
  groupRelayUrls,
  selectedRelayUrls = [],
}: AndroidNotificationRelayCandidateInput): AndroidNotificationRelayCandidate[] {
  const candidates = new Map<
    string,
    { sources: Set<AndroidNotificationRelaySource>; available: boolean }
  >();

  function addRelayUrls(relayUrls: string[], source: AndroidNotificationRelaySource): void {
    for (const relayUrl of normalizeRelayUrls(relayUrls)) {
      const candidate = candidates.get(relayUrl) ?? {
        sources: new Set<AndroidNotificationRelaySource>(),
        available: true,
      };
      candidate.sources.add(source);
      candidate.available = true;
      candidates.set(relayUrl, candidate);
    }
  }

  addRelayUrls(userRelayUrls, 'user');
  addRelayUrls(appRelayUrls, 'app');
  addRelayUrls(groupRelayUrls, 'group');

  for (const relayUrl of normalizeRelayUrls(selectedRelayUrls)) {
    if (!candidates.has(relayUrl)) {
      candidates.set(relayUrl, {
        sources: new Set<AndroidNotificationRelaySource>(),
        available: false,
      });
    }
  }

  return Array.from(candidates, ([url, candidate]) => ({
    url,
    sources: Array.from(candidate.sources),
    available: candidate.available,
  }));
}

export function createDefaultAndroidNotificationRelaySelection(
  candidates: AndroidNotificationRelayCandidate[]
): string[] {
  const userRelays = candidates
    .filter((candidate) => candidate.available && candidate.sources.includes('user'))
    .slice(0, DEFAULT_USER_RELAY_LIMIT)
    .map((candidate) => candidate.url);
  if (userRelays.length > 0) {
    return userRelays;
  }

  const appRelay = candidates.find(
    (candidate) => candidate.available && candidate.sources.includes('app')
  );
  return appRelay ? [appRelay.url] : [];
}

export function readAndroidNotificationRelaySelection(): string[] | null {
  const ownerPubkey = currentOwnerPubkey();
  if (!ownerPubkey) {
    return null;
  }
  const selections = readStoredSelections();
  return Object.hasOwn(selections, ownerPubkey) ? (selections[ownerPubkey] ?? []) : null;
}

export function saveAndroidNotificationRelaySelection(relayUrls: string[]): string[] {
  const ownerPubkey = currentOwnerPubkey();
  if (!ownerPubkey) {
    throw new Error('A logged-in public key is required to save notification relays.');
  }
  if (!canUseStorage()) {
    throw new Error('Notification relay selection storage is unavailable.');
  }

  const normalizedRelayUrls = normalizeRelayUrls(relayUrls);
  const selections = readStoredSelections();
  selections[ownerPubkey] = normalizedRelayUrls;
  window.localStorage.setItem(
    ANDROID_NOTIFICATION_RELAY_SELECTION_STORAGE_KEY,
    JSON.stringify(selections)
  );
  return normalizedRelayUrls;
}

async function listAndroidNotificationRelayCandidates(
  selectedRelayUrls: string[]
): Promise<AndroidNotificationRelayCandidate[]> {
  const relayStore = useRelayStore();
  const nip65RelayStore = useNip65RelayStore();
  const nostrStore = useNostrStore();
  relayStore.init();
  nip65RelayStore.init();

  await Promise.all([chatDataService.init(), contactsService.init()]);
  const [chats, contacts] = await Promise.all([
    chatDataService.listChats(),
    contactsService.listContacts(),
  ]);
  const groupPubkeys = new Set(
    chats.flatMap((chat) => {
      if (chat.type !== 'group') {
        return [];
      }
      const pubkey = inputSanitizerService.normalizeHexKey(chat.public_key);
      return pubkey ? [pubkey] : [];
    })
  );

  const groupRelayUrls = contacts.flatMap((contact) => {
    const pubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
    if (contact.type !== 'group' || !pubkey || !groupPubkeys.has(pubkey)) {
      return [];
    }
    return inputSanitizerService.normalizeReadableRelayUrls(contact.relays);
  });

  const userRelayUrls = nip65RelayStore.relayEntries
    .filter((entry) => entry.read)
    .map((entry) => entry.url)
    .sort((first, second) => {
      let firstConnected = false;
      let secondConnected = false;
      try {
        firstConnected = nostrStore.getRelayConnectionState(first) === 'connected';
      } catch {}
      try {
        secondConnected = nostrStore.getRelayConnectionState(second) === 'connected';
      } catch {}
      return Number(secondConnected) - Number(firstConnected);
    });

  return createAndroidNotificationRelayCandidates({
    userRelayUrls,
    appRelayUrls: relayStore.relayEntries.filter((entry) => entry.read).map((entry) => entry.url),
    groupRelayUrls,
    selectedRelayUrls,
  });
}

export async function loadAndroidNotificationRelayChoices(): Promise<AndroidNotificationRelayChoices> {
  const savedSelection = readAndroidNotificationRelaySelection();
  const candidates = await listAndroidNotificationRelayCandidates(savedSelection ?? []);
  return {
    candidates,
    selectedRelayUrls: savedSelection ?? createDefaultAndroidNotificationRelaySelection(candidates),
    hasSavedSelection: savedSelection !== null,
  };
}

export async function resolveSelectedAndroidNotificationRelayUrls(): Promise<string[]> {
  const selectedRelayUrls = readAndroidNotificationRelaySelection();
  if (!selectedRelayUrls || selectedRelayUrls.length === 0) {
    throw new AndroidNotificationRelaySelectionError(
      'Choose at least one relay for Android notifications.'
    );
  }

  const candidates = await listAndroidNotificationRelayCandidates(selectedRelayUrls);
  const availableRelayUrls = new Set(
    candidates.filter((candidate) => candidate.available).map((candidate) => candidate.url)
  );
  const activeSelection = selectedRelayUrls.filter((relayUrl) => availableRelayUrls.has(relayUrl));
  if (activeSelection.length === 0) {
    throw new AndroidNotificationRelaySelectionError(
      'None of the selected Android notification relays are currently available.'
    );
  }
  return activeSelection;
}
