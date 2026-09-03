import { Capacitor, type PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { NDKPrivateKeySigner, type NostrEvent, normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import {
  AndroidNotificationRelaySelectionError,
  resolveSelectedAndroidNotificationRelayUrls,
} from 'src/services/androidNotificationRelaySelectionService';
import { readAndroidSecurePrivateKeyHex } from 'src/services/androidSecurePrivateKeyStorage';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { resolveCurrentGroupChatEpochEntryValue } from 'src/stores/nostr/valueUtils';
import { useNostrStore } from 'src/stores/nostrStore';
import type { Chat } from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';
import { buildAvatarText } from 'src/utils/avatarText';
import type { RouteLocationRaw } from 'vue-router';

const ANDROID_RELAY_NOTIFICATIONS_STORAGE_KEY = 'ui-android-relay-notifications';
const ANDROID_RELAY_START_ON_BOOT_STORAGE_KEY = 'ui-android-relay-notifications-start-on-boot';
const ANDROID_RELAY_CONVERSATION_DETAILS_STORAGE_KEY =
  'ui-android-relay-notifications-conversation-details';

export type AndroidRelayNotificationPermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'unsupported';

export interface AndroidRelayNotificationState {
  enabled: boolean;
  startOnBoot: boolean;
  showConversationDetails: boolean;
  permission: AndroidRelayNotificationPermissionState;
}

export interface AndroidNotificationWatchPlan {
  ownerPubkey: string;
  relays: string[];
  recipientPubkeys: string[];
}

interface AndroidNotificationConversation {
  chatPubkey: string;
  recipientPubkey?: string;
  name: string;
  avatarUrl: string;
  avatarText: string;
  policyEligible: boolean;
  notificationsEnabled: boolean;
}

interface AndroidNotificationRecipientKey {
  recipientPubkey: string;
  privateKey: string;
}

interface AndroidNotificationConfiguration extends AndroidNotificationWatchPlan {
  conversations: AndroidNotificationConversation[];
  recipientKeys: AndroidNotificationRecipientKey[];
  showConversationDetails: boolean;
}

interface AndroidRelayNotificationsPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  configure(
    options: AndroidNotificationConfiguration & {
      startOnBoot: boolean;
    }
  ): Promise<AndroidRelayNotificationState>;
  stop(): Promise<AndroidRelayNotificationState>;
  setStartOnBoot(options: { enabled: boolean }): Promise<AndroidRelayNotificationState>;
  getState(): Promise<AndroidRelayNotificationState>;
  getPendingEvents(options: { limit: number; ownerPubkey: string }): Promise<{ events: unknown[] }>;
  acknowledgePendingEvents(options: { eventIds: string[]; ownerPubkey: string }): Promise<void>;
  clearDeliveredNotifications(options?: { chatPubkey?: string }): Promise<void>;
  addListener(
    eventName: 'notificationActionPerformed',
    listener: (event: { chatPubkey?: string; openChats?: boolean }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'pendingEventsAvailable',
    listener: () => void
  ): Promise<PluginListenerHandle>;
}

const AndroidRelayNotifications = registerPlugin<AndroidRelayNotificationsPlugin>(
  'AndroidRelayNotifications'
);

let didInstallNotificationListeners = false;
const ANDROID_NOTIFICATION_REFRESH_DEBOUNCE_MS = 250;
const decryptedGroupEpochPrivateKeyCache = new Map<string, string | null>();
let lastAppliedConfigurationSignature: string | null = null;
let refreshCoordinatorPromise: Promise<void> | null = null;
let resolveRefreshCoordinator: (() => void) | null = null;
let rejectRefreshCoordinator: ((error: unknown) => void) | null = null;
let refreshDebounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
let isRefreshInProgress = false;
let isRefreshRequested = false;
const ANDROID_PENDING_EVENT_BATCH_SIZE = 50;
const ANDROID_PENDING_EVENT_MAX_BATCHES_PER_DRAIN = 10;
const HEX_128_PATTERN = /^[0-9a-f]{128}$/;
let pendingEventDrainPromise: Promise<void> | null = null;
let isPendingEventDrainRequested = false;

export interface AndroidRelayPendingEvent {
  event: NostrEvent;
  eventId: string;
  recipientPubkey: string;
  relayUrl: string;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizePermission(value: string): AndroidRelayNotificationPermissionState {
  if (value === 'granted' || value === 'denied') {
    return value;
  }
  return 'prompt';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePendingRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const relayUrl = normalizeRelayUrl(value);
    return relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://') ? relayUrl : null;
  } catch {
    return null;
  }
}

function parseAndroidRelayPendingEvent(value: unknown): AndroidRelayPendingEvent | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.event)) {
    return null;
  }

  const eventId = inputSanitizerService.normalizeHexKey(String(value.id ?? ''));
  const recipientPubkey = inputSanitizerService.normalizeHexKey(
    String(value.recipientPubkey ?? '')
  );
  const relayUrl = normalizePendingRelayUrl(value.relayUrl);
  const rawEvent = value.event;
  const rawEventId = inputSanitizerService.normalizeHexKey(String(rawEvent.id ?? ''));
  const pubkey = inputSanitizerService.normalizeHexKey(String(rawEvent.pubkey ?? ''));
  const signature = typeof rawEvent.sig === 'string' ? rawEvent.sig.trim().toLowerCase() : '';
  const tags = Array.isArray(rawEvent.tags)
    ? rawEvent.tags.filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.length > 0 && tag.every((entry) => typeof entry === 'string')
      )
    : [];
  const createdAt = Number(rawEvent.created_at);

  if (
    !eventId ||
    rawEventId !== eventId ||
    !recipientPubkey ||
    !relayUrl ||
    !pubkey ||
    !HEX_128_PATTERN.test(signature) ||
    rawEvent.kind !== 1059 ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    typeof rawEvent.content !== 'string' ||
    !Array.isArray(rawEvent.tags) ||
    tags.length !== rawEvent.tags.length ||
    !tags.some((tag) => tag[0] === 'p' && tag[1]?.toLowerCase() === recipientPubkey)
  ) {
    return null;
  }

  return {
    eventId,
    recipientPubkey,
    relayUrl,
    event: {
      id: eventId,
      pubkey,
      sig: signature,
      kind: 1059,
      created_at: createdAt,
      content: rawEvent.content,
      tags: tags.map((tag) => [...tag]),
    },
  };
}

export function isAndroidRelayNotificationSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function readAndroidRelayNotificationsPreference(): boolean {
  if (!canUseStorage()) {
    return false;
  }
  return window.localStorage.getItem(ANDROID_RELAY_NOTIFICATIONS_STORAGE_KEY) === '1';
}

export function saveAndroidRelayNotificationsPreference(enabled: boolean): void {
  if (canUseStorage()) {
    window.localStorage.setItem(ANDROID_RELAY_NOTIFICATIONS_STORAGE_KEY, enabled ? '1' : '0');
  }
}

export function readAndroidRelayStartOnBootPreference(): boolean {
  if (!canUseStorage()) {
    return true;
  }
  return window.localStorage.getItem(ANDROID_RELAY_START_ON_BOOT_STORAGE_KEY) !== '0';
}

export function readAndroidRelayConversationDetailsPreference(): boolean {
  if (!canUseStorage()) {
    return true;
  }
  return window.localStorage.getItem(ANDROID_RELAY_CONVERSATION_DETAILS_STORAGE_KEY) !== '0';
}

function saveAndroidRelayStartOnBootPreference(enabled: boolean): void {
  if (canUseStorage()) {
    window.localStorage.setItem(ANDROID_RELAY_START_ON_BOOT_STORAGE_KEY, enabled ? '1' : '0');
  }
}

function saveAndroidRelayConversationDetailsPreference(enabled: boolean): void {
  if (canUseStorage()) {
    window.localStorage.setItem(
      ANDROID_RELAY_CONVERSATION_DETAILS_STORAGE_KEY,
      enabled ? '1' : '0'
    );
  }
}

export function clearAndroidRelayNotificationsPreference(): void {
  if (canUseStorage()) {
    window.localStorage.removeItem(ANDROID_RELAY_NOTIFICATIONS_STORAGE_KEY);
  }
}

export function createAndroidNotificationWatchPlan(input: {
  ownerPubkey: string;
  relayUrls: string[];
  watchedPubkeys: string[];
}): AndroidNotificationWatchPlan {
  const ownerPubkey = inputSanitizerService.normalizeHexKey(input.ownerPubkey);
  if (!ownerPubkey) {
    throw new Error('A logged-in public key is required for Android notifications.');
  }

  const relays = new Set<string>();
  for (const value of input.relayUrls) {
    try {
      const relayUrl = normalizeRelayUrl(value);
      if (relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://')) {
        relays.add(relayUrl);
      }
    } catch {}
  }
  if (relays.size === 0) {
    throw new Error('At least one readable relay is required for Android notifications.');
  }

  const recipientPubkeys = new Set<string>([ownerPubkey]);
  for (const value of input.watchedPubkeys) {
    const pubkey = inputSanitizerService.normalizeHexKey(value);
    if (pubkey) {
      recipientPubkeys.add(pubkey);
    }
  }

  return {
    ownerPubkey,
    relays: Array.from(relays).sort(),
    recipientPubkeys: Array.from(recipientPubkeys).sort(),
  };
}

function readMetaString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isConversationNotificationEnabled(meta: Record<string, unknown>): boolean {
  return (
    meta.muted !== true &&
    meta.blocked !== true &&
    meta.inbox_state !== 'blocked' &&
    !readMetaString(meta, 'blocked_at')
  );
}

function isContactNotificationSuppressed(
  contact: Pick<ContactRecord, 'meta'> | null | undefined
): boolean {
  return (
    contact?.meta.muted === true ||
    contact?.meta.blocked === true ||
    Boolean(contact?.meta.blocked_at?.trim())
  );
}

export function isAndroidDirectNotificationContactEligible(
  contact: Pick<ContactRecord, 'meta' | 'type'> | null | undefined
): boolean {
  return contact?.type === 'user' && contact.meta.private_contact_list_member === true;
}

export function isAndroidDirectNotificationConversationPolicyEligible(input: {
  chatMeta: Record<string, unknown>;
  contact: Pick<ContactRecord, 'meta' | 'type'> | null | undefined;
}): boolean {
  return (
    isAndroidDirectNotificationContactEligible(input.contact) ||
    readMetaString(input.chatMeta, 'inbox_state') === 'accepted' ||
    Boolean(readMetaString(input.chatMeta, 'accepted_at')) ||
    Boolean(readMetaString(input.chatMeta, 'last_outgoing_message_at'))
  );
}

export function isAndroidDirectNotificationConversationEnabled(input: {
  chatMeta: Record<string, unknown>;
  contact: Pick<ContactRecord, 'meta' | 'type'> | null | undefined;
}): boolean {
  return (
    isAndroidDirectNotificationConversationPolicyEligible(input) &&
    !isContactNotificationSuppressed(input.contact) &&
    isConversationNotificationEnabled(input.chatMeta)
  );
}

export function createAndroidNotificationConversationSignature(
  chats: Pick<Chat, 'avatar' | 'epochPublicKey' | 'meta' | 'name' | 'publicKey' | 'type'>[]
): string {
  return chats
    .map((chat) =>
      JSON.stringify({
        avatar: chat.avatar.trim(),
        acceptedAt: readMetaString(chat.meta, 'accepted_at'),
        blocked: chat.meta.blocked === true,
        blockedAt: readMetaString(chat.meta, 'blocked_at'),
        epochPublicKey: chat.epochPublicKey ?? '',
        inboxState: readMetaString(chat.meta, 'inbox_state'),
        lastOutgoingMessageAt: readMetaString(chat.meta, 'last_outgoing_message_at'),
        muted: chat.meta.muted === true,
        name: chat.name.trim(),
        picture: readMetaString(chat.meta, 'picture'),
        publicKey: chat.publicKey,
        type: chat.type,
      })
    )
    .sort()
    .join('|');
}

async function resolveLocalIdentityPrivateKey(ownerPubkey: string): Promise<string | null> {
  const nostrStore = useNostrStore();
  let securePrivateKey: string | null = null;
  try {
    securePrivateKey = await readAndroidSecurePrivateKeyHex();
  } catch (error) {
    console.warn('Failed to read the Android private key for detailed notifications.', error);
  }
  const candidates = [nostrStore.getPrivateKeyHex(), securePrivateKey];
  for (const candidate of candidates) {
    const privateKey = inputSanitizerService.normalizeHexKey(candidate ?? '');
    if (!privateKey) {
      continue;
    }
    try {
      if (
        inputSanitizerService.normalizeHexKey(new NDKPrivateKeySigner(privateKey).pubkey) ===
        ownerPubkey
      ) {
        return privateKey;
      }
    } catch {}
  }
  return null;
}

async function decryptGroupEpochPrivateKey(input: {
  encryptedPrivateKey: string;
  epochPubkey: string;
  identityPrivateKey: string;
  ownerPubkey: string;
}): Promise<string | null> {
  const cacheKey = `${input.ownerPubkey}:${input.epochPubkey}:${input.encryptedPrivateKey}`;
  if (decryptedGroupEpochPrivateKeyCache.has(cacheKey)) {
    return decryptedGroupEpochPrivateKeyCache.get(cacheKey) ?? null;
  }

  try {
    const identitySigner = new NDKPrivateKeySigner(input.identityPrivateKey);
    const identityUser = await identitySigner.user();
    const decrypted = inputSanitizerService.normalizeHexKey(
      await identitySigner.decrypt(identityUser, input.encryptedPrivateKey, 'nip44')
    );
    if (!decrypted) {
      decryptedGroupEpochPrivateKeyCache.set(cacheKey, null);
      return null;
    }
    const result =
      inputSanitizerService.normalizeHexKey(new NDKPrivateKeySigner(decrypted).pubkey) ===
      input.epochPubkey
        ? decrypted
        : null;
    decryptedGroupEpochPrivateKeyCache.set(cacheKey, result);
    return result;
  } catch {
    decryptedGroupEpochPrivateKeyCache.set(cacheKey, null);
    return null;
  }
}

async function buildAndroidNotificationConfiguration(): Promise<AndroidNotificationConfiguration> {
  const nostrStore = useNostrStore();
  const [relayUrls, watchedPubkeys] = await Promise.all([
    resolveSelectedAndroidNotificationRelayUrls(),
    nostrStore.listPrivateMessageRecipientPubkeys(),
  ]);

  const watchPlan = createAndroidNotificationWatchPlan({
    ownerPubkey: nostrStore.getLoggedInPublicKeyHex() ?? '',
    relayUrls,
    watchedPubkeys,
  });
  const showConversationDetails = readAndroidRelayConversationDetailsPreference();

  await Promise.all([chatDataService.init(), contactsService.init()]);
  const [chats, contacts, identityPrivateKey] = await Promise.all([
    chatDataService.listChats(),
    contactsService.listContacts(),
    resolveLocalIdentityPrivateKey(watchPlan.ownerPubkey),
  ]);
  const contactsByPubkey = new Map(
    contacts.flatMap((contact) => {
      const pubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
      return pubkey ? [[pubkey, contact] as const] : [];
    })
  );
  const conversations: AndroidNotificationConversation[] = [];
  const recipientKeys: AndroidNotificationRecipientKey[] = [];

  if (identityPrivateKey) {
    recipientKeys.push({
      recipientPubkey: watchPlan.ownerPubkey,
      privateKey: identityPrivateKey,
    });
  }

  const chatPubkeys = new Set<string>();
  for (const chat of chats) {
    const chatPubkey = inputSanitizerService.normalizeHexKey(chat.public_key);
    if (!chatPubkey) {
      continue;
    }
    chatPubkeys.add(chatPubkey);
    const contact = contactsByPubkey.get(chatPubkey);
    const name =
      contact?.given_name?.trim() ||
      contact?.meta.display_name?.trim() ||
      contact?.meta.name?.trim() ||
      contact?.name.trim() ||
      chat.name.trim() ||
      chatPubkey;
    const avatarUrl = readMetaString(chat.meta, 'picture') || contact?.meta.picture?.trim() || '';
    const policyEligible =
      chat.type === 'group' ||
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: chat.meta,
        contact,
      });
    const baseConversation = {
      chatPubkey,
      name,
      avatarUrl,
      avatarText: readMetaString(chat.meta, 'avatar') || buildAvatarText(name),
      policyEligible,
      notificationsEnabled:
        chat.type === 'group'
          ? isConversationNotificationEnabled(chat.meta) &&
            !isContactNotificationSuppressed(contact)
          : isAndroidDirectNotificationConversationEnabled({
              chatMeta: chat.meta,
              contact,
            }),
    };

    if (chat.type !== 'group') {
      conversations.push(baseConversation);
      continue;
    }

    const epochEntry = resolveCurrentGroupChatEpochEntryValue(chat);
    const epochPubkey = inputSanitizerService.normalizeHexKey(epochEntry?.epoch_public_key ?? '');
    if (!epochPubkey) {
      continue;
    }
    conversations.push({
      ...baseConversation,
      recipientPubkey: epochPubkey,
    });
    if (!identityPrivateKey || !epochEntry?.epoch_private_key_encrypted) {
      continue;
    }
    const epochPrivateKey = await decryptGroupEpochPrivateKey({
      encryptedPrivateKey: epochEntry.epoch_private_key_encrypted,
      epochPubkey,
      identityPrivateKey,
      ownerPubkey: watchPlan.ownerPubkey,
    });
    if (epochPrivateKey) {
      recipientKeys.push({ recipientPubkey: epochPubkey, privateKey: epochPrivateKey });
    }
  }

  for (const contact of contacts) {
    const contactPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
    if (!contactPubkey || contact.type === 'group' || chatPubkeys.has(contactPubkey)) {
      continue;
    }
    if (!isAndroidDirectNotificationContactEligible(contact)) {
      continue;
    }
    const name =
      contact.given_name?.trim() ||
      contact.meta.display_name?.trim() ||
      contact.meta.name?.trim() ||
      contact.name.trim() ||
      contactPubkey;
    conversations.push({
      chatPubkey: contactPubkey,
      name,
      avatarUrl: contact.meta.picture?.trim() || '',
      avatarText: buildAvatarText(name),
      policyEligible: true,
      notificationsEnabled: !isContactNotificationSuppressed(contact),
    });
  }

  return {
    ...watchPlan,
    conversations,
    recipientKeys,
    showConversationDetails,
  };
}

function createAndroidNotificationConfigurationSignature(
  configuration: AndroidNotificationConfiguration
): string {
  return JSON.stringify({
    ...configuration,
    conversations: [...configuration.conversations].sort((first, second) =>
      `${first.chatPubkey}:${first.recipientPubkey ?? ''}`.localeCompare(
        `${second.chatPubkey}:${second.recipientPubkey ?? ''}`
      )
    ),
    recipientKeys: [...configuration.recipientKeys].sort((first, second) =>
      first.recipientPubkey.localeCompare(second.recipientPubkey)
    ),
  });
}

async function configureAndroidNotificationListener(input: {
  configuration: AndroidNotificationConfiguration;
  startOnBoot: boolean;
}): Promise<AndroidRelayNotificationState> {
  const state = await AndroidRelayNotifications.configure({
    ...input.configuration,
    startOnBoot: input.startOnBoot,
  });
  lastAppliedConfigurationSignature = state.enabled
    ? createAndroidNotificationConfigurationSignature(input.configuration)
    : null;
  return state;
}

async function performAndroidNotificationRefresh(): Promise<void> {
  const state = await getAndroidRelayNotificationState();
  if (!state.enabled || state.permission !== 'granted') {
    lastAppliedConfigurationSignature = null;
    return;
  }

  try {
    const configuration = await buildAndroidNotificationConfiguration();
    const signature = createAndroidNotificationConfigurationSignature(configuration);
    if (signature === lastAppliedConfigurationSignature) {
      return;
    }
    await configureAndroidNotificationListener({
      configuration,
      startOnBoot: state.startOnBoot,
    });
  } catch (error) {
    if (!(error instanceof AndroidNotificationRelaySelectionError)) {
      throw error;
    }
    await AndroidRelayNotifications.stop();
    lastAppliedConfigurationSignature = null;
    saveAndroidRelayNotificationsPreference(false);
  }
}

function resetRefreshCoordinator(): void {
  if (refreshDebounceTimeoutId !== null) {
    clearTimeout(refreshDebounceTimeoutId);
  }
  refreshDebounceTimeoutId = null;
  refreshCoordinatorPromise = null;
  resolveRefreshCoordinator = null;
  rejectRefreshCoordinator = null;
  isRefreshInProgress = false;
  isRefreshRequested = false;
}

function scheduleAndroidNotificationRefresh(): void {
  if (isRefreshInProgress) {
    return;
  }
  if (refreshDebounceTimeoutId !== null) {
    clearTimeout(refreshDebounceTimeoutId);
  }
  refreshDebounceTimeoutId = setTimeout(() => {
    refreshDebounceTimeoutId = null;
    void runAndroidNotificationRefresh();
  }, ANDROID_NOTIFICATION_REFRESH_DEBOUNCE_MS);
}

async function runAndroidNotificationRefresh(): Promise<void> {
  isRefreshInProgress = true;
  isRefreshRequested = false;
  try {
    await performAndroidNotificationRefresh();
  } catch (error) {
    const reject = rejectRefreshCoordinator;
    resetRefreshCoordinator();
    reject?.(error);
    return;
  }
  isRefreshInProgress = false;

  if (isRefreshRequested) {
    scheduleAndroidNotificationRefresh();
    return;
  }

  const resolve = resolveRefreshCoordinator;
  resetRefreshCoordinator();
  resolve?.();
}

export async function getAndroidRelayNotificationPermission(): Promise<AndroidRelayNotificationPermissionState> {
  if (!isAndroidRelayNotificationSupported()) {
    return 'unsupported';
  }
  const permission = await AndroidRelayNotifications.checkPermissions();
  return normalizePermission(permission.receive);
}

export async function getAndroidRelayNotificationState(): Promise<AndroidRelayNotificationState> {
  if (!isAndroidRelayNotificationSupported()) {
    return {
      enabled: false,
      startOnBoot: readAndroidRelayStartOnBootPreference(),
      showConversationDetails: readAndroidRelayConversationDetailsPreference(),
      permission: 'unsupported',
    };
  }

  const state = await AndroidRelayNotifications.getState();
  const normalizedState = {
    ...state,
    permission: normalizePermission(state.permission),
  };
  saveAndroidRelayNotificationsPreference(normalizedState.enabled);
  saveAndroidRelayStartOnBootPreference(normalizedState.startOnBoot);
  saveAndroidRelayConversationDetailsPreference(normalizedState.showConversationDetails);
  return normalizedState;
}

export async function requestAndroidRelayNotificationsAfterLogin(): Promise<AndroidRelayNotificationPermissionState> {
  if (!isAndroidRelayNotificationSupported()) {
    saveAndroidRelayNotificationsPreference(false);
    return 'unsupported';
  }

  const result = await AndroidRelayNotifications.requestPermissions();
  const permission = normalizePermission(result.receive);
  if (permission !== 'granted') {
    saveAndroidRelayNotificationsPreference(false);
    return permission;
  }

  const state = await configureAndroidNotificationListener({
    configuration: await buildAndroidNotificationConfiguration(),
    startOnBoot: readAndroidRelayStartOnBootPreference(),
  });
  saveAndroidRelayNotificationsPreference(state.enabled);
  saveAndroidRelayStartOnBootPreference(state.startOnBoot);
  return state.enabled ? 'granted' : 'denied';
}

export async function refreshAndroidRelayNotificationListener(): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    return;
  }

  isRefreshRequested = true;
  if (!refreshCoordinatorPromise) {
    refreshCoordinatorPromise = new Promise<void>((resolve, reject) => {
      resolveRefreshCoordinator = resolve;
      rejectRefreshCoordinator = reject;
    });
  }
  scheduleAndroidNotificationRefresh();
  return refreshCoordinatorPromise;
}

export async function setAndroidRelayNotificationStartOnBoot(enabled: boolean): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    return;
  }
  const state = await AndroidRelayNotifications.setStartOnBoot({ enabled });
  saveAndroidRelayStartOnBootPreference(state.startOnBoot);
}

export async function setAndroidRelayNotificationConversationDetails(
  enabled: boolean
): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    saveAndroidRelayConversationDetailsPreference(enabled);
    return;
  }
  const state = await getAndroidRelayNotificationState();
  saveAndroidRelayConversationDetailsPreference(enabled);
  if (!state.enabled || state.permission !== 'granted') {
    return;
  }

  try {
    await configureAndroidNotificationListener({
      configuration: await buildAndroidNotificationConfiguration(),
      startOnBoot: state.startOnBoot,
    });
  } catch (error) {
    saveAndroidRelayConversationDetailsPreference(state.showConversationDetails);
    throw error;
  }
}

export async function clearAndroidRelayNotificationForChat(chatPubkey: string): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    return;
  }
  const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(chatPubkey);
  if (!normalizedChatPubkey) {
    return;
  }
  await AndroidRelayNotifications.clearDeliveredNotifications({
    chatPubkey: normalizedChatPubkey,
  });
}

export async function disableAndroidRelayNotifications(): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    clearAndroidRelayNotificationsPreference();
    return;
  }

  try {
    await AndroidRelayNotifications.stop();
  } finally {
    lastAppliedConfigurationSignature = null;
    decryptedGroupEpochPrivateKeyCache.clear();
    saveAndroidRelayNotificationsPreference(false);
  }
}

async function performAndroidRelayPendingEventDrain(): Promise<void> {
  const nostrStore = useNostrStore();
  const ownerPubkey = inputSanitizerService.normalizeHexKey(
    nostrStore.getLoggedInPublicKeyHex() ?? ''
  );
  if (!ownerPubkey) {
    return;
  }

  for (
    let batchIndex = 0;
    batchIndex < ANDROID_PENDING_EVENT_MAX_BATCHES_PER_DRAIN;
    batchIndex += 1
  ) {
    const response = await AndroidRelayNotifications.getPendingEvents({
      ownerPubkey,
      limit: ANDROID_PENDING_EVENT_BATCH_SIZE,
    });
    const rawEvents = Array.isArray(response.events) ? response.events : [];
    if (rawEvents.length === 0) {
      return;
    }

    const permanentlyInvalidEventIds = new Set<string>();
    const pendingEvents: AndroidRelayPendingEvent[] = [];
    for (const rawEvent of rawEvents) {
      const parsedEvent = parseAndroidRelayPendingEvent(rawEvent);
      if (parsedEvent) {
        pendingEvents.push(parsedEvent);
        continue;
      }

      if (isPlainRecord(rawEvent)) {
        const invalidEventId = inputSanitizerService.normalizeHexKey(String(rawEvent.id ?? ''));
        if (invalidEventId) {
          permanentlyInvalidEventIds.add(invalidEventId);
        }
      }
    }

    const ingestionJobs = pendingEvents.map((pendingEvent) => ({
      pendingEvent,
      result: nostrStore.ingestAndroidRelayNotificationEvent({
        event: pendingEvent.event,
        ownerPubkey,
        relayUrl: pendingEvent.relayUrl,
      }),
    }));

    if (permanentlyInvalidEventIds.size > 0) {
      await AndroidRelayNotifications.acknowledgePendingEvents({
        ownerPubkey,
        eventIds: Array.from(permanentlyInvalidEventIds),
      });
    }

    const ingestionResults = await Promise.all(
      ingestionJobs.map(async ({ pendingEvent, result }) => {
        let shouldAcknowledge = false;
        try {
          shouldAcknowledge = await result;
        } catch (error) {
          console.warn('Failed to ingest an Android relay notification event.', error);
          return false;
        }
        if (!shouldAcknowledge) {
          return false;
        }

        try {
          await AndroidRelayNotifications.acknowledgePendingEvents({
            ownerPubkey,
            eventIds: [pendingEvent.eventId],
          });
          return true;
        } catch (error) {
          console.warn('Failed to acknowledge an Android relay notification event.', error);
          return false;
        }
      })
    );
    const acknowledgedEventCount =
      permanentlyInvalidEventIds.size + ingestionResults.filter(Boolean).length;

    if (acknowledgedEventCount < rawEvents.length) {
      return;
    }
  }
}

async function runAndroidRelayPendingEventDrain(): Promise<void> {
  try {
    do {
      isPendingEventDrainRequested = false;
      await performAndroidRelayPendingEventDrain();
    } while (isPendingEventDrainRequested);
  } finally {
    pendingEventDrainPromise = null;
  }
}

export function ingestPendingAndroidRelayNotificationEvents(): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    return Promise.resolve();
  }

  isPendingEventDrainRequested = true;
  pendingEventDrainPromise ??= runAndroidRelayPendingEventDrain();
  return pendingEventDrainPromise;
}

export const __androidRelayNotificationServiceTestUtils = {
  resetRefreshState(): void {
    resetRefreshCoordinator();
    lastAppliedConfigurationSignature = null;
    decryptedGroupEpochPrivateKeyCache.clear();
    pendingEventDrainPromise = null;
    isPendingEventDrainRequested = false;
  },
};

export function startAndroidRelayNotificationListeners(
  onNotificationAction: (chatPubkey: string | null) => void,
  onPendingEventsAvailable: () => void
): void {
  if (!isAndroidRelayNotificationSupported() || didInstallNotificationListeners) {
    return;
  }

  didInstallNotificationListeners = true;
  void getAndroidRelayNotificationState().catch((error) => {
    console.warn('Failed to synchronize Android notification listener state.', error);
  });

  void AndroidRelayNotifications.addListener('notificationActionPerformed', (event) => {
    onNotificationAction(inputSanitizerService.normalizeHexKey(String(event.chatPubkey ?? '')));
  });
  void AndroidRelayNotifications.addListener('pendingEventsAvailable', () => {
    onPendingEventsAvailable();
  });
}

export async function resolveAndroidRelayNotificationRoute(
  chatPubkey: string | null
): Promise<RouteLocationRaw> {
  const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(chatPubkey ?? '');
  if (!normalizedChatPubkey) {
    return { name: 'chats' };
  }
  return {
    name: 'chats',
    params: {
      pubkey: normalizedChatPubkey,
    },
  };
}
