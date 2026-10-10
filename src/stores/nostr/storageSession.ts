import { deriveGroupIdentityKey, deriveGroupEpochKey, normalizeRecoveryState } from './groupRecovery.ts';
import NostrClient, { NostrPrivateKeySigner, type NostrUser } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  CONTACT_CURSOR_VERSION,
  EVENT_FILTER_LOOKBACK_SECONDS,
  EVENT_SINCE_STORAGE_KEY,
  PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY,
  PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY,
  PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS,
  PRIVATE_PREFERENCES_STORAGE_KEY,
} from '#src/stores/nostr/constants.ts';
import { hasStorage, isPlainRecord } from '#src/stores/nostr/shared.ts';
import type {
  ContactCursorContent,
  ContactCursorState,
  GroupIdentitySecretContent,
  PrivatePreferences,
} from '#src/stores/nostr/types.ts';
import { normalizeBlossomServerUrl } from '#src/utils/blossomServer.ts';
import { normalizeIrohRelaySettings } from '#src/utils/irohRelays.ts';
import type { Ref } from '#src/lib/state/reactivity.ts';

interface PendingEventSinceState {
  pendingEventSinceUpdate: number;
}

interface StorageSessionRuntimeDeps {
  eventSince: Ref<number>;
  getDefaultEventSince: () => number;
  getLoggedInSignerUser: () => Promise<NostrUser>;
  isRestoringStartupState: Ref<boolean>;
  ndk: NostrClient;
  normalizeEventId: (value: unknown) => string | null;
  pendingEventSinceState: PendingEventSinceState;
}

export function createStorageSessionRuntime({
  eventSince,
  getDefaultEventSince,
  getLoggedInSignerUser,
  isRestoringStartupState,
  ndk,
  normalizeEventId,
  pendingEventSinceState,
}: StorageSessionRuntimeDeps) {
  function setStoredEventSince(value: number): number {
    const normalizedValue =
      Number.isInteger(value) && Number(value) > 0
        ? Math.floor(Number(value))
        : getDefaultEventSince();
    eventSince.value = normalizedValue;

    if (hasStorage()) {
      window.localStorage.setItem(EVENT_SINCE_STORAGE_KEY, String(normalizedValue));
    }

    return normalizedValue;
  }

  function ensureStoredEventSince(): number {
    if (eventSince.value > 0) {
      return eventSince.value;
    }

    if (hasStorage()) {
      const storedValue = Number.parseInt(
        window.localStorage.getItem(EVENT_SINCE_STORAGE_KEY) ?? '',
        10,
      );
      if (Number.isInteger(storedValue) && storedValue > 0) {
        eventSince.value = storedValue;
        return storedValue;
      }
    }

    const defaultSince = getDefaultEventSince();
    eventSince.value = defaultSince;
    return defaultSince;
  }

  function getFilterSince(): number {
    return Math.max(0, ensureStoredEventSince() - EVENT_FILTER_LOOKBACK_SECONDS);
  }

  function readStoredPrivateMessagesLastReceivedCreatedAt(): number | null {
    if (!hasStorage()) {
      return null;
    }

    const storedValue = Number.parseInt(
      window.localStorage.getItem(PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY) ?? '',
      10,
    );
    return Number.isInteger(storedValue) && storedValue > 0 ? storedValue : null;
  }

  function updateStoredPrivateMessagesLastReceivedFromCreatedAt(value: unknown): void {
    const createdAt = Number(value);
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      return;
    }

    const normalizedCreatedAt = Math.floor(createdAt);
    const existingCreatedAt = readStoredPrivateMessagesLastReceivedCreatedAt();
    if (existingCreatedAt !== null && normalizedCreatedAt <= existingCreatedAt) {
      return;
    }

    if (hasStorage()) {
      window.localStorage.setItem(
        PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY,
        String(normalizedCreatedAt),
      );
    }
  }

  function clearStoredPrivateMessagesLastReceivedCreatedAt(): void {
    if (hasStorage()) {
      window.localStorage.removeItem(PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY);
    }
  }

  // Remove legacy duration checkpoints; history now uses per-relay coverage only.
  function clearPrivateMessagesBackfillState(): void {
    if (hasStorage()) window.localStorage.removeItem(PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY);
  }
  clearPrivateMessagesBackfillState();

  function getPrivateMessagesStartupLiveSince(
    baseUnixTime = Math.floor(Date.now() / 1000),
  ): number {
    const normalizedNow = Math.max(0, Math.floor(baseUnixTime));
    const lastReceivedCreatedAt = readStoredPrivateMessagesLastReceivedCreatedAt();
    const anchorCreatedAt = lastReceivedCreatedAt ?? normalizedNow;

    return Math.max(0, anchorCreatedAt - PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS);
  }

  function getPrivateMessagesEpochSwitchSince(
    baseUnixTime = Math.floor(Date.now() / 1000),
  ): number {
    return Math.max(
      0,
      Math.min(getFilterSince(), getPrivateMessagesStartupLiveSince(baseUnixTime)),
    );
  }

  function updateStoredEventSinceFromCreatedAt(value: unknown): void {
    const createdAt = Number(value);
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      return;
    }

    if (createdAt <= ensureStoredEventSince()) {
      return;
    }

    if (isRestoringStartupState.value) {
      pendingEventSinceState.pendingEventSinceUpdate = Math.max(
        pendingEventSinceState.pendingEventSinceUpdate,
        createdAt,
      );
      return;
    }

    setStoredEventSince(createdAt);
  }

  function flushPendingEventSinceUpdate(): void {
    const nextSince = Math.max(
      ensureStoredEventSince(),
      pendingEventSinceState.pendingEventSinceUpdate,
    );
    pendingEventSinceState.pendingEventSinceUpdate = 0;
    setStoredEventSince(nextSince);
  }

  function resetEventSinceForFreshLogin(): void {
    eventSince.value = getDefaultEventSince();
    pendingEventSinceState.pendingEventSinceUpdate = 0;

    if (hasStorage()) {
      window.localStorage.removeItem(EVENT_SINCE_STORAGE_KEY);
    }

    clearStoredPrivateMessagesLastReceivedCreatedAt();
    clearPrivateMessagesBackfillState();
  }

  function toComparableTimestamp(value: string | null | undefined): number {
    if (typeof value !== 'string' || !value.trim()) {
      return 0;
    }

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function normalizeTimestamp(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized || null;
  }

  function normalizePrivatePreferences(value: unknown): PrivatePreferences | null {
    if (!isPlainRecord(value)) {
      return null;
    }

    const normalizedContactSecret = inputSanitizerService.normalizeHexKey(
      typeof value.contactSecret === 'string' ? value.contactSecret : '',
    );
    if (!normalizedContactSecret) {
      return null;
    }

    const normalizedBlossomServerUrl = normalizeBlossomServerUrl(value.blossomServerUrl);
    const preferences: PrivatePreferences = {
      ...value,
      contactSecret: normalizedContactSecret,
    };
    if (normalizedBlossomServerUrl) {
      preferences.blossomServerUrl = normalizedBlossomServerUrl;
    } else {
      delete preferences.blossomServerUrl;
    }

    const irohSettings = normalizeIrohRelaySettings(value.irohRelaySettings);
    if (irohSettings) preferences.irohRelaySettings = irohSettings;
    else delete preferences.irohRelaySettings;
    return preferences;
  }

  function readPrivatePreferencesFromStorage(): PrivatePreferences | null {
    if (!hasStorage()) {
      return null;
    }

    const stored = window.localStorage.getItem(PRIVATE_PREFERENCES_STORAGE_KEY)?.trim();
    if (!stored) {
      return null;
    }

    try {
      return normalizePrivatePreferences(JSON.parse(stored));
    } catch {
      return null;
    }
  }

  function writePrivatePreferencesToStorage(preferences: PrivatePreferences): void {
    if (!hasStorage()) {
      return;
    }

    window.localStorage.setItem(PRIVATE_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }

  function clearPrivatePreferencesStorage(): void {
    if (!hasStorage()) {
      return;
    }

    window.localStorage.removeItem(PRIVATE_PREFERENCES_STORAGE_KEY);
  }

  async function sha256Hex(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function buildFreshPrivatePreferences(
    existing: Record<string, unknown> = {},
  ): PrivatePreferences {
    return {
      ...existing,
      contactSecret: NostrPrivateKeySigner.generate().privateKey,
    };
  }

  function normalizeContactCursorContent(value: unknown): ContactCursorContent | null {
    if (!isPlainRecord(value)) {
      return null;
    }

    const version = typeof value.version === 'string' ? value.version.trim() : '';
    const lastSeenIncomingActivityAt = normalizeTimestamp(value.last_seen_incoming_activity_at);
    const lastSeenIncomingActivityEventId = normalizeEventId(
      value.last_seen_incoming_activity_event_id,
    );

    if (!version || !lastSeenIncomingActivityAt) {
      return null;
    }

    return {
      version,
      last_seen_incoming_activity_at: lastSeenIncomingActivityAt,
      last_seen_incoming_activity_event_id: lastSeenIncomingActivityEventId,
    };
  }

  async function encryptPrivatePreferencesContent(
    preferences: PrivatePreferences,
  ): Promise<string> {
    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    return ndk.signer.encrypt(user, JSON.stringify(preferences), 'nip44');
  }

  async function decryptPrivatePreferencesContent(
    content: string,
  ): Promise<PrivatePreferences | null> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    const decryptedContent = await ndk.signer.decrypt(user, normalizedContent, 'nip44');

    try {
      return normalizePrivatePreferences(JSON.parse(decryptedContent));
    } catch {
      return null;
    }
  }

  async function encryptContactCursorContent(cursor: ContactCursorState): Promise<string> {
    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    return ndk.signer.encrypt(
      user,
      JSON.stringify({
        version: CONTACT_CURSOR_VERSION,
        last_seen_incoming_activity_at: cursor.at,
        last_seen_incoming_activity_event_id: cursor.eventId,
      }),
      'nip44',
    );
  }

  async function decryptContactCursorContent(
    content: string,
  ): Promise<ContactCursorContent | null> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    const decryptedContent = await ndk.signer.decrypt(user, normalizedContent, 'nip44');

    try {
      return normalizeContactCursorContent(JSON.parse(decryptedContent));
    } catch {
      return null;
    }
  }

  function normalizeGroupIdentitySecretContent(value: unknown): GroupIdentitySecretContent | null {
    if (!isPlainRecord(value)) {
      return null;
    }

    const version = Number(value.version);
    const groupPubkey = inputSanitizerService.normalizeHexKey(
      typeof value.group_pubkey === 'string' ? value.group_pubkey : '',
    );
    const groupPrivkey = inputSanitizerService.normalizeHexKey(
      typeof value.group_privkey === 'string' ? value.group_privkey : '',
    );
    const epochNumber = Number(value.epoch_number);
    const epochPrivkey = inputSanitizerService.normalizeHexKey(
      typeof value.epoch_privkey === 'string' ? value.epoch_privkey : '',
    );
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const about = typeof value.about === 'string' ? value.about.trim() : '';

    if (!Number.isInteger(version) || version < 1 || !groupPubkey || !groupPrivkey) {
      return null;
    }

    try {
      const signer = new NostrPrivateKeySigner(groupPrivkey);
      if (inputSanitizerService.normalizeHexKey(signer.pubkey) !== groupPubkey) {
        return null;
      }
    } catch {
      return null;
    }

    let recovery: Partial<GroupIdentitySecretContent> = {};
    if (version === 2) {
      try {
        if (typeof value.recovery_entropy !== 'string' || typeof value.recovery_state_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(value.recovery_state_id)) return null;
        const state = normalizeRecoveryState(value.recovery_state);
        if (deriveGroupIdentityKey(value.recovery_entropy) !== groupPrivkey ||
            state.epoch !== epochNumber || deriveGroupEpochKey(value.recovery_entropy, state.epoch, state.epoch_revision) !== epochPrivkey) return null;
        recovery = { recovery_entropy: value.recovery_entropy, recovery_state_id: value.recovery_state_id, recovery_state: state };
      } catch { return null; }
    }
    return {
      ...recovery,
      version,
      group_pubkey: groupPubkey,
      group_privkey: groupPrivkey,
      ...(Number.isInteger(epochNumber) && epochNumber >= 0 && epochPrivkey
        ? {
            epoch_number: Math.floor(epochNumber),
            epoch_privkey: epochPrivkey,
          }
        : {}),
      ...(name ? { name } : {}),
      ...(about ? { about } : {}),
    };
  }

  async function encryptGroupIdentitySecretContent(
    content: GroupIdentitySecretContent,
  ): Promise<string> {
    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    return ndk.signer.encrypt(user, JSON.stringify(content), 'nip44');
  }

  async function decryptGroupIdentitySecretContent(
    content: string,
  ): Promise<GroupIdentitySecretContent | null> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    const decryptedContent = await ndk.signer.decrypt(user, normalizedContent, 'nip44');

    try {
      return normalizeGroupIdentitySecretContent(JSON.parse(decryptedContent));
    } catch {
      return null;
    }
  }

  async function encryptPrivateStringContent(content: string): Promise<string> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new Error('Private content is required.');
    }

    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    return ndk.signer.encrypt(user, normalizedContent, 'nip44');
  }

  async function decryptPrivateStringContent(content: string): Promise<string | null> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    const decryptedContent = await ndk.signer.decrypt(user, normalizedContent, 'nip44');
    const normalizedPrivateKey = inputSanitizerService.normalizeHexKey(decryptedContent);
    return normalizedPrivateKey ?? null;
  }

  return {
    buildFreshPrivatePreferences,
    clearPrivateMessagesBackfillState,
    clearPrivatePreferencesStorage,
    clearStoredPrivateMessagesLastReceivedCreatedAt,
    decryptContactCursorContent,
    decryptGroupIdentitySecretContent,
    decryptPrivatePreferencesContent,
    decryptPrivateStringContent,
    encryptContactCursorContent,
    encryptGroupIdentitySecretContent,
    encryptPrivatePreferencesContent,
    encryptPrivateStringContent,
    ensureStoredEventSince,
    flushPendingEventSinceUpdate,
    getFilterSince,
    getPrivateMessagesEpochSwitchSince,
    getPrivateMessagesStartupLiveSince,
    normalizeGroupIdentitySecretContent,
    normalizeTimestamp,
    readPrivatePreferencesFromStorage,
    readStoredPrivateMessagesLastReceivedCreatedAt,
    resetEventSinceForFreshLogin,
    setStoredEventSince,
    sha256Hex,
    toComparableTimestamp,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
    writePrivatePreferencesToStorage,
  };
}
