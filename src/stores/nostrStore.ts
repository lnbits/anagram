import { Capacitor } from '@capacitor/core';
import NDK, {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
  normalizeRelayUrl,
} from '@nostr-dev-kit/ndk';
import { defineStore } from 'pinia';
import type { ChatRow } from 'src/services/chatDataService';
import {
  inputSanitizerService,
  type NpubValidationResult,
  type NsecValidationResult,
  type PrivateKeyValidationResult,
} from 'src/services/inputSanitizerService';
import { useChatStore } from 'src/stores/chatStore';
import { useNip65RelayStore } from 'src/stores/nip65RelayStore';
import { createAppLifecycleRuntime } from 'src/stores/nostr/appLifecycleRuntime';
import { createAuthIdentityRuntime } from 'src/stores/nostr/authIdentityRuntime';
import { createAuthSessionRuntime } from 'src/stores/nostr/authSessionRuntime';
import { createBlossomSettingsRuntime } from 'src/stores/nostr/blossomSettingsRuntime';
import {
  DEFAULT_EVENT_SINCE_LOOKBACK_SECONDS,
  DEVELOPER_DIAGNOSTICS_STORAGE_KEY,
  INITIAL_CONNECT_TIMEOUT_MS,
  LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY,
  PRIVATE_MESSAGES_EPOCH_SUBSCRIPTION_REFRESH_DEBOUNCE_MS,
  PRIVATE_MESSAGES_LIVE_RECONNECT_LOOKBACK_SECONDS,
  RELAY_CONNECT_FAILURE_COOLDOWN_MS,
  RELAY_FIRST_HEALTHY_WAIT_MS,
  STARTUP_STEP_MIN_PROGRESS_MS,
} from 'src/stores/nostr/constants';
import { createContactProfileRuntime } from 'src/stores/nostr/contactProfileRuntime';
import { createContactRelayRuntime } from 'src/stores/nostr/contactRelayRuntime';
import { createContactSubscriptionsRuntime } from 'src/stores/nostr/contactSubscriptionsRuntime';
import { createDeveloperDiagnosticsRuntime } from 'src/stores/nostr/developerDiagnostics';
import { createDeveloperRelayRuntime } from 'src/stores/nostr/developerRelayRuntime';
import {
  createDeveloperTraceRuntime,
  readDeveloperDiagnosticsEnabledFromStorage,
} from 'src/stores/nostr/developerTrace';
import { createGroupEpochPublishRuntime } from 'src/stores/nostr/groupEpochPublishRuntime';
import { createGroupEpochStateRuntime } from 'src/stores/nostr/groupEpochStateRuntime';
import { createGroupInviteRuntime } from 'src/stores/nostr/groupInviteRuntime';
import { createGroupRosterSubscriptionRuntime } from 'src/stores/nostr/groupRosterSubscriptionRuntime';
import { createInboundPresentationRuntime } from 'src/stores/nostr/inboundPresentationRuntime';
import { createMessageEventRuntime } from 'src/stores/nostr/messageEventRuntime';
import { createMessageMutationRuntime } from 'src/stores/nostr/messageMutationRuntime';
import { createMessageRelayRuntime } from 'src/stores/nostr/messageRelayRuntime';
import { createMuteListRuntime } from 'src/stores/nostr/muteListRuntime';
import { createMyRelayListRuntime } from 'src/stores/nostr/myRelayListRuntime';
import { createAppNdkOptions } from 'src/stores/nostr/ndkOptions';
import { createOutboundMessageReplayRuntime } from 'src/stores/nostr/outboundMessageReplayRuntime';
import { createPrivateContactListRuntime } from 'src/stores/nostr/privateContactListRuntime';
import { createPrivateContactMembershipRuntime } from 'src/stores/nostr/privateContactMembershipRuntime';
import { createPrivateMessagesBackfillRuntime } from 'src/stores/nostr/privateMessagesBackfillRuntime';
import { createPrivateMessagesIngestRuntime } from 'src/stores/nostr/privateMessagesIngestRuntime';
import { createPrivateMessagesSubscriptionRuntime } from 'src/stores/nostr/privateMessagesSubscriptionRuntime';
import { createPrivateMessagesUiRuntime } from 'src/stores/nostr/privateMessagesUiRuntime';
import { createPrivateStateRuntime } from 'src/stores/nostr/privateStateRuntime';
import {
  createReconnectHealingRuntime,
  type ReconnectHealingReason,
  type ReconnectHealingRunOptions,
} from 'src/stores/nostr/reconnectHealingRuntime';
import { createRelayConnectionRuntime } from 'src/stores/nostr/relayConnectionRuntime';
import { createRelayPublishRuntime } from 'src/stores/nostr/relayPublishRuntime';
import { createStartupContactSyncRuntime } from 'src/stores/nostr/startupContactSyncRuntime';
import { createStartupRuntime } from 'src/stores/nostr/startupRuntime';
import {
  createInitialStartupStepSnapshots,
  type StartupDisplaySnapshot,
  type StartupStepId,
  type StartupStepSnapshot,
} from 'src/stores/nostr/startupState';
import { createStorageSessionRuntime } from 'src/stores/nostr/storageSession';
import { createSubscriptionLoggingRuntime } from 'src/stores/nostr/subscriptionLoggingRuntime';
import { createSubscriptionRefreshRuntime } from 'src/stores/nostr/subscriptionRefreshRuntime';
import { createTrackedContactStateRuntime } from 'src/stores/nostr/trackedContactStateRuntime';
import type {
  ContactCursorState,
  GroupIdentitySecretContent,
  Nip46SessionSnapshot,
  PendingIncomingDeletion,
  PendingIncomingReaction,
  PrivatePreferences,
  RefreshPrivateMessagesLiveSubscriptionOptions,
  RefreshPrivateMessagesLiveSubscriptionResult,
  RelaySaveStatus,
  RepairMissingMessageDependencyOptions,
  SubscribePrivateMessagesOptions,
} from 'src/stores/nostr/types';
import { createUserActions } from 'src/stores/nostr/userActions';
import {
  applyContactProfileEventStateToMetaValue,
  applyContactRelayListEventStateToMetaValue,
  buildIdentifierFallbacksValue,
  buildUpdatedContactMetaValue,
  contactMetadataEqualValue,
  contactRelayListsEqualValue,
  findConflictingKnownGroupEpochNumberValue,
  findHigherKnownGroupEpochConflictValue,
  isContactListedInPrivateContactListValue,
  normalizeChatGroupEpochKeysValue,
  normalizeRelayStatusUrlsValue,
  normalizeWritableRelayUrlsValue,
  readContactProfileEventSinceValue,
  readContactRelayListEventSinceValue,
  relayEntriesFromRelayListValue,
  resolveCurrentGroupChatEpochEntryValue,
  resolveGroupChatEpochEntriesValue,
  resolveGroupDisplayNameValue,
  resolveGroupPublishRelayUrlsValue,
  resolveIncomingChatInboxStateValue,
  resolvePrivateMessagesLiveReconnectSinceValue,
  shouldPreserveExistingGroupRelaysValue,
} from 'src/stores/nostr/valueUtils';
import { useRelayStore } from 'src/stores/relayStore';
import type { ChatGroupEpochKey, MessageRelayStatus } from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';
import { buildBlossomUploadAuthorization, requireBlossomServerUrl } from 'src/utils/blossomServer';
import { ref, watch } from 'vue';

export type {
  StartupDisplaySnapshot,
  StartupInternalTaskSnapshot,
  StartupStepId,
  StartupStepSnapshot,
  StartupStepStatus,
  StartupTimedSnapshot,
  StartupTrackId,
} from 'src/stores/nostr/startupState';
export type {
  AuthMethod,
  CreateGroupChatResult,
  DeveloperDiagnosticsSnapshot,
  DeveloperGroupMessageSubscriptionSnapshot,
  DeveloperPendingQueueRefreshSummary,
  DeveloperRelayRow,
  DeveloperTraceEntry,
  DeveloperTraceLevel,
  Nip46LoginResult,
  Nip46NostrConnectLogin,
  Nip46SessionSnapshot,
  NostrIdentifierResolutionResult,
  NostrNip05DataResult,
  PublishGroupMemberChangesResult,
  PublishUserMetadataInput,
  RelayConnectionState,
  RelaySaveStatus,
  RotateGroupEpochResult,
  UserProfileLookupResult,
} from 'src/stores/nostr/types';

export type NostrNpubValidationResult = NpubValidationResult;
export type NostrNsecValidationResult = NsecValidationResult;
export type NostrPrivateKeyValidationResult = PrivateKeyValidationResult;
export { __nostrStoreTestUtils } from 'src/stores/nostr/testUtils';

export const useNostrStore = defineStore('nostrStore', () => {
  const ndk = new NDK(createAppNdkOptions());
  const chatStore = useChatStore();
  const nip65RelayStore = useNip65RelayStore();
  const relayStore = useRelayStore();
  const relayStatusVersion = ref(0);
  const contactListVersion = ref(0);
  const isRestoringStartupState = ref(false);
  const eventSince = ref(0);
  const startupSteps = ref<StartupStepSnapshot[]>(createInitialStartupStepSnapshots());
  const startupDisplay = ref<StartupDisplaySnapshot>({
    stepId: null,
    label: null,
    status: null,
    showProgress: false,
  });
  const developerDiagnosticsEnabled = ref(
    readDeveloperDiagnosticsEnabledFromStorage(DEVELOPER_DIAGNOSTICS_STORAGE_KEY)
  );
  const developerDiagnosticsVersion = ref(0);
  const developerTraceVersion = ref(0);
  const privateMessagesSubscriptionRelayUrls = ref<string[]>([]);
  const privateMessagesSubscriptionSince = ref<number | null>(null);
  const privateMessagesSubscriptionStartedAt = ref<string | null>(null);
  const privateMessagesSubscriptionLastEventSeenAt = ref<string | null>(null);
  const privateMessagesSubscriptionLastEventId = ref<string | null>(null);
  const privateMessagesSubscriptionLastEventCreatedAt = ref<number | null>(null);
  const privateMessagesSubscriptionLastEoseAt = ref<string | null>(null);
  const privateMessagesSubscriptionLiveCoverageAt = ref<number | null>(null);
  const isAppForeground = ref(false);
  const isReconnectHealing = ref(false);
  const reconnectHealingStatusLabel = ref<string | null>(null);
  let cachedSigner: NDKSigner | null = null;
  let cachedSignerSessionKey: string | null = null;
  const configuredRelayUrls = new Set<string>();
  const relayConnectPromises = new Map<string, Promise<void>>();
  const relayConnectFailureCooldownUntilByUrl = new Map<string, number>();
  const pendingDirectMessageRelayRetryPromises = new Map<string, Promise<void>>();
  let connectPromise: Promise<void> | null = null;
  let hasActivatedPool = false;
  let hasRelayStatusListeners = false;
  const relayAuthFailureListenerUrls = new Set<string>();
  let restoreStartupStatePromise: Promise<void> | null = null;
  let syncLoggedInContactProfilePromise: Promise<void> | null = null;
  let syncRecentChatContactsPromise: Promise<void> | null = null;
  const groupContactRefreshPromises = new Map<string, Promise<ContactRecord | null>>();
  const backgroundGroupContactRefreshStartedAt = new Map<string, number>();
  const pendingIncomingReactions = new Map<string, PendingIncomingReaction[]>();
  const pendingIncomingDeletions = new Map<string, PendingIncomingDeletion[]>();
  const pendingContactCursorPublishTimers = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  const pendingContactCursorPublishStates = new Map<string, ContactCursorState>();
  const restoreRuntimeState = {
    restoreContactCursorStatePromise: null as Promise<void> | null,
    restoreGroupIdentitySecretsPromise: null as Promise<void> | null,
    restorePrivatePreferencesPromise: null as Promise<void> | null,
  };
  let privateMessagesEpochSubscriptionRefreshTimerId: ReturnType<
    typeof globalThis.setTimeout
  > | null = null;
  let pendingPrivateMessagesEpochSubscriptionRefreshOptions: SubscribePrivateMessagesOptions | null =
    null;
  let privateMessagesEpochSubscriptionRefreshQueue = Promise.resolve();
  const loggedInvalidGroupEpochConflictKeys = new Set<string>();
  let privateMessagesRestoreThrottleMs = 0;
  let getPrivateMessagesIngestQueueRuntime: () => Promise<void> = () => Promise.resolve();
  let subscribePrivateMessagesForLoggedInUserRuntime: (
    force?: boolean,
    options?: SubscribePrivateMessagesOptions
  ) => Promise<void> = async () => {
    throw new Error('Private messages subscription runtime is not initialized.');
  };
  let refreshPrivateMessagesLiveSubscriptionRuntime: (
    options?: RefreshPrivateMessagesLiveSubscriptionOptions
  ) => Promise<RefreshPrivateMessagesLiveSubscriptionResult> = async () => {
    throw new Error('Private messages subscription refresh runtime is not initialized.');
  };
  let subscribeGroupMembershipRosterUpdatesRuntime: (
    seedRelayUrls?: string[],
    force?: boolean
  ) => Promise<void> = async () => {
    throw new Error('Group roster subscription runtime is not initialized.');
  };
  let resetGroupRosterSubscriptionRuntimeState = (_reason = 'replace'): void => {};
  let resetMuteListRuntimeStateRuntime: () => void = () => {};
  let isPubkeyBlockedRuntime: (pubkey: string) => boolean = () => false;
  let _ensurePrivateMessagesWatchdogRuntime: () => void = () => {};
  let isPrivateMessagesSubscriptionRelayTrackedRuntime: (relayUrl: string) => boolean = () => false;
  let markPrivateMessagesWatchdogRelayDisconnectedRuntime: (relayUrl: string) => void = () => {};
  let queuePrivateMessagesWatchdogRuntime: (delayMs?: number) => void = () => {};
  let queueOutboundMessageReplayRuntime: (reason: string, delayMs?: number) => void = () => {};
  let notifyOutboundMessageReplayRelayConnectedRuntime: () => void = () => {};
  let notifyReconnectHealingBrowserOnlineRuntime: () => void = () => {};
  let notifyReconnectHealingVisibilityHiddenRuntime: () => void = () => {};
  let notifyReconnectHealingVisibilityRegainRuntime: () => void = () => {};
  let notifyReconnectHealingWindowBlurRuntime: () => void = () => {};
  let notifyReconnectHealingWindowFocusRuntime: () => void = () => {};
  let notifyReconnectHealingRelayListChangedRuntime: () => void = () => {};
  let resetAppLifecycleRuntimeStateRuntime: () => void = () => {};
  let resetReconnectHealingRuntimeStateRuntime: () => void = () => {};
  let runReconnectHealingRuntime: (
    reason: ReconnectHealingReason,
    options?: ReconnectHealingRunOptions
  ) => Promise<void> = async () => {
    throw new Error('Reconnect healing runtime is not initialized.');
  };
  let setAppLifecycleRouteChatIdRuntime: (chatId: string | null) => void = () => {};
  let startAppLifecycleRuntimeRuntime: () => void = () => {};
  let resetOutboundMessageReplayRuntimeStateRuntime: () => void = () => {};
  let startOutboundMessageReplayRuntime: () => Promise<void> = async () => {};
  let getOrCreateSignerRuntime: () => Promise<NDKSigner> = async () => {
    throw new Error('Relay connection runtime is not initialized.');
  };
  let getPrivateKeyHexRuntime: () => string | null = () => {
    throw new Error('Auth session runtime is not initialized.');
  };
  let loadPrivateKeyHexRuntime: () => Promise<string | null> = async () => {
    throw new Error('Auth session runtime is not initialized.');
  };
  let getNip46SignerPayloadRuntime: () => string | null = () => {
    throw new Error('Auth session runtime is not initialized.');
  };
  let getNip46SignerSessionSnapshotRuntime: () => Nip46SessionSnapshot = () => ({
    signerPubkey: null,
    relayUrls: [],
  });
  let refreshAllStoredContactsRuntime: () => Promise<unknown> = async () => {
    throw new Error('Private messages refresh runtime is not initialized.');
  };
  let queueBackgroundGroupContactRefreshRuntime: (
    groupPublicKey: string,
    fallbackName: string,
    seedRelayUrls?: string[]
  ) => void = () => {};
  let startPrivateMessagesStartupBackfillRuntime: (
    loggedInPubkeyHex: string,
    recipientPubkeys: string[],
    relayUrls: string[],
    liveSince: number
  ) => void = () => {
    throw new Error('Private messages backfill runtime is not initialized.');
  };
  let stopPrivateMessagesBackfillRuntime: (reason?: string) => void = () => {};
  let restoreGroupEpochHistoryRuntime: (
    groupPublicKey: string,
    epochPublicKey: string,
    options?: {
      force?: boolean;
      seedRelayUrls?: string[];
    }
  ) => Promise<void> = async () => {
    throw new Error('Group epoch history runtime is not initialized.');
  };
  let restorePrivateMessagesForRecipientRuntime: (
    recipientPubkey: string,
    options?: {
      force?: boolean;
      seedRelayUrls?: string[];
    }
  ) => Promise<void> = async () => {
    throw new Error('Private messages for recipient runtime is not initialized.');
  };
  let repairMissingMessageDependencyRuntime: (
    chatPublicKey: string,
    targetEventId: string,
    options: RepairMissingMessageDependencyOptions
  ) => Promise<boolean> = async () => {
    throw new Error('Missing message dependency repair runtime is not initialized.');
  };
  let resolveMissingMessageDependencyRepairRuntime: (targetEventId: string) => void = () => {};
  let resetPrivateMessagesBackfillRuntimeStateRuntime: () => void = () => {};
  let upsertIncomingGroupInviteRequestChatRuntime: (
    groupPublicKey: string,
    createdAt: string,
    preview?: Pick<ContactRecord, 'name' | 'meta'> | null
  ) => Promise<void> = async () => {
    throw new Error('Group invite runtime is not initialized.');
  };
  let publishGroupIdentitySecretRuntime: (
    groupPublicKey: string,
    encryptedPrivateKey: string,
    seedRelayUrls?: string[]
  ) => Promise<RelaySaveStatus> = async () => {
    throw new Error('Private state runtime is not initialized.');
  };
  let publishGroupMembershipFollowSetRuntime: (
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls?: string[]
  ) => Promise<RelaySaveStatus> = async () => {
    throw new Error('Private state runtime is not initialized.');
  };
  let publishGroupMembershipRosterFollowSetRuntime: (
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls?: string[]
  ) => Promise<RelaySaveStatus> = async () => {
    throw new Error('Private state runtime is not initialized.');
  };
  const authenticatedRelayUrls = new Set<string>();
  const pendingEventSinceState = {
    pendingEventSinceUpdate: 0,
  };
  const startupRuntimeState = {
    startupDisplayShownAt: 0,
    startupDisplayTimer: null as ReturnType<typeof globalThis.setTimeout> | null,
    startupDisplayToken: 0,
  };
  const developerTraceState = {
    developerTraceCounter: 0,
  };
  const {
    buildContactProfileEventState,
    buildContactRelayListEventState,
    markContactProfileEventApplied,
    markContactRelayListEventApplied,
    markPrivateContactListEventApplied,
    pruneTrackedContactProfileEventState,
    pruneTrackedContactRelayListEventState,
    resetTrackedContactEventState,
    shouldApplyContactProfileEvent: shouldApplyTrackedContactProfileEvent,
    shouldApplyContactRelayListEvent: shouldApplyTrackedContactRelayListEvent,
    shouldApplyPrivateContactListEvent,
  } = createTrackedContactStateRuntime();

  function shouldApplyContactProfileEvent(
    event: Pick<NDKEvent, 'created_at' | 'id' | 'pubkey'>
  ): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || isPubkeyBlockedRuntime(normalizedPubkey)) {
      return false;
    }

    return shouldApplyTrackedContactProfileEvent(event);
  }

  function shouldApplyContactRelayListEvent(
    event: Pick<NDKEvent, 'created_at' | 'id' | 'pubkey'>
  ): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || isPubkeyBlockedRuntime(normalizedPubkey)) {
      return false;
    }

    return shouldApplyTrackedContactRelayListEvent(event);
  }
  const {
    beginStartupInternalTask,
    beginStartupStep,
    completeStartupInternalTask,
    completeStartupStep,
    createStartupBatchTracker,
    failStartupInternalTask,
    failStartupStep,
    getStartupStepSnapshot,
    resetStartupStep,
    resetStartupStepTracking,
    updateStartupInternalTask,
    updateStartupStep,
  } = createStartupRuntime({
    startupDisplay,
    startupState: startupRuntimeState,
    startupSteps,
    startupStepMinProgressMs: STARTUP_STEP_MIN_PROGRESS_MS,
  });
  const {
    derivePublicKeyFromPrivateKey,
    encodeNprofile,
    encodeNpub,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    getStoredAuthMethod,
    hasNip07Extension,
  } = createAuthIdentityRuntime({
    getOrCreateSigner,
    getPrivateKeyHex: () => getPrivateKeyHexRuntime(),
    ndk,
  });
  const {
    bumpDeveloperDiagnosticsVersion,
    clearDeveloperTraceEntries,
    listDeveloperTraceEntries,
    logDeveloperTrace,
    setDeveloperDiagnosticsEnabled,
    toOptionalIsoTimestampFromUnix,
  } = createDeveloperTraceRuntime({
    developerDiagnosticsEnabled,
    developerDiagnosticsStorageKey: DEVELOPER_DIAGNOSTICS_STORAGE_KEY,
    developerDiagnosticsVersion,
    getLoggedInPublicKeyHex,
    developerTraceState,
    developerTraceVersion,
  });
  const { buildRelaySnapshot, getRelaySnapshots, logMessageRelayDiagnostics, logRelayLifecycle } =
    createDeveloperRelayRuntime({
      logDeveloperTrace,
      ndk,
    });
  const {
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

    normalizeTimestamp,

    readStoredPrivateMessagesLastReceivedCreatedAt,
    readPrivatePreferencesFromStorage,

    resetEventSinceForFreshLogin,

    sha256Hex,
    toComparableTimestamp,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
    writePrivateMessagesBackfillState,
    writePrivatePreferencesToStorage,
  } = createStorageSessionRuntime({
    eventSince,
    getDefaultEventSince,
    getLoggedInSignerUser,
    isRestoringStartupState,
    ndk,
    normalizeEventId,
    pendingEventSinceState,
  });

  watch(
    () =>
      relayStore.relayEntries.map(
        (entry) => `${entry.url}:${entry.read !== false}:${entry.write !== false}`
      ),
    () => {
      queueTrackedContactSubscriptionsRefresh();
      notifyReconnectHealingRelayListChangedRuntime();
    }
  );

  function normalizeThrottleMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return 0;
    }

    return Math.floor(value);
  }

  function getDefaultEventSince(): number {
    return Math.max(0, Math.floor(Date.now() / 1000) - DEFAULT_EVENT_SINCE_LOOKBACK_SECONDS);
  }

  function isNativeAndroidRuntime(): boolean {
    try {
      return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
    } catch {
      return false;
    }
  }

  function getPrivateMessagesReconnectSince(baseUnixTime = Math.floor(Date.now() / 1000)): number {
    return resolvePrivateMessagesLiveReconnectSinceValue({
      liveCoverageAt: privateMessagesSubscriptionLiveCoverageAt.value,
      lastEventTime: readStoredPrivateMessagesLastReceivedCreatedAt(),
      startupFloorSince: getPrivateMessagesStartupFloorSince(baseUnixTime),
      lookbackSeconds: PRIVATE_MESSAGES_LIVE_RECONNECT_LOOKBACK_SECONDS,
    });
  }

  function refreshPrivateMessagesLiveSubscriptionForReconnect(
    options: { forceRecreate?: boolean; sinceMode?: 'reconnect' | 'startup' } = {}
  ): Promise<RefreshPrivateMessagesLiveSubscriptionResult> {
    return refreshPrivateMessagesLiveSubscriptionRuntime({
      forceRecreate: options.forceRecreate,
      sinceOverride:
        options.sinceMode === 'startup'
          ? getPrivateMessagesStartupLiveSince()
          : getPrivateMessagesReconnectSince(),
    });
  }

  function createInitialGroupEpochSecretState(): Pick<
    GroupIdentitySecretContent,
    'epoch_number' | 'epoch_privkey'
  > {
    const epochSigner = NDKPrivateKeySigner.generate();
    return {
      epoch_number: 0,
      epoch_privkey: epochSigner.privateKey,
    };
  }

  function readFirstTagValue(tags: string[][], tagName: string): string | null {
    for (const tag of tags) {
      if (!Array.isArray(tag) || tag[0] !== tagName) {
        continue;
      }

      const value = typeof tag[1] === 'string' ? tag[1].trim() : '';
      if (value) {
        return value;
      }
    }

    return null;
  }

  function readEpochNumberTag(tags: string[][]): number | null {
    const epochValue = readFirstTagValue(tags, 'epoch');
    if (!epochValue) {
      return null;
    }

    const epochNumber = Number(epochValue);
    if (!Number.isInteger(epochNumber) || epochNumber < 0) {
      return null;
    }

    return Math.floor(epochNumber);
  }

  const normalizeChatGroupEpochKeys = normalizeChatGroupEpochKeysValue;
  const resolveGroupChatEpochEntries = resolveGroupChatEpochEntriesValue;
  const resolveCurrentGroupChatEpochEntry = resolveCurrentGroupChatEpochEntryValue;

  const findHigherKnownGroupEpochConflict = findHigherKnownGroupEpochConflictValue;
  const findConflictingKnownGroupEpochNumber = findConflictingKnownGroupEpochNumberValue;

  function logInvalidIncomingEpochNumber(
    groupPublicKey: string,
    epochNumber: number,
    epochPublicKey: string | null,
    createdAt: string | null,
    conflict: {
      higherEpochEntry: ChatGroupEpochKey;
      olderHigherEpochEntry: ChatGroupEpochKey | null;
    }
  ): void {
    const logKey = [
      inputSanitizerService.normalizeHexKey(groupPublicKey) ?? groupPublicKey,
      String(epochNumber),
      inputSanitizerService.normalizeHexKey(epochPublicKey ?? '') ?? '',
      createdAt ?? '',
    ].join(':');
    if (loggedInvalidGroupEpochConflictKeys.has(logKey)) {
      return;
    }

    loggedInvalidGroupEpochConflictKeys.add(logKey);
    console.warn(
      `Invalid epoch number ${epochNumber}. A higher epoch was issued which is older than this epoch ${epochNumber} ${createdAt ?? 'unknown'}`,
      {
        groupPublicKey,
        epochPublicKey: epochPublicKey ?? null,
        higherEpochNumber: conflict.higherEpochEntry.epoch_number,
        higherEpochPublicKey: conflict.higherEpochEntry.epoch_public_key,
        higherEpochCreatedAt:
          conflict.olderHigherEpochEntry?.invitation_created_at ??
          conflict.higherEpochEntry.invitation_created_at ??
          null,
        createdAt: createdAt ?? null,
      }
    );
  }

  function logConflictingIncomingEpochNumber(
    groupPublicKey: string,
    epochNumber: number,
    epochPublicKey: string | null,
    createdAt: string | null,
    conflict: ChatGroupEpochKey
  ): void {
    const logKey = [
      'conflicting-epoch-number',
      inputSanitizerService.normalizeHexKey(groupPublicKey) ?? groupPublicKey,
      String(epochNumber),
      inputSanitizerService.normalizeHexKey(epochPublicKey ?? '') ?? '',
      inputSanitizerService.normalizeHexKey(conflict.epoch_public_key) ?? conflict.epoch_public_key,
      createdAt ?? '',
    ].join(':');
    if (loggedInvalidGroupEpochConflictKeys.has(logKey)) {
      return;
    }

    loggedInvalidGroupEpochConflictKeys.add(logKey);
    console.warn(
      `Invalid epoch number ${epochNumber}. Epoch ${epochNumber} was already issued with a different epoch public key ${createdAt ?? 'unknown'}`,
      {
        groupPublicKey,
        epochPublicKey: epochPublicKey ?? null,
        conflictingEpochPublicKey: conflict.epoch_public_key,
        conflictingEpochCreatedAt: conflict.invitation_created_at ?? null,
        createdAt: createdAt ?? null,
      }
    );
  }

  const isContactListedInPrivateContactList = isContactListedInPrivateContactListValue;
  async function findGroupChatEpochContextByRecipientPubkey(epochPublicKey: string): Promise<{
    chat: ChatRow;
    epochEntry: ChatGroupEpochKey;
  } | null> {
    return findGroupChatEpochContextByRecipientPubkeyRuntime(epochPublicKey);
  }

  async function upsertIncomingGroupInviteRequestChat(
    groupPublicKey: string,
    createdAt: string,
    preview: Pick<ContactRecord, 'name' | 'meta'> | null = null
  ): Promise<void> {
    return upsertIncomingGroupInviteRequestChatRuntime(groupPublicKey, createdAt, preview);
  }

  function buildRelaySaveStatus(relayStatuses: MessageRelayStatus[]): RelaySaveStatus {
    const relayUrls = normalizeRelayStatusUrls(relayStatuses.map((entry) => entry.relay_url));
    const publishedRelayUrls = normalizeRelayStatusUrls(
      relayStatuses
        .filter((entry) => entry.direction === 'outbound' && entry.status === 'published')
        .map((entry) => entry.relay_url)
    );
    const failedRelayUrls = normalizeRelayStatusUrls(
      relayStatuses
        .filter((entry) => entry.direction === 'outbound' && entry.status === 'failed')
        .map((entry) => entry.relay_url)
    );
    const firstFailure = relayStatuses.find(
      (entry) => entry.direction === 'outbound' && entry.status === 'failed' && entry.detail?.trim()
    );

    return {
      relayUrls,
      publishedRelayUrls,
      failedRelayUrls,
      errorMessage: firstFailure?.detail?.trim() ?? null,
    };
  }

  function compareReplaceableEventState(
    first: Pick<NDKEvent, 'created_at' | 'id'> | null | undefined,
    second: Pick<NDKEvent, 'created_at' | 'id'> | null | undefined
  ): number {
    const firstCreatedAt = Number(first?.created_at ?? 0);
    const secondCreatedAt = Number(second?.created_at ?? 0);
    if (firstCreatedAt !== secondCreatedAt) {
      return firstCreatedAt - secondCreatedAt;
    }

    const firstId = first?.id?.trim() ?? '';
    const secondId = second?.id?.trim() ?? '';
    return firstId.localeCompare(secondId);
  }

  const resolveGroupDisplayName = resolveGroupDisplayNameValue;

  async function ensurePrivatePreferences(
    options: { publishIfCreated?: boolean } = {}
  ): Promise<PrivatePreferences> {
    const existing = readPrivatePreferencesFromStorage();
    if (existing) {
      return existing;
    }

    const nextPreferences = buildFreshPrivatePreferences();
    writePrivatePreferencesToStorage(nextPreferences);

    if (options.publishIfCreated) {
      await publishPrivatePreferences(nextPreferences);
    }

    return nextPreferences;
  }

  async function deriveContactCursorDTag(contactPublicKey: string): Promise<string | null> {
    const preferences = readPrivatePreferencesFromStorage();
    const normalizedContactPublicKey = inputSanitizerService.normalizeHexKey(contactPublicKey);
    if (!preferences?.contactSecret || !normalizedContactPublicKey) {
      return null;
    }

    return sha256Hex(`${preferences.contactSecret}${normalizedContactPublicKey}`);
  }

  function chunkValues<T>(values: T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) {
      return [values];
    }

    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += chunkSize) {
      chunks.push(values.slice(index, index + chunkSize));
    }
    return chunks;
  }
  let refreshDeveloperPendingQueuesRuntime: () => Promise<unknown> = async () => {};

  const {
    clearPrivateMessagesUiRefreshState,
    flushPrivateMessagesUiRefreshNow,
    queuePrivateMessagesUiRefresh,
    resetPrivateMessagesUiRuntimeState,
    scheduleChatChecks,
    schedulePostPrivateMessagesEoseChecks,
  } = createPrivateMessagesUiRuntime({
    chatStore,
    normalizeThrottleMs,
    refreshDeveloperPendingQueues: async () => {
      await refreshDeveloperPendingQueuesRuntime();
    },
    waitForPrivateMessagesIngestQueue: () =>
      getPrivateMessagesIngestQueueRuntime().catch((error) => {
        console.error(
          'Failed while draining private message ingest queue before EOSE checks',
          error
        );
      }),
  });
  const {
    createDirectMessageRumorEvent,
    createEventDeletionRumorEvent,
    createReactionRumorEvent,
    createStoredDirectMessageRumorEvent,
    createStoredSignedEvent,
    giftWrapSignedEvent,
    normalizeEventId: normalizeEventIdRuntime,
    readDeletionTargetEntries,
    readDirectMessageRecipientPubkey,
    readReactionTargetAuthorPubkey,
    readReactionTargetEventId,
    readReplyTargetEventId,
    resolveIncomingPrivateMessageRecipientContext,
    toStoredNostrEvent,
    unwrapGiftWrapSealEvent,
    verifyIncomingGroupEpochTicket,
  } = createMessageEventRuntime({
    decryptPrivateStringContent,
    derivePublicKeyFromPrivateKey,
    findGroupChatEpochContextByRecipientPubkey,
    getOrCreateSigner,
    ndk,
    readEpochNumberTag,
    readFirstTagValue,
  });
  const {
    appendRelayStatusesToMessageEvent,
    buildInboundRelayStatuses,
    consumePendingIncomingDeletions: consumePendingIncomingDeletionsRuntime,
    consumePendingIncomingReactions: consumePendingIncomingReactionsRuntime,
    queuePendingIncomingDeletion: queuePendingIncomingDeletionRuntime,
    queuePendingIncomingReaction: queuePendingIncomingReactionRuntime,
    refreshMessageInLiveState: refreshMessageInLiveStateRuntime,
    removePendingIncomingReaction: removePendingIncomingReactionRuntime,
  } = createMessageRelayRuntime({
    bumpDeveloperDiagnosticsVersion,
    formatSubscriptionLogValue,
    logMessageRelayDiagnostics,
    normalizeEventId,
    normalizeRelayStatusUrls,
    normalizeThrottleMs,
    pendingIncomingDeletions,
    pendingIncomingReactions,
    queuePrivateMessagesUiRefresh,
    refreshPendingIncomingQueues: async () => {
      await refreshDeveloperPendingQueuesRuntime();
    },
  });

  const {
    buildFilterSinceDetails,
    buildFilterUntilDetails,
    buildLoggedNostrEvent,
    buildPrivateMessageSubscriptionTargetDetails,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    buildTrackedContactSubscriptionTargetDetails,
    formatSubscriptionLogValue: formatSubscriptionLogValueRuntime,
    relaySignature,
    subscribeWithReqLogging,
  } = createSubscriptionLoggingRuntime({
    logDeveloperTrace,
    ndk,
    normalizeEventId,
    resolveGroupChatEpochEntries,
  });

  function formatSubscriptionLogValue(value: string | null | undefined): string | null {
    return formatSubscriptionLogValueRuntime(value);
  }

  function logSubscription(
    name: string,
    phase: string,
    details: Record<string, unknown> = {}
  ): void {
    logDeveloperTrace('info', `subscription:${name}`, phase, details);
  }

  const {
    resetAppLifecycleRuntimeState: resetAppLifecycleRuntimeStateImpl,
    setRouteChatId: setAppLifecycleRouteChatIdImpl,
    startAppLifecycleRuntime: startAppLifecycleRuntimeImpl,
  } = createAppLifecycleRuntime({
    notifyReconnectHealingBrowserOnline: () => {
      notifyReconnectHealingBrowserOnlineRuntime();
    },
    notifyReconnectHealingVisibilityHidden: () => {
      notifyReconnectHealingVisibilityHiddenRuntime();
    },
    notifyReconnectHealingVisibilityRegain: () => {
      notifyReconnectHealingVisibilityRegainRuntime();
    },
    notifyReconnectHealingWindowBlur: () => {
      notifyReconnectHealingWindowBlurRuntime();
    },
    notifyReconnectHealingWindowFocus: () => {
      notifyReconnectHealingWindowFocusRuntime();
    },
    setIsAppForeground: (value) => {
      isAppForeground.value = value;
    },
    setVisibleChatId: (chatId) => {
      chatStore.setVisibleChatId(chatId);
    },
  });
  resetAppLifecycleRuntimeStateRuntime = resetAppLifecycleRuntimeStateImpl;
  setAppLifecycleRouteChatIdRuntime = setAppLifecycleRouteChatIdImpl;
  startAppLifecycleRuntimeRuntime = startAppLifecycleRuntimeImpl;

  const {
    buildInboundTraceDetails,
    deriveChatName,
    logInboundEvent,
    shouldNotifyForAcceptedChatOnly,
    showIncomingMessageBrowserNotification,
  } = createInboundPresentationRuntime({
    formatSubscriptionLogValue,
    getLoggedInPublicKeyHex,
    getVisibleChatId: () => chatStore.visibleChatId,
    isAppForeground,
    isRestoringStartupState,
    logDeveloperTrace,
    normalizeEventId,
  });

  function bumpContactListVersion(): void {
    contactListVersion.value += 1;
  }

  const { ensureContactListedInPrivateContactList, reconcileAcceptedChatFromPrivateContactList } =
    createPrivateContactMembershipRuntime({
      bumpContactListVersion,
      chatStore,
    });

  function toIsoTimestampFromUnix(value: number | undefined): string {
    if (!Number.isInteger(value) || Number(value) <= 0) {
      return new Date().toISOString();
    }

    return new Date(Number(value) * 1000).toISOString();
  }

  function toUnixTimestamp(value: string | undefined): number {
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return Math.floor(parsed / 1000);
      }
    }

    return Math.floor(Date.now() / 1000);
  }

  function normalizeRelayStatusUrl(value: string): string | null {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    try {
      return normalizeRelayUrl(normalized);
    } catch {
      return normalized;
    }
  }

  function normalizeRelayStatusUrls(relayUrls: string[]): string[] {
    return normalizeRelayStatusUrlsValue(relayUrls);
  }

  function normalizeEventId(value: unknown): string | null {
    return normalizeEventIdRuntime(value);
  }

  const buildUpdatedContactMeta = buildUpdatedContactMetaValue;
  const buildIdentifierFallbacks = buildIdentifierFallbacksValue;
  const relayEntriesFromRelayList = relayEntriesFromRelayListValue;
  const contactRelayListsEqual = contactRelayListsEqualValue;
  const contactMetadataEqual = contactMetadataEqualValue;
  const applyContactProfileEventStateToMeta = applyContactProfileEventStateToMetaValue;
  const applyContactRelayListEventStateToMeta = applyContactRelayListEventStateToMetaValue;
  const readContactProfileEventSince = readContactProfileEventSinceValue;
  const readContactRelayListEventSince = readContactRelayListEventSinceValue;
  const shouldPreserveExistingGroupRelays = shouldPreserveExistingGroupRelaysValue;

  const {
    ensureRelayConnections,
    fetchRelayNip11Info,
    getOrCreateSigner: getOrCreateSignerImpl,
    getRelayConnectionState,
    isRelayConnectionPending,
  } = createRelayConnectionRuntime({
    authenticatedRelayUrls,
    buildRelaySnapshot,
    bumpRelayStatusVersion,
    configuredRelayUrls,
    getCachedSigner: () => cachedSigner,
    getCachedSignerSessionKey: () => cachedSignerSessionKey,
    getConnectPromise: () => connectPromise,
    getHasActivatedPool: () => hasActivatedPool,
    getHasRelayStatusListeners: () => hasRelayStatusListeners,
    getLoggedInPublicKeyHex,
    getNip46SignerPayload: () => getNip46SignerPayloadRuntime(),
    loadPrivateKeyHex: () => loadPrivateKeyHexRuntime(),
    getStoredAuthMethod,
    hasNip07Extension,
    initialConnectTimeoutMs: INITIAL_CONNECT_TIMEOUT_MS,
    relayFirstHealthyWaitMs: RELAY_FIRST_HEALTHY_WAIT_MS,
    isPrivateMessagesSubscriptionRelayTracked: (relayUrl) =>
      isPrivateMessagesSubscriptionRelayTrackedRuntime(relayUrl),
    logDeveloperTrace,
    logRelayLifecycle,
    markPrivateMessagesWatchdogRelayDisconnected: (relayUrl) => {
      markPrivateMessagesWatchdogRelayDisconnectedRuntime(relayUrl);
    },
    ndk,
    queuePrivateMessagesWatchdog: (delayMs) => {
      queuePrivateMessagesWatchdogRuntime(delayMs);
    },
    queueOutboundMessageReplay: () => {
      notifyOutboundMessageReplayRelayConnectedRuntime();
    },
    relayAuthFailureListenerUrls,
    relayConnectFailureCooldownMs: RELAY_CONNECT_FAILURE_COOLDOWN_MS,
    relayConnectFailureCooldownUntilByUrl,
    relayConnectPromises,
    setCachedSigner: (signer) => {
      cachedSigner = signer;
    },
    setCachedSignerSessionKey: (sessionKey) => {
      cachedSignerSessionKey = sessionKey;
    },
    setConnectPromise: (promise) => {
      connectPromise = promise;
    },
    setHasActivatedPool: (value) => {
      hasActivatedPool = value;
    },
    setHasRelayStatusListeners: (value) => {
      hasRelayStatusListeners = value;
    },
  });
  getOrCreateSignerRuntime = getOrCreateSignerImpl;

  async function getOrCreateSigner(): Promise<NDKSigner> {
    return getOrCreateSignerRuntime();
  }
  const {
    buildMuteListTags,
    buildPrivateContactListTags,
    decryptMuteListContent,
    decryptPrivateContactListContent,
    encryptPrivateContactListTags,
    fetchContactProfile,
    fetchContactRelayList,
    getAppRelayUrls,
    listTrackedContactPubkeys,

    parseContactProfileEvent,
    refreshContactRelayList,
    refreshGroupRelayListsOnStartup,

    resolveGroupPublishRelayUrls,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    resolvePrivateContactListPublishRelayUrls,
    resolvePrivateContactListReadRelayUrls,
    resolvePrivateMessageReadRelayUrls,
    resolveTrackedContactReadRelayUrls,
  } = createContactRelayRuntime({
    applyContactRelayListEventStateToMeta,
    bumpContactListVersion,
    contactMetadataEqual,
    contactRelayListsEqual,
    ensureRelayConnections,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    isPubkeyBlocked: (pubkeyHex) => isPubkeyBlockedRuntime(pubkeyHex),
    markContactRelayListEventApplied,
    ndk,
    normalizeRelayStatusUrls,
    normalizeWritableRelayUrlsValue,
    readContactProfileEventSince,
    readContactRelayListEventSince,
    relayEntriesFromRelayList,
    relayStore,
    resolveGroupPublishRelayUrlsValue,
    shouldPreserveExistingGroupRelays,
    updateStoredEventSinceFromCreatedAt,
  });

  const {
    buildFailedOutboundRelayStatuses,
    buildPendingOutboundRelayStatuses,
    extractRelayUrlsFromEvent,
    publishEventWithRelayStatuses,
    publishGroupMetadata,
    publishGroupRelayList,
    publishReplaceableEventWithRelayStatuses,
    publishUserMetadata,
    sendGiftWrappedRumor,
  } = createRelayPublishRuntime({
    appendRelayStatusesToMessageEvent,
    buildRelaySaveStatus,
    decryptGroupIdentitySecretContent,
    ensureRelayConnections,
    getLoggedInPublicKeyHex,
    getOrCreateSigner,
    ndk,
    normalizeEventId,
    normalizeRelayStatusUrl,
    normalizeRelayStatusUrls,
    resolveGroupPublishRelayUrls,
    resolveLoggedInPublishRelayUrls,
    toStoredNostrEvent,
    toUnixTimestamp,
    updateStoredEventSinceFromCreatedAt,
  });

  const {
    queueEpochDrivenPrivateMessagesSubscriptionRefresh,
    queueTrackedContactSubscriptionsRefresh,
  } = createSubscriptionRefreshRuntime({
    getPendingPrivateMessagesEpochSubscriptionRefreshOptions: () =>
      pendingPrivateMessagesEpochSubscriptionRefreshOptions,
    getPrivateMessagesEpochSubscriptionRefreshQueue: () =>
      privateMessagesEpochSubscriptionRefreshQueue,
    getPrivateMessagesEpochSubscriptionRefreshTimerId: () =>
      privateMessagesEpochSubscriptionRefreshTimerId,
    normalizeRelayStatusUrls,
    normalizeThrottleMs,
    privateMessagesEpochSubscriptionRefreshDebounceMs:
      PRIVATE_MESSAGES_EPOCH_SUBSCRIPTION_REFRESH_DEBOUNCE_MS,
    setPendingPrivateMessagesEpochSubscriptionRefreshOptions: (options) => {
      pendingPrivateMessagesEpochSubscriptionRefreshOptions = options;
    },
    setPrivateMessagesEpochSubscriptionRefreshQueue: (queue) => {
      privateMessagesEpochSubscriptionRefreshQueue = queue;
    },
    setPrivateMessagesEpochSubscriptionRefreshTimerId: (timerId) => {
      privateMessagesEpochSubscriptionRefreshTimerId = timerId;
    },
    subscribeContactProfileUpdates: (seedRelayUrls, force) =>
      subscribeContactProfileUpdates(seedRelayUrls, force),
    subscribeContactRelayListUpdates: (seedRelayUrls, force) =>
      subscribeContactRelayListUpdates(seedRelayUrls, force),
    subscribeGroupMembershipRosterUpdates: (seedRelayUrls, force) =>
      subscribeGroupMembershipRosterUpdatesRuntime(seedRelayUrls, force),
    subscribePrivateMessagesForLoggedInUser: (force, options) =>
      subscribePrivateMessagesForLoggedInUserRuntime(force, options),
  });

  const {
    fetchMyRelayList,
    publishMyRelayList,
    resetMyRelayListRuntimeState,
    restoreMyRelayList,

    subscribeMyRelayListUpdates,
    updateLoggedInUserRelayList,
  } = createMyRelayListRuntime({
    beginStartupStep,
    bumpContactListVersion,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    completeStartupStep,
    ensureRelayConnections,
    extractRelayUrlsFromEvent,
    failStartupStep,
    formatSubscriptionLogValue,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    getRelaySnapshots,
    getStoredAuthMethod,
    logSubscription,
    ndk,
    queueTrackedContactSubscriptionsRefresh,
    relayEntriesFromRelayList,
    relaySignature,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    subscribePrivateMessagesForLoggedInUser: (force) =>
      subscribePrivateMessagesForLoggedInUserRuntime(force),
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt,
  });

  const {
    appendRelayStatusesToGroupMemberTicketEvent,
    ensureGroupContactAndChat,
    ensureGroupIdentitySecretEpochState,
    findGroupChatEpochContextByRecipientPubkey: findGroupChatEpochContextByRecipientPubkeyRuntime,
    listPrivateMessageRecipientPubkeys,
    persistIncomingGroupEpochTicket,
  } = createGroupEpochStateRuntime({
    bumpContactListVersion,
    chatStore,
    decryptGroupIdentitySecretContent,
    derivePublicKeyFromPrivateKey,
    encryptGroupIdentitySecretContent,
    encryptPrivateStringContent,
    getLoggedInPublicKeyHex,
    getPrivateMessagesEpochSwitchSince,
    logConflictingIncomingEpochNumber,
    logInvalidIncomingEpochNumber,
    publishGroupIdentitySecret: (groupPublicKey, encryptedPrivateKey, seedRelayUrls = []) =>
      publishGroupIdentitySecretRuntime(groupPublicKey, encryptedPrivateKey, seedRelayUrls),
    queueEpochDrivenPrivateMessagesSubscriptionRefresh,
    restoreGroupEpochHistory: (groupPublicKey, epochPublicKey, options) =>
      restoreGroupEpochHistoryRuntime(groupPublicKey, epochPublicKey, options),
  });

  const { publishGroupMemberChanges, rotateGroupEpochAndSendTickets, sendGroupEpochTicket } =
    createGroupEpochPublishRuntime({
      appendRelayStatusesToGroupMemberTicketEvent,
      buildFailedOutboundRelayStatuses,
      buildPendingOutboundRelayStatuses,
      buildRelaySaveStatus,
      encryptGroupIdentitySecretContent,
      ensureGroupIdentitySecretEpochState,
      ensureRelayConnections,
      getAppRelayUrls,
      getLoggedInPublicKeyHex,
      giftWrapSignedEvent,
      ndk,
      normalizeEventId,
      persistIncomingGroupEpochTicket,
      publishEventWithRelayStatuses,
      publishGroupIdentitySecret: (groupPublicKey, encryptedPrivateKey, seedRelayUrls = []) =>
        publishGroupIdentitySecretRuntime(groupPublicKey, encryptedPrivateKey, seedRelayUrls),
      publishGroupMembershipFollowSet: (groupPublicKey, memberPublicKeys, seedRelayUrls = []) =>
        publishGroupMembershipFollowSetRuntime(groupPublicKey, memberPublicKeys, seedRelayUrls),
      publishGroupMembershipRosterFollowSet: (
        groupPublicKey,
        memberPublicKeys,
        seedRelayUrls = []
      ) =>
        publishGroupMembershipRosterFollowSetRuntime(
          groupPublicKey,
          memberPublicKeys,
          seedRelayUrls
        ),
      toIsoTimestampFromUnix,
      toStoredNostrEvent,
    });

  const {
    applyPendingIncomingDeletionsForMessage,
    applyPendingIncomingReactionsForMessage,
    buildReplyPreviewFromTargetEvent,
    processIncomingDeletionRumorEvent,
    processIncomingReactionDeletion,
    processIncomingReactionRumorEvent,
    refreshReplyPreviewsForTargetMessage,
  } = createMessageMutationRuntime({
    buildInboundTraceDetails,
    deriveChatName,
    formatSubscriptionLogValue,
    getLoggedInPublicKeyHex,
    logInboundEvent,
    ndk,
    normalizeEventId,
    normalizeThrottleMs,
    queuePendingIncomingDeletion: queuePendingIncomingDeletionRuntime,
    queuePendingIncomingReaction: queuePendingIncomingReactionRuntime,
    queuePrivateMessagesUiRefresh,
    readDeletionTargetEntries,
    readReactionTargetAuthorPubkey,
    readReactionTargetEventId,
    refreshMessageInLiveState: refreshMessageInLiveStateRuntime,
    removePendingIncomingReaction: removePendingIncomingReactionRuntime,
    repairMissingMessageDependency: (chatPublicKey, targetEventId, options) =>
      repairMissingMessageDependencyRuntime(chatPublicKey, targetEventId, options),
    resolveMissingMessageDependencyRepair: (targetEventId) => {
      resolveMissingMessageDependencyRepairRuntime(targetEventId);
    },
    toIsoTimestampFromUnix,
    consumePendingIncomingDeletions: consumePendingIncomingDeletionsRuntime,
    consumePendingIncomingReactions: consumePendingIncomingReactionsRuntime,
  });

  const {
    getPrivateMessagesIngestQueue,
    queuePrivateMessageIngestion,
    resetPrivateMessagesIngestRuntimeState,
  } = createPrivateMessagesIngestRuntime({
    appendRelayStatusesToMessageEvent,
    applyPendingIncomingDeletionsForMessage,
    applyPendingIncomingReactionsForMessage,
    buildInboundRelayStatuses,
    buildInboundTraceDetails,
    buildLoggedNostrEvent,
    buildReplyPreviewFromTargetEvent,
    buildSubscriptionEventDetails,
    chatStore,
    deriveChatName,
    derivePublicKeyFromPrivateKey,
    extractRelayUrlsFromEvent,
    findConflictingKnownGroupEpochNumber,
    findGroupChatEpochContextByRecipientPubkey,
    findHigherKnownGroupEpochConflict,
    formatSubscriptionLogValue,
    getPrivateMessagesRestoreThrottleMs: () => privateMessagesRestoreThrottleMs,
    isContactListedInPrivateContactList,
    isPubkeyBlocked: (pubkeyHex) => isPubkeyBlockedRuntime(pubkeyHex),
    lastSeenReceivedActivityAtMetaKey: LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY,
    logConflictingIncomingEpochNumber,
    logDeveloperTrace,
    logInboundEvent,
    logInvalidIncomingEpochNumber,
    logSubscription,
    normalizeEventId,
    normalizeThrottleMs,
    normalizeTimestamp,
    persistIncomingGroupEpochTicket,
    processIncomingDeletionRumorEvent,
    processIncomingReactionRumorEvent,
    queueBackgroundGroupContactRefresh: (groupPublicKey, fallbackName, seedRelayUrls) => {
      queueBackgroundGroupContactRefreshRuntime(groupPublicKey, fallbackName, seedRelayUrls);
    },
    queuePrivateMessagesUiRefresh,
    readReplyTargetEventId,
    refreshReplyPreviewsForTargetMessage,
    resolveCurrentGroupChatEpochEntry,
    resolveGroupDisplayName,
    resolveIncomingChatInboxStateValue,
    resolveIncomingPrivateMessageRecipientContext,
    shouldNotifyForAcceptedChatOnly,
    showIncomingMessageBrowserNotification,
    toComparableTimestamp,
    toIsoTimestampFromUnix,
    toStoredNostrEvent,
    unwrapGiftWrapSealEvent,
    upsertIncomingGroupInviteRequestChat,
    verifyIncomingGroupEpochTicket,
  });
  getPrivateMessagesIngestQueueRuntime = getPrivateMessagesIngestQueue;

  const {
    ensurePrivateMessagesWatchdog: ensurePrivateMessagesWatchdogImpl,
    getPrivateMessagesSubscription,
    getPrivateMessagesSubscriptionSignature,
    isPrivateMessagesSubscriptionRelayTracked,
    markPrivateMessagesWatchdogRelayDisconnected,
    queuePrivateMessagesWatchdog,
    refreshPrivateMessagesLiveSubscription: refreshPrivateMessagesLiveSubscriptionImpl,
    resetPrivateMessagesSubscriptionRuntimeState,
    stopPrivateMessagesLiveSubscription,
    subscribePrivateMessagesForLoggedInUser: subscribePrivateMessagesForLoggedInUserImpl,
  } = createPrivateMessagesSubscriptionRuntime({
    beginStartupStep,
    buildFilterSinceDetails,
    buildPrivateMessageSubscriptionTargetDetails,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    bumpDeveloperDiagnosticsVersion,
    clearPrivateMessagesUiRefreshState,
    completeStartupStep,
    ensureRelayConnections,
    extractRelayUrlsFromEvent,
    failStartupStep,
    flushPrivateMessagesUiRefreshNow,
    formatSubscriptionLogValue,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getOrCreateSigner,
    getPrivateMessagesRestoreThrottleMs: () => privateMessagesRestoreThrottleMs,
    getPrivateMessagesStartupLiveSince,
    getRelaySnapshots,
    getStartupStepSnapshot,
    getStoredAuthMethod,
    isRestoringStartupState,
    listPrivateMessageRecipientPubkeys,
    logSubscription,
    ndk,
    normalizeEventId,
    normalizeRelayStatusUrls,
    normalizeThrottleMs,
    privateMessagesSubscriptionLastEoseAt,
    privateMessagesSubscriptionLastEventCreatedAt,
    privateMessagesSubscriptionLastEventId,
    privateMessagesSubscriptionLastEventSeenAt,
    privateMessagesSubscriptionLiveCoverageAt,
    privateMessagesSubscriptionRelayUrls,
    privateMessagesSubscriptionSince,
    privateMessagesSubscriptionStartedAt,
    queuePrivateMessageIngestion,
    refreshAllStoredContacts: () => refreshAllStoredContactsRuntime(),
    relaySignature,
    resolvePrivateMessageReadRelayUrls,
    schedulePostPrivateMessagesEoseChecks,
    setPrivateMessagesRestoreThrottleMs: (value) => {
      privateMessagesRestoreThrottleMs = value;
    },
    startPrivateMessagesStartupBackfill: (
      loggedInPubkeyHex,
      recipientPubkeys,
      relayUrls,
      liveSince
    ) => {
      startPrivateMessagesStartupBackfillRuntime(
        loggedInPubkeyHex,
        recipientPubkeys,
        relayUrls,
        liveSince
      );
    },
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
  });
  _ensurePrivateMessagesWatchdogRuntime = ensurePrivateMessagesWatchdogImpl;
  isPrivateMessagesSubscriptionRelayTrackedRuntime = isPrivateMessagesSubscriptionRelayTracked;
  markPrivateMessagesWatchdogRelayDisconnectedRuntime =
    markPrivateMessagesWatchdogRelayDisconnected;
  queuePrivateMessagesWatchdogRuntime = queuePrivateMessagesWatchdog;
  refreshPrivateMessagesLiveSubscriptionRuntime = refreshPrivateMessagesLiveSubscriptionImpl;
  subscribePrivateMessagesForLoggedInUserRuntime = subscribePrivateMessagesForLoggedInUserImpl;
  ensurePrivateMessagesWatchdogImpl();

  const {
    repairMissingMessageDependency: repairMissingMessageDependencyImpl,
    resetPrivateMessagesBackfillRuntimeState: resetPrivateMessagesBackfillRuntimeStateImpl,
    resolveMissingMessageDependencyRepair: resolveMissingMessageDependencyRepairImpl,
    restoreGroupEpochHistory: restoreGroupEpochHistoryImpl,
    restorePrivateMessagesForRecipient: restorePrivateMessagesForRecipientImpl,
    startPrivateMessagesStartupBackfill: startPrivateMessagesStartupBackfillImpl,
    stopPrivateMessagesBackfill: stopPrivateMessagesBackfillImpl,
  } = createPrivateMessagesBackfillRuntime({
    beginStartupInternalTask,
    buildFilterSinceDetails,
    buildFilterUntilDetails,
    buildPrivateMessageSubscriptionTargetDetails,
    buildSubscriptionRelayDetails,
    completeStartupInternalTask,
    completeStartupStep,
    ensureRelayConnections,
    failStartupInternalTask,
    failStartupStep,
    flushPrivateMessagesUiRefreshNow,
    formatSubscriptionLogValue,
    getLoggedInPublicKeyHex,
    getPrivateMessagesBackfillResumeState,
    getPrivateMessagesIngestQueue: () => getPrivateMessagesIngestQueueRuntime(),
    getPrivateMessagesStartupFloorSince,
    logSubscription,
    ndk,
    normalizeThrottleMs,
    queuePrivateMessageIngestion,
    relaySignature,
    resolveGroupChatEpochEntries,
    resolvePrivateMessageReadRelayUrls,
    schedulePostPrivateMessagesEoseChecks,
    subscribeWithReqLogging,
    toOptionalIsoTimestampFromUnix,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
    updateStartupInternalTask,
    writePrivateMessagesBackfillState,
  });
  repairMissingMessageDependencyRuntime = repairMissingMessageDependencyImpl;
  resetPrivateMessagesBackfillRuntimeStateRuntime = resetPrivateMessagesBackfillRuntimeStateImpl;
  resolveMissingMessageDependencyRepairRuntime = resolveMissingMessageDependencyRepairImpl;
  restoreGroupEpochHistoryRuntime = restoreGroupEpochHistoryImpl;
  restorePrivateMessagesForRecipientRuntime = restorePrivateMessagesForRecipientImpl;
  startPrivateMessagesStartupBackfillRuntime = startPrivateMessagesStartupBackfillImpl;
  stopPrivateMessagesBackfillRuntime = stopPrivateMessagesBackfillImpl;

  const {
    resetContactSubscriptionsRuntimeState,
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
  } = createContactSubscriptionsRuntime({
    applyContactProfileEventStateToMeta,
    applyContactRelayListEventStateToMeta,
    buildContactProfileEventState,
    buildContactRelayListEventState,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    buildTrackedContactSubscriptionTargetDetails,
    buildUpdatedContactMeta,
    bumpContactListVersion,
    chatStore,
    contactMetadataEqual,
    contactRelayListsEqual,
    encodeNprofile,
    encodeNpub,
    ensureRelayConnections,
    extractRelayUrlsFromEvent,
    formatSubscriptionLogValue,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    isPubkeyBlocked: (pubkeyHex) => isPubkeyBlockedRuntime(pubkeyHex),
    listTrackedContactPubkeys,
    logSubscription,
    markContactProfileEventApplied,
    markContactRelayListEventApplied,
    ndk,
    parseContactProfileEvent,
    pruneTrackedContactProfileEventState,
    pruneTrackedContactRelayListEventState,
    relayEntriesFromRelayList,
    relaySignature,
    resolveTrackedContactReadRelayUrls,
    shouldApplyContactProfileEvent,
    shouldApplyContactRelayListEvent,
    shouldPreserveExistingGroupRelays,
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt,
  });

  let refreshContactByPublicKeyRuntime: (
    pubkeyHex: string,
    fallbackName?: string,
    lifecycle?: Record<string, unknown>
  ) => Promise<unknown> = async () => {
    throw new Error('Contact profile runtime is not initialized.');
  };

  const {
    publishPrivateContactList,
    refreshPrivateContactListWithOutgoingMessages,
    resetPrivateContactListRuntimeState,
    restorePrivateContactList,
    subscribePrivateContactListUpdates,
  } = createPrivateContactListRuntime({
    beginStartupStep,
    bumpContactListVersion,
    buildPrivateContactListTags,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    chatStore,
    completeStartupStep,
    createStartupBatchTracker,
    decryptPrivateContactListContent,
    encryptPrivateContactListTags,
    ensureContactListedInPrivateContactList,
    ensureRelayConnections,
    extractRelayUrlsFromEvent,
    failStartupStep,
    formatSubscriptionLogValue,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    getStartupStepSnapshot,
    isRestoringStartupState,
    logSubscription,
    markPrivateContactListEventApplied,
    ndk,
    queueTrackedContactSubscriptionsRefresh,
    reconcileAcceptedChatFromPrivateContactList,
    refreshContactByPublicKey: (pubkeyHex, fallbackName, lifecycle) =>
      refreshContactByPublicKeyRuntime(pubkeyHex, fallbackName, lifecycle),
    relaySignature,
    resolvePrivateContactListPublishRelayUrls,
    resolvePrivateContactListReadRelayUrls,
    shouldApplyPrivateContactListEvent,
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt,
    updateStartupStep,
  });

  const {
    isPubkeyBlocked,
    isPubkeyMuted,
    resetMuteListRuntimeState,
    restoreMuteList,
    setPubkeyBlocked,
    setPubkeyMuted,
  } = createMuteListRuntime({
    beginStartupStep,
    buildMuteListTags,
    bumpContactListVersion,
    chatStore,
    completeStartupStep,
    decryptMuteListContent,
    encryptMuteListTags: encryptPrivateContactListTags,
    ensureRelayConnections,
    failStartupStep,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    ndk,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    updateStartupInternalTask,
    updateStoredEventSinceFromCreatedAt,
  });
  resetMuteListRuntimeStateRuntime = resetMuteListRuntimeState;
  isPubkeyBlockedRuntime = isPubkeyBlocked;

  const {
    ensureContactStoredAsGroup,
    ensureRespondedPubkeyIsContact,
    fetchContactPreviewByPublicKey,
    fetchUserProfileFromRelays,
    queueBackgroundGroupContactRefresh,
    refreshContactByPublicKey,
    refreshGroupContactByPublicKey,
  } = createContactProfileRuntime({
    applyContactProfileEventStateToMeta,
    applyContactRelayListEventStateToMeta,
    backgroundGroupContactRefreshStartedAt,
    buildIdentifierFallbacks,
    buildUpdatedContactMeta,
    bumpContactListVersion,
    chatStore,
    contactMetadataEqual,
    contactRelayListsEqual,
    ensureContactListedInPrivateContactList,
    fetchContactProfile,
    fetchContactRelayList,
    getAppRelayUrls,
    getLoggedInPublicKeyHex,
    groupContactRefreshPromises,
    isContactListedInPrivateContactList,
    isPubkeyBlocked: (pubkeyHex) => isPubkeyBlockedRuntime(pubkeyHex),
    markContactProfileEventApplied,
    markContactRelayListEventApplied,
    ndk,
    publishPrivateContactList,
    readContactRelayListEventSince,
    refreshContactRelayList,
    resolveGroupDisplayName,
    shouldPreserveExistingGroupRelays,
  });
  refreshContactByPublicKeyRuntime = refreshContactByPublicKey;
  queueBackgroundGroupContactRefreshRuntime = queueBackgroundGroupContactRefresh;

  const {
    ensureGroupInvitePubkeyIsContact,
    upsertIncomingGroupInviteRequestChat: upsertIncomingGroupInviteRequestChatImpl,
  } = createGroupInviteRuntime({
    bumpContactListVersion,
    chatStore,
    ensureContactListedInPrivateContactList,
    ensureContactStoredAsGroup,
    getAppRelayUrls,
    getLoggedInPublicKeyHex,
    publishPrivateContactList,
    refreshGroupContactByPublicKey,
    restoreGroupEpochHistory: (groupPublicKey, epochPublicKey, options) =>
      restoreGroupEpochHistoryRuntime(groupPublicKey, epochPublicKey, options),
    subscribeGroupMembershipRosterUpdates: (seedRelayUrls, force) =>
      subscribeGroupMembershipRosterUpdatesRuntime(seedRelayUrls, force),
    subscribePrivateMessagesForLoggedInUser: (force) =>
      subscribePrivateMessagesForLoggedInUserRuntime(force),
  });
  upsertIncomingGroupInviteRequestChatRuntime = upsertIncomingGroupInviteRequestChatImpl;

  const {
    applyGroupMembershipRosterEvent,
    applyContactCursorStateToContact,

    createGroupChat,
    fetchContactCursorEvents,
    fetchGroupMembershipFollowSetPubkeys,
    fetchGroupMembershipRosterPubkeys,
    listGroupMembershipRosterSubscriptionContexts,

    publishGroupIdentitySecret: publishGroupIdentitySecretImpl,
    publishGroupMembershipFollowSet: publishGroupMembershipFollowSetImpl,
    publishGroupMembershipRosterFollowSet: publishGroupMembershipRosterFollowSetImpl,
    publishPrivatePreferences,
    refreshGroupMembershipRoster,
    restoreContactCursorState,
    restoreGroupIdentitySecrets,
    restoreGroupMembershipRoster,
    restorePrivatePreferences,
    scheduleContactCursorPublish,
  } = createPrivateStateRuntime({
    beginStartupStep,
    buildFreshPrivatePreferences,
    buildRelaySaveStatus,
    bumpContactListVersion,
    chatStore,
    chunkValues,
    compareReplaceableEventState,
    completeStartupStep,
    contactRelayListsEqual,
    createInitialGroupEpochSecretState,
    createStartupBatchTracker,
    decryptContactCursorContent,
    decryptGroupIdentitySecretContent,
    decryptPrivatePreferencesContent,
    decryptPrivateStringContent,
    deriveContactCursorDTag,
    encryptContactCursorContent,
    encryptGroupIdentitySecretContent,
    encryptPrivatePreferencesContent,
    ensureGroupContactAndChat,
    ensureLoggedInSignerUser: getLoggedInSignerUser,
    ensurePrivatePreferences,
    ensureRelayConnections,
    failStartupStep,
    fetchContactPreviewByPublicKey,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getStartupStepSnapshot,
    isRestoringStartupState,
    ndk,
    normalizeEventId,
    normalizeTimestamp,
    pendingContactCursorPublishStates,
    pendingContactCursorPublishTimers,
    persistIncomingGroupEpochTicket,
    publishGroupRelayList,
    publishPrivateContactList,
    publishEventWithRelayStatuses,
    publishReplaceableEventWithRelayStatuses,
    queueTrackedContactSubscriptionsRefresh,
    readPrivatePreferencesFromStorage,
    refreshContactRelayList,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    restoreState: restoreRuntimeState,
    scheduleChatChecks,
    sha256Hex,
    shouldApplyPrivateContactListEvent,
    toComparableTimestamp,
    toIsoTimestampFromUnix,
    updateStoredEventSinceFromCreatedAt,
    writePrivatePreferencesToStorage,
  });
  publishGroupIdentitySecretRuntime = publishGroupIdentitySecretImpl;
  publishGroupMembershipFollowSetRuntime = publishGroupMembershipFollowSetImpl;
  publishGroupMembershipRosterFollowSetRuntime = publishGroupMembershipRosterFollowSetImpl;

  const { getBlossomServerUrl, saveBlossomServerUrl } = createBlossomSettingsRuntime({
    ensurePrivatePreferences,
    publishPrivatePreferences,
    readPrivatePreferencesFromStorage,
    writePrivatePreferencesToStorage,
  });

  const {
    resetGroupRosterSubscriptionRuntimeState: resetGroupRosterSubscriptionRuntimeStateImpl,
    subscribeGroupMembershipRosterUpdates: subscribeGroupMembershipRosterUpdatesImpl,
  } = createGroupRosterSubscriptionRuntime({
    applyGroupMembershipRosterEvent,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    ensureRelayConnections,
    extractRelayUrlsFromEvent,
    formatSubscriptionLogValue,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getStoredAuthMethod,
    listGroupMembershipRosterSubscriptionContexts,
    logSubscription,
    ndk,
    relaySignature,
    restoreGroupMembershipRoster,
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt,
  });
  resetGroupRosterSubscriptionRuntimeState = resetGroupRosterSubscriptionRuntimeStateImpl;
  subscribeGroupMembershipRosterUpdatesRuntime = subscribeGroupMembershipRosterUpdatesImpl;

  const {
    initializeSessionState,
    refreshAllStoredContacts: refreshAllStoredContactsImpl,
    resetStartupSessionInitialization,
    rerunStartupStep,
    restoreStartupState,
    syncLoggedInContactProfile,
    syncRecentChatContacts,
  } = createStartupContactSyncRuntime({
    applyContactCursorStateToContact,
    beginStartupStep,
    bumpContactListVersion,
    completeStartupStep,
    createStartupBatchTracker,
    deriveContactCursorDTag,
    ensureRelayConnections,
    ensureStoredEventSince,
    fetchContactCursorEvents,
    failStartupStep,
    flushPendingEventSinceUpdate,
    getConfiguredRelayUrls: () => relayStore.relays,
    getLoggedInPublicKeyHex,
    getRestoreStartupStatePromise: () => restoreStartupStatePromise,
    getSyncLoggedInContactProfilePromise: () => syncLoggedInContactProfilePromise,
    getSyncRecentChatContactsPromise: () => syncRecentChatContactsPromise,
    isRestoringStartupState,
    readPrivatePreferencesFromStorage,
    reloadChats: () => chatStore.reload(),
    refreshContactByPublicKey,
    refreshGroupRelayListsOnStartup,
    resetStartupStep,
    resetStartupStepTracking,
    restoreContactCursorState,
    restoreGroupIdentitySecrets,
    restoreMyRelayList,
    restorePrivateContactList,
    restorePrivatePreferences,
    restoreMuteList,
    runLightweightSessionResume: (seedRelayUrls) =>
      runReconnectHealingRuntime('session-resume', {
        propagateError: true,
        sessionRelayUrls: seedRelayUrls,
      }),
    startOutboundMessageReplay: () => startOutboundMessageReplayRuntime(),
    setRestoreStartupStatePromise: (promise) => {
      restoreStartupStatePromise = promise;
    },
    setSyncLoggedInContactProfilePromise: (promise) => {
      syncLoggedInContactProfilePromise = promise;
    },
    setSyncRecentChatContactsPromise: (promise) => {
      syncRecentChatContactsPromise = promise;
    },
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
    subscribeGroupMembershipRosterUpdates: (seedRelayUrls) =>
      subscribeGroupMembershipRosterUpdatesRuntime(seedRelayUrls),
    subscribeMyRelayListUpdates,
    subscribePrivateContactListUpdates,
    subscribePrivateMessagesForLoggedInUser: (force, options) =>
      subscribePrivateMessagesForLoggedInUserRuntime(force, options),
  });
  refreshAllStoredContactsRuntime = refreshAllStoredContactsImpl;

  function bumpRelayStatusVersion(): void {
    relayStatusVersion.value += 1;
  }

  function encodeBase64Utf8(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return globalThis.btoa(binary);
  }

  async function ensureBlossomUploadAuthentication(): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('A logged-in public key is required to upload media.');
    }

    const signer = await getOrCreateSignerRuntime();
    if (!signer.pubkey || signer.pubkey.toLowerCase() !== loggedInPubkeyHex) {
      throw new Error('The active signer does not match the logged-in account.');
    }
  }

  async function signBlossomUploadAuthHeader(input: {
    serverUrl: string;
    sha256: string;
  }): Promise<string> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('A logged-in public key is required to sign upload auth.');
    }

    const serverUrl = requireBlossomServerUrl(input.serverUrl);
    const createdAt = Math.floor(Date.now() / 1000);
    const authorization = buildBlossomUploadAuthorization(serverUrl, input.sha256, createdAt);
    const authEvent = new NDKEvent(ndk, {
      kind: 24242,
      created_at: createdAt,
      pubkey: loggedInPubkeyHex,
      content: authorization.content,
      tags: authorization.tags,
    });
    await authEvent.sign(await getOrCreateSignerRuntime());
    return `Nostr ${encodeBase64Utf8(JSON.stringify(await authEvent.toNostrEvent()))}`;
  }

  const {
    clearPrivateKey: clearPrivateKeyImpl,
    createRemoteSignerNostrConnectLogin: createRemoteSignerNostrConnectLoginImpl,
    getPrivateKeyHex: getPrivateKeyHexImpl,
    loadPrivateKeyHex: loadPrivateKeyHexImpl,
    getNip46SignerPayload: getNip46SignerPayloadImpl,
    getNip46SignerSessionSnapshot: getNip46SignerSessionSnapshotImpl,
    loginWithExtension: loginWithExtensionImpl,
    loginWithRemoteSignerBunker: loginWithRemoteSignerBunkerImpl,
    logout: logoutImpl,
    savePrivateKeyHex: savePrivateKeyHexImpl,
  } = createAuthSessionRuntime({
    authenticatedRelayUrls,
    backgroundGroupContactRefreshStartedAt,
    bumpDeveloperDiagnosticsVersion,
    chatStoreClearAllComposerDrafts: chatStore.clearAllComposerDrafts,
    clearDeveloperTraceEntries,
    clearNip65RelayStoreState: nip65RelayStore.clear,
    clearPrivateMessagesBackfillState,
    clearPrivatePreferencesStorage,
    clearRelayStoreState: relayStore.clear,
    clearStoredPrivateMessagesLastReceivedCreatedAt,
    configuredRelayUrls,
    contactListVersion,
    eventSince,
    getPrivateMessagesEpochSubscriptionRefreshTimerId: () =>
      privateMessagesEpochSubscriptionRefreshTimerId,
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
    resetMuteListRuntimeState: () => {
      resetMuteListRuntimeStateRuntime();
    },
    resetOutboundMessageReplayRuntimeState: () => {
      resetOutboundMessageReplayRuntimeStateRuntime();
    },
    resetPrivateMessagesBackfillRuntimeState: () => {
      resetPrivateMessagesBackfillRuntimeStateRuntime();
    },
    resetPrivateContactListRuntimeState,
    resetReconnectHealingRuntimeState: () => {
      resetReconnectHealingRuntimeStateRuntime();
    },
    resetPrivateMessagesIngestRuntimeState,
    resetPrivateMessagesSubscriptionRuntimeState,
    resetPrivateMessagesUiRuntimeState,
    resetStartupSessionInitialization,
    resetStartupStepTracking,
    resetTrackedContactEventState,
    restoreRuntimeState,
    setCachedSigner: (signer) => {
      cachedSigner = signer;
    },
    setCachedSignerSessionKey: (sessionKey) => {
      cachedSignerSessionKey = sessionKey;
    },
    setPendingPrivateMessagesEpochSubscriptionRefreshOptions: (options) => {
      pendingPrivateMessagesEpochSubscriptionRefreshOptions = options;
    },
    setPrivateMessagesEpochSubscriptionRefreshQueue: (queue) => {
      privateMessagesEpochSubscriptionRefreshQueue = queue;
    },
    setPrivateMessagesEpochSubscriptionRefreshTimerId: (timerId) => {
      privateMessagesEpochSubscriptionRefreshTimerId = timerId;
    },
    setRestoreStartupStatePromise: (promise) => {
      restoreStartupStatePromise = promise;
    },
    setSyncLoggedInContactProfilePromise: (promise) => {
      syncLoggedInContactProfilePromise = promise;
    },
    setSyncRecentChatContactsPromise: (promise) => {
      syncRecentChatContactsPromise = promise;
    },
    stopPrivateMessagesSubscription: (reason = 'replace') => {
      stopPrivateMessagesBackfillRuntime(reason);
      stopPrivateMessagesLiveSubscription(reason);
    },
  });
  getPrivateKeyHexRuntime = getPrivateKeyHexImpl;
  loadPrivateKeyHexRuntime = loadPrivateKeyHexImpl;
  getNip46SignerPayloadRuntime = getNip46SignerPayloadImpl;
  getNip46SignerSessionSnapshotRuntime = getNip46SignerSessionSnapshotImpl;
  const {
    getNip05Data,
    resolveIdentifier,
    retryDirectMessageRelay,
    retryGroupEpochTicketRelay,
    savePrivateKey,
    savePrivateKeyFromNsec,
    sendDirectMessage,
    sendDirectMessageDeletion,
    sendDirectMessageReaction,
    validateNpub,
    validateNsec,
    validatePrivateKey,
  } = createUserActions({
    appendRelayStatusesToGroupMemberTicketEvent,
    appendRelayStatusesToMessageEvent,
    buildFailedOutboundRelayStatuses,
    buildPendingOutboundRelayStatuses,
    createDirectMessageRumorEvent,
    createEventDeletionRumorEvent,
    createReactionRumorEvent,
    createStoredDirectMessageRumorEvent,
    createStoredSignedEvent,
    ensureGroupIdentitySecretEpochState,
    ensureRelayConnections,
    getLoggedInPublicKeyHex,
    getOrCreateSigner,
    giftWrapSignedEvent,
    logMessageRelayDiagnostics,
    ndk,
    normalizeEventId,
    normalizeRelayStatusUrl,
    pendingDirectMessageRelayRetryPromises,
    publishEventWithRelayStatuses,
    readDirectMessageRecipientPubkey,
    readEpochNumberTag,
    readFirstTagValue,
    savePrivateKeyHex: savePrivateKeyHexImpl,
    sendGiftWrappedRumor,
    toIsoTimestampFromUnix,
  });
  const {
    queueOutboundMessageReplay: queueOutboundMessageReplayImpl,
    notifyRelayConnected: notifyOutboundMessageReplayRelayConnectedImpl,
    resetOutboundMessageReplayRuntimeState: resetOutboundMessageReplayRuntimeStateImpl,
    startOutboundMessageReplay: startOutboundMessageReplayImpl,
  } = createOutboundMessageReplayRuntime({
    getLoggedInPublicKeyHex,
    logMessageRelayDiagnostics,
    retryDirectMessageRelay,
  });
  queueOutboundMessageReplayRuntime = queueOutboundMessageReplayImpl;
  notifyOutboundMessageReplayRelayConnectedRuntime = notifyOutboundMessageReplayRelayConnectedImpl;
  resetOutboundMessageReplayRuntimeStateRuntime = resetOutboundMessageReplayRuntimeStateImpl;
  startOutboundMessageReplayRuntime = startOutboundMessageReplayImpl;

  const {
    notifyBrowserOnline: notifyReconnectHealingBrowserOnlineImpl,
    notifyRelayListChanged: notifyReconnectHealingRelayListChangedImpl,
    notifyVisibilityHidden: notifyReconnectHealingVisibilityHiddenImpl,
    notifyVisibilityRegain: notifyReconnectHealingVisibilityRegainImpl,
    notifyWindowBlur: notifyReconnectHealingWindowBlurImpl,
    notifyWindowFocus: notifyReconnectHealingWindowFocusImpl,
    resetReconnectHealingRuntimeState: resetReconnectHealingRuntimeStateImpl,
    runReconnectHealing: runReconnectHealingImpl,
  } = createReconnectHealingRuntime({
    getLoggedInPublicKeyHex,
    getPrivateMessagesLiveEoseAt: () => privateMessagesSubscriptionLastEoseAt.value,
    getVisibleChatTarget: () => {
      if (!chatStore.visibleChatId) {
        return null;
      }

      const chat = chatStore.chats.find((entry) => entry.id === chatStore.visibleChatId) ?? null;
      if (!chat) {
        return null;
      }

      return {
        id: chat.id,
        publicKey: chat.publicKey,
        type: chat.type,
        epochPublicKey: chat.epochPublicKey,
      };
    },
    isNativeAndroid: () => isNativeAndroidRuntime(),
    isRestoringStartupState,
    queueOutboundMessageReplay: (reason, delayMs) => {
      queueOutboundMessageReplayRuntime(reason, delayMs);
    },
    queuePrivateMessagesWatchdog: (delayMs) => {
      queuePrivateMessagesWatchdogRuntime(delayMs);
    },
    refreshDeveloperPendingQueues: () => refreshDeveloperPendingQueuesRuntime(),
    refreshDirectMessages: (options) =>
      refreshPrivateMessagesLiveSubscriptionForReconnect({
        forceRecreate: options?.forceLiveSubscriptionRecreate,
        sinceMode: options?.sinceMode,
      }),
    restartSessionSubscriptions: async (relayUrls) => {
      ensureStoredEventSince();
      await Promise.all([
        subscribeMyRelayListUpdates(relayUrls, true),
        subscribePrivateContactListUpdates(relayUrls, true),
        subscribeGroupMembershipRosterUpdatesRuntime(relayUrls, true),
        subscribeContactProfileUpdates(relayUrls, true),
        subscribeContactRelayListUpdates(relayUrls, true),
      ]);
    },
    setIsReconnectHealing: (value) => {
      isReconnectHealing.value = value;
    },
    setReconnectHealingStatusLabel: (value) => {
      reconnectHealingStatusLabel.value = value;
    },
    waitForPrivateMessagesIngestQueue: () => getPrivateMessagesIngestQueueRuntime(),
  });
  notifyReconnectHealingBrowserOnlineRuntime = notifyReconnectHealingBrowserOnlineImpl;
  notifyReconnectHealingVisibilityHiddenRuntime = notifyReconnectHealingVisibilityHiddenImpl;
  notifyReconnectHealingVisibilityRegainRuntime = notifyReconnectHealingVisibilityRegainImpl;
  notifyReconnectHealingWindowBlurRuntime = notifyReconnectHealingWindowBlurImpl;
  notifyReconnectHealingWindowFocusRuntime = notifyReconnectHealingWindowFocusImpl;
  notifyReconnectHealingRelayListChangedRuntime = notifyReconnectHealingRelayListChangedImpl;
  resetReconnectHealingRuntimeStateRuntime = resetReconnectHealingRuntimeStateImpl;
  runReconnectHealingRuntime = runReconnectHealingImpl;

  const {
    getDeveloperDiagnosticsSnapshot,
    reconnectAllDeveloperRelays,
    reconnectDeveloperRelay,
    refreshDeveloperPendingQueues,
    refreshPrivateMessages,
    restartPrivateMessagesDiagnosticsSubscription,
  } = createDeveloperDiagnosticsRuntime({
    applyPendingIncomingDeletionsForMessage,
    applyPendingIncomingReactionsForMessage,
    buildRelaySnapshot,
    bumpDeveloperDiagnosticsVersion,
    configuredRelayUrls,
    ensureRelayConnections,
    ensureStoredEventSince,
    flushPrivateMessagesUiRefreshNow,
    getAppRelayUrls,
    getFilterSince,
    getLoggedInPublicKeyHex,
    getNip46SignerSessionSnapshot: () => getNip46SignerSessionSnapshotRuntime(),
    getPrivateMessagesRestoreThrottleMs: () => privateMessagesRestoreThrottleMs,
    getPrivateMessagesSubscription,
    getPrivateMessagesSubscriptionSignature,
    getRelayConnectionState,
    getRelaySnapshots,
    getStoredAuthMethod,
    hasNip07Extension,
    isRestoringStartupState,
    listPrivateMessageRecipientPubkeys,
    ndk,
    normalizeChatGroupEpochKeys,
    normalizeEventId,
    normalizeRelayStatusUrl,
    normalizeRelayStatusUrls,
    pendingIncomingDeletions,
    pendingIncomingReactions,
    privateMessagesSubscriptionLastEoseAt,
    privateMessagesSubscriptionLastEventCreatedAt,
    privateMessagesSubscriptionLastEventId,
    privateMessagesSubscriptionLastEventSeenAt,
    privateMessagesSubscriptionLiveCoverageAt,
    privateMessagesSubscriptionRelayUrls,
    privateMessagesSubscriptionSince,
    privateMessagesSubscriptionStartedAt,
    processIncomingReactionDeletion,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    subscribePrivateMessagesForLoggedInUser: (force, options) =>
      subscribePrivateMessagesForLoggedInUserRuntime(force, options),
    toOptionalIsoTimestampFromUnix,
  });
  refreshDeveloperPendingQueuesRuntime = refreshDeveloperPendingQueues;

  return {
    clearPrivateKey: clearPrivateKeyImpl,
    createRemoteSignerNostrConnectLogin: createRemoteSignerNostrConnectLoginImpl,
    createGroupChat,
    clearDeveloperTraceEntries,
    contactListVersion,
    developerDiagnosticsEnabled,
    developerDiagnosticsVersion,
    developerTraceVersion,
    encodeNpub,
    ensureGroupInvitePubkeyIsContact,
    ensureRelayConnections,
    fetchRelayNip11Info,
    fetchMyRelayList,
    fetchGroupMembershipFollowSetPubkeys,
    fetchGroupMembershipRosterPubkeys,
    refreshContactRelayList,
    getDeveloperDiagnosticsSnapshot,
    getNip05Data,
    hasNip07Extension,
    initializeSessionState,
    getLoggedInPublicKeyHex,
    getPrivateKeyHex: getPrivateKeyHexRuntime,
    refreshDeveloperPendingQueues,
    refreshPrivateMessages,
    refreshPrivateMessagesLiveSubscriptionForReconnect,
    getRelayConnectionState,
    isRelayConnectionPending,
    isAppForeground,
    isReconnectHealing,
    runReconnectHealing: runReconnectHealingImpl,
    isRestoringStartupState,
    listDeveloperTraceEntries,
    listPrivateMessageReadRelayUrls: () => resolvePrivateMessageReadRelayUrls(),
    listPrivateMessageRecipientPubkeys,
    loginWithExtension: loginWithExtensionImpl,
    loginWithRemoteSignerBunker: loginWithRemoteSignerBunkerImpl,
    logout: logoutImpl,
    publishPrivateContactList,
    blockPubkey: (
      pubkey: string,
      seedRelayUrls?: string[],
      options?: { fallbackName?: string; type?: 'user' | 'group' }
    ) => setPubkeyBlocked(pubkey, true, seedRelayUrls, options),
    isPubkeyBlocked,
    isPubkeyMuted,
    mutePubkey: (pubkey: string, seedRelayUrls?: string[]) =>
      setPubkeyMuted(pubkey, true, seedRelayUrls),
    publishGroupRelayList,
    publishGroupMetadata,
    publishGroupMemberChanges,
    publishUserMetadata,
    publishMyRelayList,
    privateMessagesSubscriptionLastEoseAt,
    relayStatusVersion,
    reconnectHealingStatusLabel,
    resolveIdentifier,
    rotateGroupEpochAndSendTickets,
    ensureRespondedPubkeyIsContact,
    fetchContactPreviewByPublicKey,
    fetchUserProfileFromRelays,
    refreshContactByPublicKey,
    refreshPrivateContactListWithOutgoingMessages,
    refreshGroupMembershipRoster,
    restoreMuteList,
    restoreContactCursorState,
    restoreGroupIdentitySecrets,
    restoreGroupEpochHistory: restoreGroupEpochHistoryRuntime,
    restoreMyRelayList,
    restorePrivateMessagesForRecipient: restorePrivateMessagesForRecipientRuntime,
    restorePrivateContactList,
    restorePrivatePreferences,
    restoreStartupState,
    setAppLifecycleRouteChatId: (chatId: string | null) => {
      setAppLifecycleRouteChatIdRuntime(chatId);
    },
    reconnectAllDeveloperRelays,
    reconnectDeveloperRelay,
    rerunStartupStep: (stepId: StartupStepId, seedRelayUrls?: string[]) =>
      rerunStartupStep(stepId, seedRelayUrls),
    repairMissingMessageDependency: (
      chatPublicKey: string,
      targetEventId: string,
      options: RepairMissingMessageDependencyOptions
    ) => repairMissingMessageDependencyRuntime(chatPublicKey, targetEventId, options),
    restartPrivateMessagesDiagnosticsSubscription,
    retryDirectMessageRelay,
    retryGroupEpochTicketRelay,
    scheduleContactCursorPublish,
    sendGroupEpochTicket,
    sendDirectMessage,
    ensureBlossomUploadAuthentication,
    getBlossomServerUrl,
    saveBlossomServerUrl,
    signBlossomUploadAuthHeader,
    sendDirectMessageDeletion,
    sendDirectMessageReaction,
    unblockPubkey: (
      pubkey: string,
      seedRelayUrls?: string[],
      options?: { fallbackName?: string; type?: 'user' | 'group' }
    ) => setPubkeyBlocked(pubkey, false, seedRelayUrls, options),
    unmutePubkey: (pubkey: string, seedRelayUrls?: string[]) =>
      setPubkeyMuted(pubkey, false, seedRelayUrls),
    savePrivateKey,
    savePrivateKeyFromNsec,
    savePrivateKeyHex: savePrivateKeyHexImpl,
    subscribeMyRelayListUpdates,
    subscribePrivateContactListUpdates,
    subscribePrivateMessagesForLoggedInUser: subscribePrivateMessagesForLoggedInUserRuntime,
    startAppLifecycleRuntime: () => {
      startAppLifecycleRuntimeRuntime();
    },
    stopAppLifecycleRuntime: () => {
      resetAppLifecycleRuntimeStateRuntime();
    },
    updateLoggedInUserRelayList,
    setDeveloperDiagnosticsEnabled,
    syncLoggedInContactProfile,
    syncRecentChatContacts,
    startupDisplay,
    startupSteps,
    validatePrivateKey,
    validateNpub,
    validateNsec,
    waitForPrivateMessagesIngestQueue: () => getPrivateMessagesIngestQueueRuntime(),
  };
});
