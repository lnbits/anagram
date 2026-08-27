import { Capacitor, type PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { chatDataService } from 'src/services/chatDataService';
import { FOREGROUND_MESSAGE_ACTIVITY_EVENT } from 'src/services/foregroundMessageActivityService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { useNostrStore } from 'src/stores/nostrStore';
import type { RouteLocationRaw } from 'vue-router';

const ANDROID_RELAY_NOTIFICATIONS_STORAGE_KEY = 'ui-android-relay-notifications';
const ANDROID_RELAY_START_ON_BOOT_STORAGE_KEY = 'ui-android-relay-notifications-start-on-boot';

export type AndroidRelayNotificationPermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'unsupported';

export interface AndroidRelayNotificationState {
  enabled: boolean;
  startOnBoot: boolean;
  permission: AndroidRelayNotificationPermissionState;
}

export interface AndroidNotificationWatchPlan {
  relays: string[];
  recipientPubkeys: string[];
}

interface AndroidRelayNotificationsPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  configure(
    options: AndroidNotificationWatchPlan & {
      startOnBoot: boolean;
    }
  ): Promise<AndroidRelayNotificationState>;
  stop(): Promise<AndroidRelayNotificationState>;
  setStartOnBoot(options: { enabled: boolean }): Promise<AndroidRelayNotificationState>;
  getState(): Promise<AndroidRelayNotificationState>;
  clearDeliveredNotifications(): Promise<void>;
  addListener(
    eventName: 'notificationActionPerformed',
    listener: (event: { recipientPubkey?: string }) => void
  ): Promise<PluginListenerHandle>;
}

const AndroidRelayNotifications = registerPlugin<AndroidRelayNotificationsPlugin>(
  'AndroidRelayNotifications'
);

let didInstallNotificationListeners = false;
let delayedNotificationCountResetTimeoutId: number | null = null;

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizePermission(value: string): AndroidRelayNotificationPermissionState {
  if (value === 'granted' || value === 'denied') {
    return value;
  }
  return 'prompt';
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

function saveAndroidRelayStartOnBootPreference(enabled: boolean): void {
  if (canUseStorage()) {
    window.localStorage.setItem(ANDROID_RELAY_START_ON_BOOT_STORAGE_KEY, enabled ? '1' : '0');
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
    relays: Array.from(relays).sort(),
    recipientPubkeys: Array.from(recipientPubkeys).sort(),
  };
}

async function buildAndroidNotificationWatchPlan(): Promise<AndroidNotificationWatchPlan> {
  const nostrStore = useNostrStore();
  const [relayUrls, watchedPubkeys] = await Promise.all([
    nostrStore.listPrivateMessageReadRelayUrls(),
    nostrStore.listPrivateMessageRecipientPubkeys(),
  ]);

  return createAndroidNotificationWatchPlan({
    ownerPubkey: nostrStore.getLoggedInPublicKeyHex() ?? '',
    relayUrls,
    watchedPubkeys,
  });
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

  const state = await AndroidRelayNotifications.configure({
    ...(await buildAndroidNotificationWatchPlan()),
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

  const state = await getAndroidRelayNotificationState();
  if (!state.enabled || state.permission !== 'granted') {
    return;
  }

  await AndroidRelayNotifications.configure({
    ...(await buildAndroidNotificationWatchPlan()),
    startOnBoot: state.startOnBoot,
  });
}

export async function setAndroidRelayNotificationStartOnBoot(enabled: boolean): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    return;
  }
  const state = await AndroidRelayNotifications.setStartOnBoot({ enabled });
  saveAndroidRelayStartOnBootPreference(state.startOnBoot);
}

export async function resetAndroidRelayNotificationCounts(): Promise<void> {
  if (isAndroidRelayNotificationSupported()) {
    await AndroidRelayNotifications.clearDeliveredNotifications();
  }
}

export function scheduleAndroidRelayNotificationCountReset(): void {
  if (!isAndroidRelayNotificationSupported()) {
    return;
  }

  void resetAndroidRelayNotificationCounts().catch((error) => {
    console.warn('Failed to clear Android message notifications after foreground activity.', error);
  });

  if (typeof window === 'undefined') {
    return;
  }
  if (delayedNotificationCountResetTimeoutId !== null) {
    window.clearTimeout(delayedNotificationCountResetTimeoutId);
  }
  delayedNotificationCountResetTimeoutId = window.setTimeout(() => {
    delayedNotificationCountResetTimeoutId = null;
    void resetAndroidRelayNotificationCounts().catch((error) => {
      console.warn('Failed to clear delayed Android message notifications.', error);
    });
  }, 2500);
}

export async function disableAndroidRelayNotifications(): Promise<void> {
  if (!isAndroidRelayNotificationSupported()) {
    clearAndroidRelayNotificationsPreference();
    return;
  }

  try {
    await AndroidRelayNotifications.stop();
  } finally {
    saveAndroidRelayNotificationsPreference(false);
  }
}

export function startAndroidRelayNotificationListeners(
  onNotificationAction: (recipientPubkey: string | null) => void
): void {
  if (!isAndroidRelayNotificationSupported() || didInstallNotificationListeners) {
    return;
  }

  didInstallNotificationListeners = true;
  void getAndroidRelayNotificationState().catch((error) => {
    console.warn('Failed to synchronize Android notification listener state.', error);
  });
  scheduleAndroidRelayNotificationCountReset();

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      scheduleAndroidRelayNotificationCountReset();
      void getAndroidRelayNotificationState().catch((error) => {
        console.warn('Failed to synchronize Android notification state on app foreground.', error);
      });
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(FOREGROUND_MESSAGE_ACTIVITY_EVENT, () => {
      scheduleAndroidRelayNotificationCountReset();
    });
  }

  void AndroidRelayNotifications.addListener('notificationActionPerformed', (event) => {
    scheduleAndroidRelayNotificationCountReset();
    onNotificationAction(
      inputSanitizerService.normalizeHexKey(String(event.recipientPubkey ?? ''))
    );
  });
}

export async function resolveAndroidRelayNotificationRoute(
  recipientPubkey: string | null
): Promise<RouteLocationRaw> {
  const nostrStore = useNostrStore();
  const loggedInPubkey = nostrStore.getLoggedInPublicKeyHex();
  if (!recipientPubkey || recipientPubkey === loggedInPubkey) {
    return { name: 'chats' };
  }

  await chatDataService.init();
  const chats = await chatDataService.listChats();
  const matchingGroup = chats.find((chat) => {
    if (chat.type !== 'group') {
      return false;
    }

    const currentEpochPubkey =
      typeof chat.meta?.current_epoch_public_key === 'string'
        ? chat.meta.current_epoch_public_key
        : typeof chat.meta?.epoch_public_key === 'string'
          ? chat.meta.epoch_public_key
          : '';
    return inputSanitizerService.normalizeHexKey(currentEpochPubkey) === recipientPubkey;
  });

  if (matchingGroup) {
    return {
      name: 'chats',
      params: {
        pubkey: matchingGroup.public_key,
      },
    };
  }

  return { name: 'chats' };
}
