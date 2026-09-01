import NDK, { NDKPrivateKeySigner, type NDKUser } from '@nostr-dev-kit/ndk';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  CONTACT_CURSOR_VERSION,
  EVENT_FILTER_LOOKBACK_SECONDS,
  EVENT_SINCE_STORAGE_KEY,
  PRIVATE_MESSAGES_BACKFILL_INITIAL_DELAY_MS,
  PRIVATE_MESSAGES_BACKFILL_MAX_AGE_SECONDS,
  PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
  PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY,
  PRIVATE_MESSAGES_BACKFILL_WINDOW_SECONDS,
  PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY,
  PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS,
  PRIVATE_PREFERENCES_STORAGE_KEY,
} from 'src/stores/nostr/constants';
import { hasStorage, isPlainRecord } from 'src/stores/nostr/shared';
import type {
  ContactCursorContent,
  ContactCursorState,
  GroupIdentitySecretContent,
  PrivateMessagesBackfillState,
  PrivatePreferences,
} from 'src/stores/nostr/types';
import { normalizeBlossomServerUrl } from 'src/utils/blossomServer';
import type { Ref } from 'vue';

interface PendingEventSinceState {
  pendingEventSinceUpdate: number;
}

interface StorageSessionRuntimeDeps {
  eventSince: Ref<number>;
  getDefaultEventSince: () => number;
  getLoggedInSignerUser: () => Promise<NDKUser>;
  isRestoringStartupState: Ref<boolean>;
  ndk: NDK;
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
        10
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
      10
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
        String(normalizedCreatedAt)
      );
    }
  }

  function clearStoredPrivateMessagesLastReceivedCreatedAt(): void {
    if (hasStorage()) {
      window.localStorage.removeItem(PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY);
    }
  }

  function normalizePrivateMessagesBackfillState(
    value: unknown
  ): PrivateMessagesBackfillState | null {
    if (!isPlainRecord(value)) {
      return null;
    }

    const pubkey = inputSanitizerService.normalizeHexKey(
      typeof value.pubkey === 'string' ? value.pubkey : ''
    );
    const nextSince = Number(value.nextSince);
    const nextUntil = Number(value.nextUntil);
    const floorSince = Number(value.floorSince);
    const delayMs = Number(value.delayMs);
    const completed = value.completed === true;

    if (
      !pubkey ||
      !Number.isInteger(nextSince) ||
      nextSince < 0 ||
      !Number.isInteger(nextUntil) ||
      nextUntil < 0 ||
      !Number.isInteger(floorSince) ||
      floorSince < 0 ||
      !Number.isFinite(delayMs)
    ) {
      return null;
    }

    return {
      pubkey,
      nextSince: Math.floor(nextSince),
      nextUntil: Math.floor(nextUntil),
      floorSince: Math.floor(floorSince),
      delayMs: Math.min(
        PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
        Math.max(PRIVATE_MESSAGES_BACKFILL_INITIAL_DELAY_MS, Math.floor(delayMs))
      ),
      completed,
    };
  }

  function readPrivateMessagesBackfillState(): PrivateMessagesBackfillState | null {
    if (!hasStorage()) {
      return null;
    }

    const stored = window.localStorage.getItem(PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY)?.trim();
    if (!stored) {
      return null;
    }

    try {
      return normalizePrivateMessagesBackfillState(JSON.parse(stored));
    } catch {
      return null;
    }
  }

  function writePrivateMessagesBackfillState(state: PrivateMessagesBackfillState): void {
    if (!hasStorage()) {
      return;
    }

    window.localStorage.setItem(PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY, JSON.stringify(state));
  }

  function clearPrivateMessagesBackfillState(): void {
    if (hasStorage()) {
      window.localStorage.removeItem(PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY);
    }
  }

  function getPrivateMessagesStartupFloorSince(
    baseUnixTime = Math.floor(Date.now() / 1000)
  ): number {
    return Math.max(0, Math.floor(baseUnixTime) - PRIVATE_MESSAGES_BACKFILL_MAX_AGE_SECONDS);
  }

  function getPrivateMessagesStartupLiveSince(
    baseUnixTime = Math.floor(Date.now() / 1000)
  ): number {
    const normalizedNow = Math.max(0, Math.floor(baseUnixTime));
    const lastReceivedCreatedAt = readStoredPrivateMessagesLastReceivedCreatedAt();
    const anchorCreatedAt = lastReceivedCreatedAt ?? normalizedNow;

    return Math.max(
      getPrivateMessagesStartupFloorSince(normalizedNow),
      anchorCreatedAt - PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS
    );
  }

  function getPrivateMessagesEpochSwitchSince(
    baseUnixTime = Math.floor(Date.now() / 1000)
  ): number {
    return Math.min(getFilterSince(), getPrivateMessagesStartupLiveSince(baseUnixTime));
  }

  function createInitialPrivateMessagesBackfillState(
    pubkeyHex: string,
    liveSince: number,
    floorSince: number
  ): PrivateMessagesBackfillState | null {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    const normalizedLiveSince = Math.max(0, Math.floor(liveSince));
    const normalizedFloorSince = Math.max(0, Math.floor(floorSince));
    if (!normalizedPubkey || normalizedLiveSince <= normalizedFloorSince) {
      return null;
    }

    const nextUntil = normalizedLiveSince;
    const nextSince = Math.max(
      normalizedFloorSince,
      nextUntil - PRIVATE_MESSAGES_BACKFILL_WINDOW_SECONDS
    );
    if (nextSince >= nextUntil) {
      return null;
    }

    return {
      pubkey: normalizedPubkey,
      nextSince,
      nextUntil,
      floorSince: normalizedFloorSince,
      delayMs: PRIVATE_MESSAGES_BACKFILL_INITIAL_DELAY_MS,
      completed: false,
    };
  }

  function getPrivateMessagesBackfillResumeState(
    pubkeyHex: string,
    liveSince: number,
    floorSince: number
  ): PrivateMessagesBackfillState | null {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return null;
    }

    const storedState = readPrivateMessagesBackfillState();
    if (storedState && storedState.pubkey === normalizedPubkey) {
      const normalizedFloorSince = Math.max(floorSince, storedState.floorSince);
      if (storedState.completed && storedState.floorSince <= normalizedFloorSince) {
        return null;
      }

      const nextSince = Math.max(normalizedFloorSince, storedState.nextSince);
      const nextUntil = Math.max(nextSince, storedState.nextUntil);
      if (nextSince < nextUntil) {
        return {
          ...storedState,
          nextSince,
          nextUntil,
          floorSince: normalizedFloorSince,
          completed: false,
        };
      }
    }

    return createInitialPrivateMessagesBackfillState(normalizedPubkey, liveSince, floorSince);
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
        createdAt
      );
      return;
    }

    setStoredEventSince(createdAt);
  }

  function flushPendingEventSinceUpdate(): void {
    const nextSince = Math.max(
      ensureStoredEventSince(),
      pendingEventSinceState.pendingEventSinceUpdate
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
      typeof value.contactSecret === 'string' ? value.contactSecret : ''
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
      new TextEncoder().encode(value)
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function buildFreshPrivatePreferences(
    existing: Record<string, unknown> = {}
  ): PrivatePreferences {
    return {
      ...existing,
      contactSecret: NDKPrivateKeySigner.generate().privateKey,
    };
  }

  function normalizeContactCursorContent(value: unknown): ContactCursorContent | null {
    if (!isPlainRecord(value)) {
      return null;
    }

    const version = typeof value.version === 'string' ? value.version.trim() : '';
    const lastSeenIncomingActivityAt = normalizeTimestamp(value.last_seen_incoming_activity_at);
    const lastSeenIncomingActivityEventId = normalizeEventId(
      value.last_seen_incoming_activity_event_id
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
    preferences: PrivatePreferences
  ): Promise<string> {
    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    return ndk.signer.encrypt(user, JSON.stringify(preferences), 'nip44');
  }

  async function decryptPrivatePreferencesContent(
    content: string
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
      'nip44'
    );
  }

  async function decryptContactCursorContent(
    content: string
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
      typeof value.group_pubkey === 'string' ? value.group_pubkey : ''
    );
    const groupPrivkey = inputSanitizerService.normalizeHexKey(
      typeof value.group_privkey === 'string' ? value.group_privkey : ''
    );
    const epochNumber = Number(value.epoch_number);
    const epochPrivkey = inputSanitizerService.normalizeHexKey(
      typeof value.epoch_privkey === 'string' ? value.epoch_privkey : ''
    );
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const about = typeof value.about === 'string' ? value.about.trim() : '';

    if (!Number.isInteger(version) || version < 1 || !groupPubkey || !groupPrivkey) {
      return null;
    }

    try {
      const signer = new NDKPrivateKeySigner(groupPrivkey);
      if (inputSanitizerService.normalizeHexKey(signer.pubkey) !== groupPubkey) {
        return null;
      }
    } catch {
      return null;
    }

    return {
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
    content: GroupIdentitySecretContent
  ): Promise<string> {
    const user = await getLoggedInSignerUser();
    ndk.assertSigner();
    return ndk.signer.encrypt(user, JSON.stringify(content), 'nip44');
  }

  async function decryptGroupIdentitySecretContent(
    content: string
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
    getPrivateMessagesBackfillResumeState,
    getPrivateMessagesEpochSwitchSince,
    getPrivateMessagesStartupFloorSince,
    getPrivateMessagesStartupLiveSince,
    normalizeGroupIdentitySecretContent,
    normalizeTimestamp,
    readPrivateMessagesBackfillState,
    readPrivatePreferencesFromStorage,
    readStoredPrivateMessagesLastReceivedCreatedAt,
    resetEventSinceForFreshLogin,
    setStoredEventSince,
    sha256Hex,
    toComparableTimestamp,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
    writePrivateMessagesBackfillState,
    writePrivatePreferencesToStorage,
  };
}
