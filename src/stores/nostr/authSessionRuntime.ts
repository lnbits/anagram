import NDK, { NDKNip07Signer, NDKPrivateKeySigner, type NDKSigner } from '@nostr-dev-kit/ndk';
import {
  clearAndroidPrivateKeyMemoryOnlySession,
  isAndroidSecurePrivateKeyStorageAvailable,
  markAndroidPrivateKeyMemoryOnlySession,
  readAndroidSecurePrivateKeyHex,
  removeAndroidSecurePrivateKeyHex,
  writeAndroidSecurePrivateKeyHex,
} from 'src/services/androidSecurePrivateKeyStorage';
import {
  clearElectronPrivateKeyMemoryOnlySession,
  isElectronSecurePrivateKeyStorageAvailable,
  markElectronPrivateKeyMemoryOnlySession,
  readElectronSecurePrivateKeyHex,
  removeElectronSecurePrivateKeyHex,
  writeElectronSecurePrivateKeyHex,
} from 'src/services/electronSecurePrivateKeyStorage';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  AUTH_METHOD_STORAGE_KEY,
  NIP46_SIGNER_PAYLOAD_STORAGE_KEY,
  PRIVATE_KEY_STORAGE_KEY,
  PUBLIC_KEY_STORAGE_KEY,
} from 'src/stores/nostr/constants';
import {
  createNip46AuthRuntime,
  getNip46SessionSnapshotFromPayload,
} from 'src/stores/nostr/nip46AuthRuntime';
import { hasStorage } from 'src/stores/nostr/shared';
import type {
  AuthMethod,
  Nip46LoginResult,
  Nip46NostrConnectLogin,
  Nip46SessionSnapshot,
  SubscribePrivateMessagesOptions,
} from 'src/stores/nostr/types';
import { clearPersistedAppState } from 'src/utils/logoutCleanup';
import type { Ref } from 'vue';

interface RestoreRuntimeState {
  restoreContactCursorStatePromise: Promise<void> | null;
  restoreGroupIdentitySecretsPromise: Promise<void> | null;
  restorePrivatePreferencesPromise: Promise<void> | null;
}

interface AuthSessionRuntimeDeps {
  authenticatedRelayUrls: { clear: () => void };
  backgroundGroupContactRefreshStartedAt: { clear: () => void };
  bumpDeveloperDiagnosticsVersion: () => void;
  chatStoreClearAllComposerDrafts: () => void;
  clearDeveloperTraceEntries: () => Promise<void>;
  clearNip65RelayStoreState: () => void;
  clearPrivateMessagesBackfillState: () => void;
  clearPrivatePreferencesStorage: () => void;
  clearRelayStoreState: () => void;
  clearStoredPrivateMessagesLastReceivedCreatedAt: () => void;
  configuredRelayUrls: { clear: () => void };
  contactListVersion: Ref<number>;
  eventSince: Ref<number>;
  getPrivateMessagesEpochSubscriptionRefreshTimerId: () => ReturnType<
    typeof globalThis.setTimeout
  > | null;
  groupContactRefreshPromises: { clear: () => void };
  hasNip07Extension: () => boolean;
  isRestoringStartupState: Ref<boolean>;
  loggedInvalidGroupEpochConflictKeys: { clear: () => void };
  ndk: NDK;
  pendingContactCursorPublishStates: { clear: () => void };
  pendingContactCursorPublishTimers: Map<string, ReturnType<typeof globalThis.setTimeout>>;
  pendingEventSinceState: {
    pendingEventSinceUpdate: number;
  };
  pendingIncomingDeletions: { clear: () => void };
  pendingIncomingReactions: { clear: () => void };
  relayConnectFailureCooldownUntilByUrl: { clear: () => void };
  relayConnectPromises: { clear: () => void };
  relayStatusVersion: Ref<number>;
  resetContactSubscriptionsRuntimeState: (reason?: string) => void;
  resetEventSinceForFreshLogin: () => void;
  resetGroupRosterSubscriptionRuntimeState: (reason?: string) => void;
  resetMyRelayListRuntimeState: (reason?: string) => void;
  resetMuteListRuntimeState: () => void;
  resetPrivateContactListRuntimeState: (reason?: string) => void;
  resetPrivateMessagesBackfillRuntimeState: () => void;
  resetReconnectHealingRuntimeState: () => void;
  resetPrivateMessagesIngestRuntimeState: () => void;
  resetOutboundMessageReplayRuntimeState: () => void;
  resetPrivateMessagesSubscriptionRuntimeState: (options?: {
    clearLastEventState?: boolean;
  }) => void;
  resetPrivateMessagesUiRuntimeState: (options?: { includeRefreshQueue?: boolean }) => void;
  resetStartupSessionInitialization: () => void;
  resetStartupStepTracking: () => void;
  resetTrackedContactEventState: () => void;
  restoreRuntimeState: RestoreRuntimeState;
  setCachedSigner: (signer: NDKSigner | null) => void;
  setCachedSignerSessionKey: (sessionKey: string | null) => void;
  setPendingPrivateMessagesEpochSubscriptionRefreshOptions: (
    options: SubscribePrivateMessagesOptions | null
  ) => void;
  setPrivateMessagesEpochSubscriptionRefreshQueue: (queue: Promise<void>) => void;
  setPrivateMessagesEpochSubscriptionRefreshTimerId: (
    timerId: ReturnType<typeof globalThis.setTimeout> | null
  ) => void;
  setRestoreStartupStatePromise: (promise: Promise<void> | null) => void;
  setSyncLoggedInContactProfilePromise: (promise: Promise<void> | null) => void;
  setSyncRecentChatContactsPromise: (promise: Promise<void> | null) => void;
  stopPrivateMessagesSubscription: (reason?: string) => void;
}

export function createAuthSessionRuntime({
  authenticatedRelayUrls,
  backgroundGroupContactRefreshStartedAt,
  bumpDeveloperDiagnosticsVersion,
  chatStoreClearAllComposerDrafts,
  clearDeveloperTraceEntries,
  clearNip65RelayStoreState,
  clearPrivateMessagesBackfillState,
  clearPrivatePreferencesStorage,
  clearRelayStoreState,
  clearStoredPrivateMessagesLastReceivedCreatedAt,
  configuredRelayUrls,
  contactListVersion,
  eventSince,
  getPrivateMessagesEpochSubscriptionRefreshTimerId,
  groupContactRefreshPromises,
  hasNip07Extension,
  isRestoringStartupState,
  loggedInvalidGroupEpochConflictKeys,
  ndk,
  pendingContactCursorPublishStates,
  pendingContactCursorPublishTimers,
  pendingEventSinceState,
  pendingIncomingDeletions,
  pendingIncomingReactions,
  relayConnectFailureCooldownUntilByUrl,
  relayConnectPromises,
  relayStatusVersion,
  resetContactSubscriptionsRuntimeState,
  resetEventSinceForFreshLogin,
  resetGroupRosterSubscriptionRuntimeState,
  resetMyRelayListRuntimeState,
  resetMuteListRuntimeState,
  resetOutboundMessageReplayRuntimeState,
  resetPrivateContactListRuntimeState,
  resetPrivateMessagesBackfillRuntimeState,
  resetReconnectHealingRuntimeState,
  resetPrivateMessagesIngestRuntimeState,
  resetPrivateMessagesSubscriptionRuntimeState,
  resetPrivateMessagesUiRuntimeState,
  resetStartupSessionInitialization,
  resetStartupStepTracking,
  resetTrackedContactEventState,
  restoreRuntimeState,
  setCachedSigner,
  setCachedSignerSessionKey,
  setPendingPrivateMessagesEpochSubscriptionRefreshOptions,
  setPrivateMessagesEpochSubscriptionRefreshQueue,
  setPrivateMessagesEpochSubscriptionRefreshTimerId,
  setRestoreStartupStatePromise,
  setSyncLoggedInContactProfilePromise,
  setSyncRecentChatContactsPromise,
  stopPrivateMessagesSubscription,
}: AuthSessionRuntimeDeps) {
  let cachedPrivateKeyHex: string | null = null;
  let loadPrivateKeyHexPromise: Promise<string | null> | null = null;

  function readLegacyPrivateKeyHex(): string | null {
    if (!hasStorage()) {
      return null;
    }

    const stored = window.localStorage.getItem(PRIVATE_KEY_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    return inputSanitizerService.normalizeHexKey(stored);
  }

  function getStoredPublicKeyHex(): string | null {
    if (!hasStorage()) {
      return null;
    }

    const stored = window.localStorage.getItem(PUBLIC_KEY_STORAGE_KEY)?.trim() ?? '';
    return (
      inputSanitizerService.normalizeHexKey(stored) ??
      inputSanitizerService.validateNpub(stored).normalizedPubkey
    );
  }

  function getPrivateKeyHex(): string | null {
    return cachedPrivateKeyHex ?? readLegacyPrivateKeyHex();
  }

  function derivePublicKeyFromPrivateKeyHex(privateKeyHex: string): string | null {
    try {
      return inputSanitizerService.normalizeHexKey(
        new NDKPrivateKeySigner(privateKeyHex, ndk).pubkey
      );
    } catch {
      return null;
    }
  }

  function setStoredNsecSessionMetadata(pubkeyHex: string): void {
    if (!hasStorage()) {
      return;
    }

    window.localStorage.setItem(AUTH_METHOD_STORAGE_KEY, 'nsec');
    window.localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, pubkeyHex);
  }

  function isSecurePrivateKeyStorageAvailable(): boolean {
    return (
      isAndroidSecurePrivateKeyStorageAvailable() || isElectronSecurePrivateKeyStorageAvailable()
    );
  }

  function clearSecurePrivateKeyMemoryOnlySession(): void {
    clearAndroidPrivateKeyMemoryOnlySession();
    clearElectronPrivateKeyMemoryOnlySession();
  }

  function markSecurePrivateKeyMemoryOnlySession(pubkeyHex: string): void {
    if (isAndroidSecurePrivateKeyStorageAvailable()) {
      markAndroidPrivateKeyMemoryOnlySession(pubkeyHex);
      return;
    }

    if (isElectronSecurePrivateKeyStorageAvailable()) {
      markElectronPrivateKeyMemoryOnlySession(pubkeyHex);
    }
  }

  async function readSecurePrivateKeyHex(): Promise<string | null> {
    if (isAndroidSecurePrivateKeyStorageAvailable()) {
      return readAndroidSecurePrivateKeyHex();
    }

    if (isElectronSecurePrivateKeyStorageAvailable()) {
      return readElectronSecurePrivateKeyHex();
    }

    return null;
  }

  async function writeSecurePrivateKeyHex(privateKeyHex: string): Promise<void> {
    if (isAndroidSecurePrivateKeyStorageAvailable()) {
      await writeAndroidSecurePrivateKeyHex(privateKeyHex);
      return;
    }

    if (isElectronSecurePrivateKeyStorageAvailable()) {
      await writeElectronSecurePrivateKeyHex(privateKeyHex);
    }
  }

  async function removeSecurePrivateKeyHex(): Promise<void> {
    await removeAndroidSecurePrivateKeyHex();
    await removeElectronSecurePrivateKeyHex();
  }

  async function persistSecurePrivateKeyHex(
    privateKeyHex: string,
    pubkeyHex: string
  ): Promise<boolean> {
    try {
      await writeSecurePrivateKeyHex(privateKeyHex);
      clearSecurePrivateKeyMemoryOnlySession();
      return true;
    } catch (error) {
      console.warn('Failed to persist private key in secure storage.', error);
      markSecurePrivateKeyMemoryOnlySession(pubkeyHex);
      return false;
    }
  }

  async function loadSecurePrivateKeyHex(): Promise<string | null> {
    if (cachedPrivateKeyHex) {
      return cachedPrivateKeyHex;
    }

    const legacyPrivateKeyHex = readLegacyPrivateKeyHex();
    let securePrivateKeyHex: string | null = null;

    try {
      securePrivateKeyHex = await readSecurePrivateKeyHex();
    } catch (error) {
      console.warn('Failed to read private key from secure storage.', error);
    }

    const storedPubkeyHex = getStoredPublicKeyHex();
    const securePrivateKeyPubkeyHex = securePrivateKeyHex
      ? derivePublicKeyFromPrivateKeyHex(securePrivateKeyHex)
      : null;

    if (
      securePrivateKeyHex &&
      (!storedPubkeyHex || securePrivateKeyPubkeyHex === storedPubkeyHex)
    ) {
      cachedPrivateKeyHex = securePrivateKeyHex;
      if (hasStorage()) {
        window.localStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
      }
      clearSecurePrivateKeyMemoryOnlySession();
      return securePrivateKeyHex;
    }

    if (securePrivateKeyHex) {
      console.warn('Ignoring secure private key that does not match the stored public key.');
    }

    if (!legacyPrivateKeyHex) {
      return null;
    }

    const legacyPrivateKeyPubkeyHex = derivePublicKeyFromPrivateKeyHex(legacyPrivateKeyHex);
    if (
      !legacyPrivateKeyPubkeyHex ||
      (storedPubkeyHex && legacyPrivateKeyPubkeyHex !== storedPubkeyHex)
    ) {
      console.warn('Ignoring legacy private key that does not match the stored public key.');
      if (hasStorage()) {
        window.localStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
      }
      return null;
    }

    cachedPrivateKeyHex = legacyPrivateKeyHex;
    const pubkeyHex = storedPubkeyHex ?? legacyPrivateKeyPubkeyHex;
    setStoredNsecSessionMetadata(pubkeyHex);

    await persistSecurePrivateKeyHex(legacyPrivateKeyHex, pubkeyHex);

    if (hasStorage()) {
      window.localStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
    }

    return legacyPrivateKeyHex;
  }

  async function loadPrivateKeyHex(): Promise<string | null> {
    if (!isSecurePrivateKeyStorageAvailable()) {
      cachedPrivateKeyHex = readLegacyPrivateKeyHex();
      return cachedPrivateKeyHex;
    }

    loadPrivateKeyHexPromise ??= loadSecurePrivateKeyHex().finally(() => {
      loadPrivateKeyHexPromise = null;
    });

    return loadPrivateKeyHexPromise;
  }

  function getNip46SignerPayload(): string | null {
    if (!hasStorage()) {
      return null;
    }

    return window.localStorage.getItem(NIP46_SIGNER_PAYLOAD_STORAGE_KEY)?.trim() || null;
  }

  function setStoredNip46SignerPayload(payload: string): void {
    if (!hasStorage()) {
      return;
    }

    window.localStorage.setItem(NIP46_SIGNER_PAYLOAD_STORAGE_KEY, payload);
  }

  function getNip46SignerSessionSnapshot(): Nip46SessionSnapshot {
    return getNip46SessionSnapshotFromPayload(getNip46SignerPayload());
  }

  function setStoredAuthSession(
    authMethod: AuthMethod,
    pubkeyHex: string,
    privateKeyHex?: string
  ): void {
    if (!hasStorage()) {
      return;
    }

    window.localStorage.setItem(AUTH_METHOD_STORAGE_KEY, authMethod);
    window.localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, pubkeyHex);

    if (authMethod === 'nsec' && privateKeyHex) {
      window.localStorage.setItem(PRIVATE_KEY_STORAGE_KEY, privateKeyHex);
      return;
    }

    window.localStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
  }

  function resetPendingContactCursorTimers(): void {
    pendingContactCursorPublishTimers.forEach((timerId) => {
      globalThis.clearTimeout(timerId);
    });
    pendingContactCursorPublishTimers.clear();
    pendingContactCursorPublishStates.clear();
  }

  function resetPrivateMessagesEpochRefreshState(): void {
    const timerId = getPrivateMessagesEpochSubscriptionRefreshTimerId();
    if (timerId !== null) {
      globalThis.clearTimeout(timerId);
      setPrivateMessagesEpochSubscriptionRefreshTimerId(null);
    }

    setPendingPrivateMessagesEpochSubscriptionRefreshOptions(null);
    setPrivateMessagesEpochSubscriptionRefreshQueue(Promise.resolve());
  }

  async function removePersistedSecurePrivateKey(): Promise<void> {
    clearSecurePrivateKeyMemoryOnlySession();
    try {
      await removeSecurePrivateKeyHex();
    } catch (error) {
      console.warn('Failed to remove private key from secure storage.', error);
    }
  }

  function clearPrivateKey(options: { clearSecureStorage?: boolean } = {}): void {
    const activeSigner = ndk.signer as (NDKSigner & { stop?: () => void }) | undefined;
    activeSigner?.stop?.();
    cachedPrivateKeyHex = null;
    loadPrivateKeyHexPromise = null;
    setCachedSigner(null);
    setCachedSignerSessionKey(null);
    ndk.signer = undefined;
    resetPrivateMessagesSubscriptionRuntimeState({ clearLastEventState: true });
    resetStartupSessionInitialization();
    resetStartupStepTracking();
    pendingIncomingReactions.clear();
    pendingIncomingDeletions.clear();
    resetPendingContactCursorTimers();
    resetTrackedContactEventState();
    void clearDeveloperTraceEntries().catch((error) => {
      console.error('Failed to clear developer trace entries.', error);
    });
    resetContactSubscriptionsRuntimeState('clear-private-key');
    resetGroupRosterSubscriptionRuntimeState('clear-private-key');
    resetMyRelayListRuntimeState('clear-private-key');
    resetMuteListRuntimeState();
    resetOutboundMessageReplayRuntimeState();
    resetPrivateMessagesBackfillRuntimeState();
    resetReconnectHealingRuntimeState();
    resetPrivateContactListRuntimeState('clear-private-key');
    stopPrivateMessagesSubscription();
    resetPrivateMessagesEpochRefreshState();
    loggedInvalidGroupEpochConflictKeys.clear();
    resetPrivateMessagesUiRuntimeState();
    authenticatedRelayUrls.clear();
    clearStoredPrivateMessagesLastReceivedCreatedAt();
    clearPrivateMessagesBackfillState();
    chatStoreClearAllComposerDrafts();
    bumpDeveloperDiagnosticsVersion();

    if (options.clearSecureStorage !== false) {
      void removePersistedSecurePrivateKey();
    }

    if (!hasStorage()) {
      return;
    }

    window.localStorage.removeItem(AUTH_METHOD_STORAGE_KEY);
    window.localStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
    window.localStorage.removeItem(NIP46_SIGNER_PAYLOAD_STORAGE_KEY);
    window.localStorage.removeItem(PUBLIC_KEY_STORAGE_KEY);
    clearPrivatePreferencesStorage();
  }

  async function savePrivateKeyHex(hexPrivateKey: string): Promise<boolean> {
    const normalized = inputSanitizerService.normalizeHexKey(hexPrivateKey);
    if (!normalized || !hasStorage()) {
      return false;
    }

    const signer = new NDKPrivateKeySigner(normalized, ndk);
    clearPrivateKey({ clearSecureStorage: false });
    resetEventSinceForFreshLogin();
    cachedPrivateKeyHex = normalized;

    if (isSecurePrivateKeyStorageAvailable()) {
      await removePersistedSecurePrivateKey();
      await persistSecurePrivateKeyHex(normalized, signer.pubkey);
      setStoredAuthSession('nsec', signer.pubkey);
    } else {
      setStoredAuthSession('nsec', signer.pubkey, normalized);
    }

    setCachedSigner(signer);
    setCachedSignerSessionKey(`nsec:${signer.pubkey}`);
    ndk.signer = signer;
    return true;
  }

  async function loginWithExtension(): Promise<string> {
    if (!hasNip07Extension()) {
      throw new Error('No NIP-07 extension detected. Install or enable one to continue.');
    }

    const signer = new NDKNip07Signer(undefined, ndk);
    const user = await signer.blockUntilReady();
    user.ndk = ndk;
    const pubkeyHex = inputSanitizerService.normalizeHexKey(user.pubkey ?? signer.pubkey);
    if (!pubkeyHex) {
      throw new Error('Failed to read a valid public key from the NIP-07 extension.');
    }

    clearPrivateKey();
    resetEventSinceForFreshLogin();
    setStoredAuthSession('nip07', pubkeyHex);
    setCachedSigner(signer);
    setCachedSignerSessionKey(`nip07:${pubkeyHex}`);
    ndk.signer = signer;
    return pubkeyHex;
  }

  const { createNip46NostrConnectLogin, loginWithNip46Bunker } = createNip46AuthRuntime({
    clearCurrentAuthSession: clearPrivateKey,
    ndk,
    resetEventSinceForFreshLogin,
    setCachedSigner,
    setCachedSignerSessionKey,
    setStoredAuthSession,
    setStoredNip46SignerPayload,
  });

  async function loginWithRemoteSignerBunker(input: {
    connectionToken: string;
    onAuthUrl?: (url: string) => void;
  }): Promise<Nip46LoginResult> {
    return loginWithNip46Bunker(input);
  }

  function createRemoteSignerNostrConnectLogin(input: {
    relayUrl: string;
    onAuthUrl?: (url: string) => void;
  }): Nip46NostrConnectLogin {
    return createNip46NostrConnectLogin(input);
  }

  async function logout(): Promise<void> {
    clearPrivateKey({ clearSecureStorage: false });
    await removePersistedSecurePrivateKey();
    eventSince.value = 0;
    pendingEventSinceState.pendingEventSinceUpdate = 0;
    isRestoringStartupState.value = false;
    setRestoreStartupStatePromise(null);
    setSyncLoggedInContactProfilePromise(null);
    setSyncRecentChatContactsPromise(null);
    restoreRuntimeState.restorePrivatePreferencesPromise = null;
    restoreRuntimeState.restoreGroupIdentitySecretsPromise = null;
    restoreRuntimeState.restoreContactCursorStatePromise = null;
    resetPrivateMessagesIngestRuntimeState();
    resetPrivateMessagesUiRuntimeState({ includeRefreshQueue: true });
    configuredRelayUrls.clear();
    relayConnectPromises.clear();
    relayConnectFailureCooldownUntilByUrl.clear();
    groupContactRefreshPromises.clear();
    backgroundGroupContactRefreshStartedAt.clear();
    setPendingPrivateMessagesEpochSubscriptionRefreshOptions(null);
    setPrivateMessagesEpochSubscriptionRefreshQueue(Promise.resolve());
    loggedInvalidGroupEpochConflictKeys.clear();
    contactListVersion.value = 0;
    relayStatusVersion.value += 1;
    clearRelayStoreState();
    clearNip65RelayStoreState();

    await clearPersistedAppState();
  }

  return {
    clearPrivateKey,
    createRemoteSignerNostrConnectLogin,
    getPrivateKeyHex,
    loadPrivateKeyHex,
    getNip46SignerPayload,
    getNip46SignerSessionSnapshot,
    loginWithExtension,
    loginWithRemoteSignerBunker,
    logout,
    savePrivateKeyHex,
  };
}
