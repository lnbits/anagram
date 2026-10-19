import { resolvePreferredContactRelayUrls } from '#src/utils/contactRelayUrls.ts';
import { ratchetRelayUrls } from '#src/stores/nostr/ratchetRelays.ts';
import { createRatchetIntegration } from '#src/stores/nostr/ratchetIntegration.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { getPublicProfile, rememberPublicProfile } from '#src/lib/state/publicProfiles.ts';
import { STARTER_PUBLIC_GROUP } from '#src/constants/starterPublicGroup.ts';
import { createPrivateGroupPins } from '#src/stores/nostr/privateGroupPins.ts';
import { searchRelayPublicGroups } from '#src/stores/nostr/publicGroupSearchRuntime.ts';
import type { PublicRoom } from '#src/stores/nostr/publicGroups.ts';
import { createPublicGroupRuntime } from '#src/stores/nostr/publicGroupRuntime.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { createGroupRecoveryRuntime } from './nostr/groupRecoveryRuntime.ts';
import {
  searchRelayProfiles,
  followListEntries,
  profileSearchAllowed,
  type ProfileSearchResult,
} from '#src/stores/nostr/profileSearchRuntime.ts';
import { Capacitor } from '#src/lib/platform/legacyNative.ts';
import NostrClient, {
  ClientEvent,
  NostrKind,
  NostrPrivateKeySigner,
  NostrNip46Signer,
  type NostrSigner,
  type NostrEvent,
  normalizeRelayUrl,
} from '#src/lib/nostr/client.ts';
import { createStore } from '#src/lib/state/store.svelte.ts';
import type { ChatRow } from '#src/services/chatDataService.ts';
import {
  inputSanitizerService,
  type NpubValidationResult,
  type NsecValidationResult,
  type PrivateKeyValidationResult,
} from '#src/services/inputSanitizerService.ts';
import { useCallRoomStore } from '#src/stores/callRoomStore.ts';
import { useCallStore } from '#src/stores/callStore.ts';
import { useChatStore } from '#src/stores/chatStore.svelte.ts';
import { useNip65RelayStore } from '#src/stores/nip65RelayStore.ts';
import { createAppLifecycleRuntime } from '#src/stores/nostr/appLifecycleRuntime.ts';
import { createAuthIdentityRuntime } from '#src/stores/nostr/authIdentityRuntime.ts';
import { createAuthSessionRuntime } from '#src/stores/nostr/authSessionRuntime.ts';
import { createBlossomSettingsRuntime } from '#src/stores/nostr/blossomSettingsRuntime.ts';
import { createCallSignalingRuntime } from '#src/stores/nostr/callSignalingRuntime.ts';
import {
  DEFAULT_EVENT_SINCE_LOOKBACK_SECONDS,
  DEVELOPER_DIAGNOSTICS_STORAGE_KEY,
  INITIAL_CONNECT_TIMEOUT_MS,
  LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY,
  PRIVATE_MESSAGES_EPOCH_SUBSCRIPTION_REFRESH_DEBOUNCE_MS,
  PRIVATE_MESSAGES_LIVE_RECONNECT_LOOKBACK_SECONDS,
  RELAY_CONNECT_RETRY_BASE_DELAY_MS,
  RELAY_CONNECT_RETRY_JITTER_RATIO,
  RELAY_CONNECT_RETRY_MAX_DELAY_MS,
  RELAY_FIRST_HEALTHY_WAIT_MS,
  STARTUP_STEP_MIN_PROGRESS_MS,
} from '#src/stores/nostr/constants.ts';
import { createContactProfileRuntime } from '#src/stores/nostr/contactProfileRuntime.ts';
import { createContactRelayRuntime } from '#src/stores/nostr/contactRelayRuntime.ts';
import { createContactSubscriptionsRuntime } from '#src/stores/nostr/contactSubscriptionsRuntime.ts';
import { createDeveloperDiagnosticsRuntime } from '#src/stores/nostr/developerDiagnostics.ts';
import { createDeveloperRelayRuntime } from '#src/stores/nostr/developerRelayRuntime.ts';
import {
  createDeveloperTraceRuntime,
  readDeveloperDiagnosticsEnabledFromStorage,
} from '#src/stores/nostr/developerTrace.ts';
import { createGroupEpochPublishRuntime } from '#src/stores/nostr/groupEpochPublishRuntime.ts';
import { createGroupEpochStateRuntime } from '#src/stores/nostr/groupEpochStateRuntime.ts';
import { createGroupInviteRuntime } from '#src/stores/nostr/groupInviteRuntime.ts';
import { createGroupRosterSubscriptionRuntime } from '#src/stores/nostr/groupRosterSubscriptionRuntime.ts';
import { createInboundPresentationRuntime } from '#src/stores/nostr/inboundPresentationRuntime.ts';
import { createIrohSettingsRuntime } from '#src/stores/nostr/irohSettingsRuntime.ts';
import { createMessageEventRuntime } from '#src/stores/nostr/messageEventRuntime.ts';
import { createMessageMutationRuntime } from '#src/stores/nostr/messageMutationRuntime.ts';
import { createMessageRelayRuntime } from '#src/stores/nostr/messageRelayRuntime.ts';
import { createMuteListRuntime } from '#src/stores/nostr/muteListRuntime.ts';
import { createMyRelayListRuntime } from '#src/stores/nostr/myRelayListRuntime.ts';
import { createAppClientOptions } from '#src/stores/nostr/clientOptions.ts';
import { createOutboundMessageReplayRuntime } from '#src/stores/nostr/outboundMessageReplayRuntime.ts';
import { createPrivateContactListRuntime } from '#src/stores/nostr/privateContactListRuntime.ts';
import { createPrivateContactMembershipRuntime } from '#src/stores/nostr/privateContactMembershipRuntime.ts';
import { createPrivateMessagesBackfillRuntime } from '#src/stores/nostr/privateMessagesBackfillRuntime.ts';
import { createPrivateMessagesIngestRuntime } from '#src/stores/nostr/privateMessagesIngestRuntime.ts';
import { createPrivateMessagesSubscriptionRuntime } from '#src/stores/nostr/privateMessagesSubscriptionRuntime.ts';
import { createPrivateMessagesUiRuntime } from '#src/stores/nostr/privateMessagesUiRuntime.ts';
import { createPrivateStateRuntime } from '#src/stores/nostr/privateStateRuntime.ts';
import {
  createReconnectHealingRuntime,
  type ReconnectHealingReason,
  type ReconnectHealingRunOptions,
} from '#src/stores/nostr/reconnectHealingRuntime.ts';
import { createRelayConnectionRuntime } from '#src/stores/nostr/relayConnectionRuntime.ts';
import { createRelayPublishRuntime } from '#src/stores/nostr/relayPublishRuntime.ts';
import { watchRelaySettingsSubscriptions } from '#src/stores/nostr/relaySettingsSubscriptions.ts';
import { createStartupContactSyncRuntime } from '#src/stores/nostr/startupContactSyncRuntime.ts';
import { createStartupRuntime } from '#src/stores/nostr/startupRuntime.ts';
import {
  createInitialStartupStepSnapshots,
  type StartupDisplaySnapshot,
  type StartupStepId,
  type StartupStepSnapshot,
} from '#src/stores/nostr/startupState.ts';
import { createStorageSessionRuntime } from '#src/stores/nostr/storageSession.ts';
import { createSubscriptionLoggingRuntime } from '#src/stores/nostr/subscriptionLoggingRuntime.ts';
import { createSubscriptionRefreshRuntime } from '#src/stores/nostr/subscriptionRefreshRuntime.ts';
import { createTrackedContactStateRuntime } from '#src/stores/nostr/trackedContactStateRuntime.ts';
import type {
  ContactCursorState,
  GroupIdentitySecretContent,
  Nip46SessionSnapshot,
  PendingIncomingDeletion,
  PendingIncomingReaction,
  PrivatePreferences,
  RefreshPrivateMessagesLiveSubscriptionOptions,
  RefreshPrivateMessagesLiveSubscriptionResult,
  RelayConnectRetryState,
  RelaySaveStatus,
  RepairMissingMessageDependencyOptions,
  SubscribePrivateMessagesOptions,
} from '#src/stores/nostr/types.ts';
import { createUserActions } from '#src/stores/nostr/userActions.ts';
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
} from '#src/stores/nostr/valueUtils.ts';
import { useRelayStore } from '#src/stores/relayStore.ts';
import type { ChatGroupEpochKey, MessageRelayStatus } from '#src/types/chat.ts';
import type { ContactRecord } from '#src/types/contact.ts';
import {
  buildBlossomUploadAuthorization,
  requireBlossomServerUrl,
} from '#src/utils/blossomServer.ts';

export type {
  StartupDisplaySnapshot,
  StartupInternalTaskSnapshot,
  StartupStepId,
  StartupStepSnapshot,
  StartupStepStatus,
  StartupTimedSnapshot,
  StartupTrackId,
} from '#src/stores/nostr/startupState.ts';
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
} from '#src/stores/nostr/types.ts';

export type NostrNpubValidationResult = NpubValidationResult;
export type NostrNsecValidationResult = NsecValidationResult;
export type NostrPrivateKeyValidationResult = PrivateKeyValidationResult;
export { __nostrStoreTestUtils } from '#src/stores/nostr/testUtils.ts';

export const useNostrStore = createStore('nostrStore', (onDispose) => {
  const ndk = new NostrClient(createAppClientOptions());
  const chatStore = useChatStore();
  const nip65RelayStore = useNip65RelayStore();
  const relayStore = useRelayStore();
  let relayStatusVersion = $state(0);
  let contactListVersion = $state(0);
  let isRestoringStartupState = $state(false);
  let eventSince = $state(0);
  let startupSteps = $state<StartupStepSnapshot[]>(createInitialStartupStepSnapshots());
  let startupDisplay = $state<StartupDisplaySnapshot>({
    stepId: null,
    label: null,
    status: null,
    showProgress: false,
  });
  let developerDiagnosticsEnabled = $state(
    readDeveloperDiagnosticsEnabledFromStorage(DEVELOPER_DIAGNOSTICS_STORAGE_KEY),
  );
  let developerDiagnosticsVersion = $state(0);
  let developerTraceVersion = $state(0);
  let privateMessagesSubscriptionRelayUrls = $state<string[]>([]);
  let privateMessagesSubscriptionSince = $state<number | null>(null);
  let privateMessagesSubscriptionStartedAt = $state<string | null>(null);
  let privateMessagesSubscriptionLastEventSeenAt = $state<string | null>(null);
  let privateMessagesSubscriptionLastEventId = $state<string | null>(null);
  let privateMessagesSubscriptionLastEventCreatedAt = $state<number | null>(null);
  let privateMessagesSubscriptionLastEoseAt = $state<string | null>(null);
  let privateMessagesSubscriptionLiveCoverageAt = $state<number | null>(null);
  let isAppForeground = $state(false);
  let isReconnectHealing = $state(false);
  let reconnectHealingStatusLabel = $state<string | null>(null);
  let cachedSigner: NostrSigner | null = null;
  let cachedSignerSessionKey: string | null = null;
  const configuredRelayUrls = new Set<string>();
  const relayConnectPromises = new Map<string, Promise<void>>();
  const relayConnectRetryStateByUrl = new Map<string, RelayConnectRetryState>();
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
    options?: SubscribePrivateMessagesOptions,
  ) => Promise<void> = async () => {
    throw new Error('Private messages subscription runtime is not initialized.');
  };
  let refreshPrivateMessagesLiveSubscriptionRuntime: (
    options?: RefreshPrivateMessagesLiveSubscriptionOptions,
  ) => Promise<RefreshPrivateMessagesLiveSubscriptionResult> = async () => {
    throw new Error('Private messages subscription refresh runtime is not initialized.');
  };
  let subscribeGroupMembershipRosterUpdatesRuntime: (
    seedRelayUrls?: string[],
    force?: boolean,
  ) => Promise<void> = async () => {
    throw new Error('Group roster subscription runtime is not initialized.');
  };
  let resetGroupRosterSubscriptionRuntimeState = (_reason = 'replace'): void => {};
  let resetMuteListRuntimeStateRuntime: () => void = () => {};
  let isPubkeyBlockedRuntime: (pubkey: string) => boolean = () => false;
  let _ensurePrivateMessagesWatchdogRuntime: () => void = () => {};
  let isPrivateMessagesSubscriptionRelayTrackedRuntime: (relayUrl: string) => boolean = () =>
    false;
  let markPrivateMessagesWatchdogRelayDisconnectedRuntime: (
    relayUrl: string,
  ) => void = () => {};
  let queuePrivateMessagesWatchdogRuntime: (delayMs?: number) => void = () => {};
  let queueOutboundMessageReplayRuntime: (reason: string, delayMs?: number) => void = () => {};
  let notifyOutboundMessageReplayRelayConnectedRuntime: (relayUrl: string) => void = () => {};
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
    options?: ReconnectHealingRunOptions,
  ) => Promise<void> = async () => {
    throw new Error('Reconnect healing runtime is not initialized.');
  };
  let setAppLifecycleRouteChatIdRuntime: (chatId: string | null) => void = () => {};
  let startAppLifecycleRuntimeRuntime: () => void = () => {};
  let resetOutboundMessageReplayRuntimeStateRuntime: () => void = () => {};
  let startOutboundMessageReplayRuntime: () => Promise<void> = async () => {};
  let getOrCreateSignerRuntime: () => Promise<NostrSigner> = async () => {
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
    seedRelayUrls?: string[],
  ) => void = () => {};
  let startPrivateMessagesStartupBackfillRuntime: (
    loggedInPubkeyHex: string,
    recipientPubkeys: string[],
    relayUrls: string[],
    liveSince: number,
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
    },
  ) => Promise<void> = async () => {
    throw new Error('Group epoch history runtime is not initialized.');
  };
  let restorePrivateMessagesForRecipientRuntime: (
    recipientPubkey: string,
    options?: {
      force?: boolean;
      seedRelayUrls?: string[];
    },
  ) => Promise<void> = async () => {
    throw new Error('Private messages for recipient runtime is not initialized.');
  };
  let repairMissingMessageDependencyRuntime: (
    chatPublicKey: string,
    targetEventId: string,
    options: RepairMissingMessageDependencyOptions,
  ) => Promise<boolean> = async () => {
    throw new Error('Missing message dependency repair runtime is not initialized.');
  };
  let resolveMissingMessageDependencyRepairRuntime: (targetEventId: string) => void = () => {};
  let resetPrivateMessagesBackfillRuntimeStateRuntime: () => void = () => {};
  let upsertIncomingGroupInviteRequestChatRuntime: (
    groupPublicKey: string,
    createdAt: string,
    preview?: Pick<ContactRecord, 'name' | 'meta'> | null,
  ) => Promise<void> = async () => {
    throw new Error('Group invite runtime is not initialized.');
  };
  let publishGroupIdentitySecretRuntime: (
    groupPublicKey: string,
    encryptedPrivateKey: string,
    seedRelayUrls?: string[],
  ) => Promise<RelaySaveStatus> = async () => {
    throw new Error('Private state runtime is not initialized.');
  };
  let publishGroupMembershipFollowSetRuntime: (
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls?: string[],
  ) => Promise<RelaySaveStatus> = async () => {
    throw new Error('Private state runtime is not initialized.');
  };
  let publishGroupMembershipRosterFollowSetRuntime: (
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls?: string[],
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
    event: Pick<ClientEvent, 'created_at' | 'id' | 'pubkey'>,
  ): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || isPubkeyBlockedRuntime(normalizedPubkey)) {
      return false;
    }

    return shouldApplyTrackedContactProfileEvent(event);
  }

  function shouldApplyContactRelayListEvent(
    event: Pick<ClientEvent, 'created_at' | 'id' | 'pubkey'>,
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
    get startupDisplay() {
      return startupDisplay;
    },
    set startupDisplay(value) {
      startupDisplay = value;
    },
    startupState: startupRuntimeState,
    get startupSteps() {
      return startupSteps;
    },
    set startupSteps(value) {
      startupSteps = value;
    },
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
    get developerDiagnosticsEnabled() {
      return developerDiagnosticsEnabled;
    },
    set developerDiagnosticsEnabled(value) {
      developerDiagnosticsEnabled = value;
    },
    developerDiagnosticsStorageKey: DEVELOPER_DIAGNOSTICS_STORAGE_KEY,
    get developerDiagnosticsVersion() {
      return developerDiagnosticsVersion;
    },
    set developerDiagnosticsVersion(value) {
      developerDiagnosticsVersion = value;
    },
    getLoggedInPublicKeyHex,
    developerTraceState,
    get developerTraceVersion() {
      return developerTraceVersion;
    },
    set developerTraceVersion(value) {
      developerTraceVersion = value;
    },
  });
  const {
    buildRelaySnapshot,
    getRelaySnapshots,
    logMessageRelayDiagnostics,
    logRelayLifecycle,
  } = createDeveloperRelayRuntime({
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
    getPrivateMessagesEpochSwitchSince,
    getPrivateMessagesStartupLiveSince,

    normalizeTimestamp,

    readStoredPrivateMessagesLastReceivedCreatedAt,
    readPrivatePreferencesFromStorage,

    resetEventSinceForFreshLogin,

    sha256Hex,
    toComparableTimestamp,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
    writePrivatePreferencesToStorage,
  } = createStorageSessionRuntime({
    get eventSince() {
      return eventSince;
    },
    set eventSince(value) {
      eventSince = value;
    },
    getDefaultEventSince,
    getLoggedInSignerUser,
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
    ndk,
    normalizeEventId,
    pendingEventSinceState,
  });

  onDispose(
    watchRelaySettingsSubscriptions({
      hydrate: () => {
        if (getLoggedInPublicKeyHex()) relayStore.init();
      },
      signature: () =>
        relayStore.relayEntries
          .map((entry) => `${entry.url}:${entry.read !== false}:${entry.write !== false}`)
          .sort()
          .join('|'),
      isRestoring: () => isRestoringStartupState,
      hasSessionSubscriptions: () => Boolean(getPrivateMessagesSubscription()),
      refresh: () => notifyReconnectHealingRelayListChangedRuntime(),
    }),
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

  function getPrivateMessagesReconnectSince(
    baseUnixTime = Math.floor(Date.now() / 1000),
  ): number {
    return resolvePrivateMessagesLiveReconnectSinceValue({
      liveCoverageAt: privateMessagesSubscriptionLiveCoverageAt,
      lastEventTime: readStoredPrivateMessagesLastReceivedCreatedAt(),
      initialLiveSince: getPrivateMessagesStartupLiveSince(baseUnixTime),
      lookbackSeconds: PRIVATE_MESSAGES_LIVE_RECONNECT_LOOKBACK_SECONDS,
    });
  }

  function refreshPrivateMessagesLiveSubscriptionForReconnect(
    options: { forceRecreate?: boolean; sinceMode?: 'reconnect' | 'startup' } = {},
  ): Promise<RefreshPrivateMessagesLiveSubscriptionResult> {
    return refreshPrivateMessagesLiveSubscriptionRuntime({
      forceRecreate: options.forceRecreate,
      sinceOverride:
        options.sinceMode === 'startup'
          ? getPrivateMessagesStartupLiveSince()
          : getPrivateMessagesReconnectSince(),
    });
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
    },
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
      },
    );
  }

  function logConflictingIncomingEpochNumber(
    groupPublicKey: string,
    epochNumber: number,
    epochPublicKey: string | null,
    createdAt: string | null,
    conflict: ChatGroupEpochKey,
  ): void {
    const logKey = [
      'conflicting-epoch-number',
      inputSanitizerService.normalizeHexKey(groupPublicKey) ?? groupPublicKey,
      String(epochNumber),
      inputSanitizerService.normalizeHexKey(epochPublicKey ?? '') ?? '',
      inputSanitizerService.normalizeHexKey(conflict.epoch_public_key) ??
        conflict.epoch_public_key,
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
      },
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
    preview: Pick<ContactRecord, 'name' | 'meta'> | null = null,
  ): Promise<void> {
    return upsertIncomingGroupInviteRequestChatRuntime(groupPublicKey, createdAt, preview);
  }

  function buildRelaySaveStatus(relayStatuses: MessageRelayStatus[]): RelaySaveStatus {
    const relayUrls = normalizeRelayStatusUrls(relayStatuses.map((entry) => entry.relay_url));
    const publishedRelayUrls = normalizeRelayStatusUrls(
      relayStatuses
        .filter((entry) => entry.direction === 'outbound' && entry.status === 'published')
        .map((entry) => entry.relay_url),
    );
    const failedRelayUrls = normalizeRelayStatusUrls(
      relayStatuses
        .filter((entry) => entry.direction === 'outbound' && entry.status === 'failed')
        .map((entry) => entry.relay_url),
    );
    const firstFailure = relayStatuses.find(
      (entry) =>
        entry.direction === 'outbound' && entry.status === 'failed' && entry.detail?.trim(),
    );

    return {
      relayUrls,
      publishedRelayUrls,
      failedRelayUrls,
      errorMessage: firstFailure?.detail?.trim() ?? null,
    };
  }

  function compareReplaceableEventState(
    first: Pick<ClientEvent, 'created_at' | 'id'> | null | undefined,
    second: Pick<ClientEvent, 'created_at' | 'id'> | null | undefined,
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
    options: { publishIfCreated?: boolean } = {},
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
          error,
        );
      }),
  });
  const {
    prepareOutgoingPrivateMessage,
    verifyIncomingGroupMessage,
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
    issueOwnGroupInvitation: (group, epoch) => groupRecovery.issueOwnInvitation(group, epoch),
    getLoggedInPublicKeyHex,
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
    details: Record<string, unknown> = {},
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
      isAppForeground = value;
    },
    setVisibleChatId: (chatId) => {
      const previous = chatStore.visibleChatId;
      chatStore.setVisibleChatId(chatId);
      if (chatId && chatId !== previous) {
        void chatStore
          .markAsRead(chatId)
          .then((cursor) => {
            if (cursor) scheduleContactCursorPublish(chatId, cursor);
          })
          .catch(() => {
            /* A later focus or incoming message retries the read cursor. */
          });
      }
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
    get isAppForeground() {
      return isAppForeground;
    },
    set isAppForeground(value) {
      isAppForeground = value;
    },
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
    logDeveloperTrace,
    normalizeEventId,
  });

  function bumpContactListVersion(): void {
    contactListVersion += 1;
  }

  const {
    ensureContactListedInPrivateContactList,
    reconcileAcceptedChatFromPrivateContactList,
  } = createPrivateContactMembershipRuntime({
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
    getRelayConnectionAttemptBlockReason,
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
    queueOutboundMessageReplay: (relayUrl) => {
      notifyOutboundMessageReplayRelayConnectedRuntime(relayUrl);
    },
    relayAuthFailureListenerUrls,
    relayConnectRetryBaseDelayMs: RELAY_CONNECT_RETRY_BASE_DELAY_MS,
    relayConnectRetryJitterRatio: RELAY_CONNECT_RETRY_JITTER_RATIO,
    relayConnectRetryMaxDelayMs: RELAY_CONNECT_RETRY_MAX_DELAY_MS,
    relayConnectRetryStateByUrl,
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

  async function getOrCreateSigner(): Promise<NostrSigner> {
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
    publishGroupRelayList: publishGroupRelayListImpl,
    publishReplaceableEventWithRelayStatuses,
    publishUserMetadata,
    sendGiftWrappedRumor,
  } = createRelayPublishRuntime({
    prepareOutgoingPrivateMessage,
    appendRelayStatusesToMessageEvent,
    buildRelaySaveStatus,
    decryptGroupIdentitySecretContent,
    ensureRelayConnections,
    getRelayConnectionAttemptBlockReason,
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
    queueContactProfileSubscriptionRefresh,
    queueTrackedContactSubscriptionsRefresh,
  } = createSubscriptionRefreshRuntime({
    getPendingPrivateMessagesEpochSubscriptionRefreshOptions: () =>
      pendingPrivateMessagesEpochSubscriptionRefreshOptions,
    getPrivateMessagesEpochSubscriptionRefreshQueue: () =>
      privateMessagesEpochSubscriptionRefreshQueue,
    getPrivateMessagesEpochSubscriptionRefreshTimerId: () =>
      privateMessagesEpochSubscriptionRefreshTimerId,
    normalizeRelayStatusUrls,
    isStartupRestoring: () => isRestoringStartupState,
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
    applyOwnPrivateRelayList,
    applyOwnRelayList,
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
    findGroupChatEpochContextByRecipientPubkey:
      findGroupChatEpochContextByRecipientPubkeyRuntime,
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

  const groupRecovery = createGroupRecoveryRuntime({
    ndk,
    account: getLoggedInPublicKeyHex,
    connect: (urls) => ensureRelayConnections(urls, { force: true }),
    encrypt: encryptGroupIdentitySecretContent,
    decrypt: decryptGroupIdentitySecretContent,
    saveContact: ensureGroupContactAndChat,
    persistEpoch: persistIncomingGroupEpochTicket,
    publish: publishEventWithRelayStatuses,
    publishAccountBackup: (key, ciphertext, relays) =>
      publishGroupIdentitySecretRuntime(key, ciphertext, relays),
    changed: () => {
      bumpContactListVersion();
      void chatStore.reload();
    },
    defaultRelays: getAppRelayUrls,
  });

  async function publishGroupRelayList(...args: Parameters<typeof publishGroupRelayListImpl>) {
    await groupRecovery.moveRelays(
      args[0],
      args[1].map((entry) => entry.url),
    );
    return publishGroupRelayListImpl(...args);
  }

  const { publishGroupMemberChanges, rotateGroupEpochAndSendTickets, sendGroupEpochTicket } =
    createGroupEpochPublishRuntime({
      recovery: groupRecovery,
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
      publishGroupMembershipFollowSet: (
        groupPublicKey,
        memberPublicKeys,
        seedRelayUrls = [],
      ) =>
        publishGroupMembershipFollowSetRuntime(
          groupPublicKey,
          memberPublicKeys,
          seedRelayUrls,
        ),
      publishGroupMembershipRosterFollowSet: (
        groupPublicKey,
        memberPublicKeys,
        seedRelayUrls = [],
      ) =>
        publishGroupMembershipRosterFollowSetRuntime(
          groupPublicKey,
          memberPublicKeys,
          seedRelayUrls,
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
    processIncomingRatchetMessage,
    queuePrivateMessageIngestion,
    resetPrivateMessagesIngestRuntimeState,
    resumePendingPrivateMessages,
    retryPendingEpochMessages,
    repairRestoredOutgoingChats,
  } = createPrivateMessagesIngestRuntime({
    verifyIncomingGroupMessage,
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
    processIncomingCallSignal: (peer, signal) => useCallStore().receiveSignal(peer, signal),
    processIncomingRoomSignal: (peer, signal) => useCallRoomStore().receive(peer, signal),
    processIncomingDeletionRumorEvent,
    processIncomingReactionRumorEvent,
    queueChatProfileRefresh: () => queueContactProfileSubscriptionRefresh(),
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

  async function ingestAndroidRelayNotificationEvent(input: {
    event: NostrEvent;
    ownerPubkey: string;
    relayUrl: string;
  }): Promise<boolean> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const ownerPubkey = inputSanitizerService.normalizeHexKey(input.ownerPubkey);
    const eventId = normalizeEventId(input.event.id);
    if (!loggedInPubkeyHex || ownerPubkey !== loggedInPubkeyHex) {
      return false;
    }
    if (!eventId || input.event.kind !== NostrKind.GiftWrap) {
      return true;
    }

    const wrappedEvent = new ClientEvent(ndk, {
      ...input.event,
      id: eventId,
    });
    try {
      if (!wrappedEvent.verifySignature(false)) {
        return true;
      }
    } catch {
      return true;
    }

    try {
      const relayUrl = normalizeRelayUrl(input.relayUrl);
      wrappedEvent.relay = ndk.pool.getRelay(relayUrl, false);
    } catch {}

    return queuePrivateMessageIngestion(wrappedEvent, loggedInPubkeyHex, {
      priority: 'foreground',
      uiThrottleMs: 0,
    });
  }

  const {
    ensurePrivateMessagesWatchdog: ensurePrivateMessagesWatchdogImpl,
    getPrivateMessagesSubscription,
    getLiveRecipientSince,
    getPrivateMessagesSubscriptionSignature,
    isPrivateMessagesSubscriptionRelayTracked,
    markPrivateMessagesWatchdogRelayDisconnected,
    queuePrivateMessagesWatchdog,
    refreshPrivateMessagesLiveSubscription: refreshPrivateMessagesLiveSubscriptionImpl,
    resetPrivateMessagesSubscriptionRuntimeState,
    startPrivateMessagesHistoryRestore,
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
    getPrivateMessagesIngestQueue: () => getPrivateMessagesIngestQueueRuntime(),
    getPrivateMessagesStartupLiveSince,
    getRelaySnapshots,
    getStartupStepSnapshot,
    getStoredAuthMethod,
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
    listPrivateMessageRecipientPubkeys,
    logSubscription,
    ndk,
    normalizeEventId,
    normalizeRelayStatusUrls,
    normalizeThrottleMs,
    get privateMessagesSubscriptionLastEoseAt() {
      return privateMessagesSubscriptionLastEoseAt;
    },
    set privateMessagesSubscriptionLastEoseAt(value) {
      privateMessagesSubscriptionLastEoseAt = value;
    },
    get privateMessagesSubscriptionLastEventCreatedAt() {
      return privateMessagesSubscriptionLastEventCreatedAt;
    },
    set privateMessagesSubscriptionLastEventCreatedAt(value) {
      privateMessagesSubscriptionLastEventCreatedAt = value;
    },
    get privateMessagesSubscriptionLastEventId() {
      return privateMessagesSubscriptionLastEventId;
    },
    set privateMessagesSubscriptionLastEventId(value) {
      privateMessagesSubscriptionLastEventId = value;
    },
    get privateMessagesSubscriptionLastEventSeenAt() {
      return privateMessagesSubscriptionLastEventSeenAt;
    },
    set privateMessagesSubscriptionLastEventSeenAt(value) {
      privateMessagesSubscriptionLastEventSeenAt = value;
    },
    get privateMessagesSubscriptionLiveCoverageAt() {
      return privateMessagesSubscriptionLiveCoverageAt;
    },
    set privateMessagesSubscriptionLiveCoverageAt(value) {
      privateMessagesSubscriptionLiveCoverageAt = value;
    },
    get privateMessagesSubscriptionRelayUrls() {
      return privateMessagesSubscriptionRelayUrls;
    },
    set privateMessagesSubscriptionRelayUrls(value) {
      privateMessagesSubscriptionRelayUrls = value;
    },
    get privateMessagesSubscriptionSince() {
      return privateMessagesSubscriptionSince;
    },
    set privateMessagesSubscriptionSince(value) {
      privateMessagesSubscriptionSince = value;
    },
    get privateMessagesSubscriptionStartedAt() {
      return privateMessagesSubscriptionStartedAt;
    },
    set privateMessagesSubscriptionStartedAt(value) {
      privateMessagesSubscriptionStartedAt = value;
    },
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
      liveSince,
    ) => {
      startPrivateMessagesStartupBackfillRuntime(
        loggedInPubkeyHex,
        recipientPubkeys,
        relayUrls,
        liveSince,
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
    groupHistoryState,
    loadOlderGroupHistory,
    prioritizeThreadHistory,
    restoreGroupEpochHistory: restoreGroupEpochHistoryImpl,
    restorePrivateMessagesForRecipient: restorePrivateMessagesForRecipientImpl,
    startPrivateMessagesStartupBackfill: startPrivateMessagesStartupBackfillImpl,
    stopPrivateMessagesBackfill: stopPrivateMessagesBackfillImpl,
  } = createPrivateMessagesBackfillRuntime({
    replayPendingGroupPage: async (recipients, until) => {
      const account = getLoggedInPublicKeyHex();
      if (!account) return;
      let remaining = 32;
      for (const recipient of recipients) {
        if (remaining <= 0 || account !== getLoggedInPublicKeyHex()) break;
        remaining -= await retryPendingEpochMessages(
          ndk,
          account,
          recipient,
          remaining,
          until,
        );
      }
    },
    ensureLiveRecipientSubscription: () => subscribePrivateMessagesForLoggedInUserImpl(),
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
    getPrivateMessagesIngestQueue: () => getPrivateMessagesIngestQueueRuntime(),
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
  });
  repairMissingMessageDependencyRuntime = repairMissingMessageDependencyImpl;
  resetPrivateMessagesBackfillRuntimeStateRuntime =
    resetPrivateMessagesBackfillRuntimeStateImpl;
  resolveMissingMessageDependencyRepairRuntime = resolveMissingMessageDependencyRepairImpl;
  restoreGroupEpochHistoryRuntime = restoreGroupEpochHistoryImpl;
  restorePrivateMessagesForRecipientRuntime = restorePrivateMessagesForRecipientImpl;
  startPrivateMessagesStartupBackfillRuntime = startPrivateMessagesStartupBackfillImpl;
  stopPrivateMessagesBackfillRuntime = stopPrivateMessagesBackfillImpl;

  const {
    retainVisibleProfileTarget,
    setVisibleProfileTargets,
    hasActiveContactHydration,
    resetContactSubscriptionsRuntimeState,
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
  } = createContactSubscriptionsRuntime({
    applyOwnPrivateRelayList,
    applyOwnRelayList,
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
    queueRoutingRefresh: () => queueTrackedContactSubscriptionsRefresh(),
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
    lifecycle?: Record<string, unknown>,
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
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    getStartupStepSnapshot,
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
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
    hasActiveContactHydration,
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
    createRecoverableGroup: groupRecovery.create,
    beginStartupStep,
    buildFreshPrivatePreferences,
    buildRelaySaveStatus,
    bumpContactListVersion,
    chatStore,
    chunkValues,
    compareReplaceableEventState,
    completeStartupStep,
    contactRelayListsEqual,
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
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
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

  const { getIrohRelays, getIrohRelaySettings, saveIrohRelaySettings } =
    createIrohSettingsRuntime({
      ensurePrivatePreferences,
      publishPrivatePreferences,
      readPrivatePreferencesFromStorage,
      writePrivatePreferencesToStorage,
      getOwnPubkey: getLoggedInPublicKeyHex,
    });

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
    hydrateMemberProfiles: () => subscribeContactProfileUpdates(),
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
    logStartupRestore: (phase, details) =>
      logDeveloperTrace('info', 'startup-restore', phase, details),
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
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
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
    startPrivateMessagesHistoryRestore,
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
    relayStatusVersion += 1;
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
    const authEvent = new ClientEvent(ndk, {
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
    get contactListVersion() {
      return contactListVersion;
    },
    set contactListVersion(value) {
      contactListVersion = value;
    },
    get eventSince() {
      return eventSince;
    },
    set eventSince(value) {
      eventSince = value;
    },
    getPrivateMessagesEpochSubscriptionRefreshTimerId: () =>
      privateMessagesEpochSubscriptionRefreshTimerId,
    groupContactRefreshPromises,
    hasNip07Extension,
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
    loggedInvalidGroupEpochConflictKeys,
    ndk,
    pendingContactCursorPublishStates,
    pendingContactCursorPublishTimers,
    pendingEventSinceState,
    pendingIncomingDeletions,
    pendingIncomingReactions,
    relayConnectRetryStateByUrl,
    relayConnectPromises,
    get relayStatusVersion() {
      return relayStatusVersion;
    },
    set relayStatusVersion(value) {
      relayStatusVersion = value;
    },
    resetContactSubscriptionsRuntimeState,
    resetEventSinceForFreshLogin,
    resetCalls: () => {
      useCallStore().reset();
      useCallRoomStore().reset();
    },
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
    sendDirectMessage: sendNip17DirectMessage,
    sendDirectMessageDeletion: sendNip17Deletion,
    sendDirectMessageReaction: sendNip17Reaction,
    validateNpub,
    validateNsec,
    validatePrivateKey,
  } = createUserActions({
    prepareOutgoingPrivateMessage,
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
  const ratchet = createRatchetIntegration({
    client: ndk,
    owner: getLoggedInPublicKeyHex,
    signer: getOrCreateSigner,
    relays: async (peer) => {
      const contact = peer ? await contactsService.getContactByPublicKey(peer) : null;
      return ratchetRelayUrls([...relayStore.relays, ...resolvePreferredContactRelayUrls(contact?.relays)]);
    },
    receive: processIncomingRatchetMessage,
  });
  async function sendDirectMessage(...args: Parameters<typeof sendNip17DirectMessage>) {
    const [peer, content, , options = {}] = args;
    const result = await ratchet.send(peer, {
      pubkey: getLoggedInPublicKeyHex() ?? '', kind: 14, content,
      created_at: options.createdAt ? Math.floor(Date.parse(options.createdAt) / 1000) : Math.floor(Date.now() / 1000),
      tags: [['p', peer], ...(options.replyToEventId ? [['e', options.replyToEventId, '', 'reply']] : []), ...(options.additionalTags ?? [])],
    }, { localMessageId: options.localMessageId, targetEventId: options.replyToEventId });
    return result ?? sendNip17DirectMessage(...args);
  }
  async function sendDirectMessageReaction(...args: Parameters<typeof sendNip17Reaction>) {
    const [peer, content, target, author, , options = {}] = args;
    return await ratchet.send(peer, {
      pubkey: getLoggedInPublicKeyHex() ?? '', kind: 7, content, created_at: Math.floor(Date.now() / 1000),
      tags: [['p', peer], ['e', target], ['p', author], ['k', String(options.targetKind ?? 14)]],
    }, { targetEventId: target }) ?? sendNip17Reaction(...args);
  }
  async function sendDirectMessageDeletion(...args: Parameters<typeof sendNip17Deletion>) {
    const [peer, target, kind] = args;
    return await ratchet.send(peer, {
      pubkey: getLoggedInPublicKeyHex() ?? '', kind: 5, content: '', created_at: Math.floor(Date.now() / 1000),
      tags: [['p', peer], ['e', target], ['k', String(kind)]],
    }, { targetEventId: target }) ?? sendNip17Deletion(...args);
  }

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
  notifyOutboundMessageReplayRelayConnectedRuntime =
    notifyOutboundMessageReplayRelayConnectedImpl;
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
    logReconnectHealing: (phase, details) =>
      logDeveloperTrace('info', 'reconnect-healing', phase, details),
    getLoggedInPublicKeyHex,
    getPrivateMessagesLiveEoseAt: () => privateMessagesSubscriptionLastEoseAt,
    getVisibleChatTarget: () => {
      if (!chatStore.visibleChatId) {
        return null;
      }

      const chat =
        chatStore.chats.find((entry) => entry.id === chatStore.visibleChatId) ?? null;
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
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
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
        subscribeMyRelayListUpdates(relayUrls),
        subscribePrivateContactListUpdates(relayUrls),
        subscribeGroupMembershipRosterUpdatesRuntime(relayUrls),
        subscribeContactProfileUpdates(relayUrls),
      ]);
    },
    setIsReconnectHealing: (value) => {
      isReconnectHealing = value;
    },
    setReconnectHealingStatusLabel: (value) => {
      reconnectHealingStatusLabel = value;
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
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
    listPrivateMessageRecipientPubkeys,
    ndk,
    normalizeChatGroupEpochKeys,
    normalizeEventId,
    normalizeRelayStatusUrl,
    normalizeRelayStatusUrls,
    pendingIncomingDeletions,
    pendingIncomingReactions,
    get privateMessagesSubscriptionLastEoseAt() {
      return privateMessagesSubscriptionLastEoseAt;
    },
    set privateMessagesSubscriptionLastEoseAt(value) {
      privateMessagesSubscriptionLastEoseAt = value;
    },
    get privateMessagesSubscriptionLastEventCreatedAt() {
      return privateMessagesSubscriptionLastEventCreatedAt;
    },
    set privateMessagesSubscriptionLastEventCreatedAt(value) {
      privateMessagesSubscriptionLastEventCreatedAt = value;
    },
    get privateMessagesSubscriptionLastEventId() {
      return privateMessagesSubscriptionLastEventId;
    },
    set privateMessagesSubscriptionLastEventId(value) {
      privateMessagesSubscriptionLastEventId = value;
    },
    get privateMessagesSubscriptionLastEventSeenAt() {
      return privateMessagesSubscriptionLastEventSeenAt;
    },
    set privateMessagesSubscriptionLastEventSeenAt(value) {
      privateMessagesSubscriptionLastEventSeenAt = value;
    },
    get privateMessagesSubscriptionLiveCoverageAt() {
      return privateMessagesSubscriptionLiveCoverageAt;
    },
    set privateMessagesSubscriptionLiveCoverageAt(value) {
      privateMessagesSubscriptionLiveCoverageAt = value;
    },
    get privateMessagesSubscriptionRelayUrls() {
      return privateMessagesSubscriptionRelayUrls;
    },
    set privateMessagesSubscriptionRelayUrls(value) {
      privateMessagesSubscriptionRelayUrls = value;
    },
    get privateMessagesSubscriptionSince() {
      return privateMessagesSubscriptionSince;
    },
    set privateMessagesSubscriptionSince(value) {
      privateMessagesSubscriptionSince = value;
    },
    get privateMessagesSubscriptionStartedAt() {
      return privateMessagesSubscriptionStartedAt;
    },
    set privateMessagesSubscriptionStartedAt(value) {
      privateMessagesSubscriptionStartedAt = value;
    },
    processIncomingReactionDeletion,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    startPrivateMessagesHistoryRestore,
    subscribePrivateMessagesForLoggedInUser: (force, options) =>
      subscribePrivateMessagesForLoggedInUserRuntime(force, options),
    toOptionalIsoTimestampFromUnix,
  });
  refreshDeveloperPendingQueuesRuntime = refreshDeveloperPendingQueues;

  const { sendCallSignal, sendRoomSignal } = createCallSignalingRuntime({
    ndk,
    getOwnPubkey: getLoggedInPublicKeyHex,
    isBlocked: (peer) => isPubkeyBlockedRuntime(peer),
    refreshRelays: refreshContactRelayList,
    getAppRelays: getAppRelayUrls,
    sendRumor: sendGiftWrappedRumor,
  });

  function containsSessionSecret(value: string): boolean {
    const clientKey =
      ndk.signer instanceof NostrNip46Signer ? ndk.signer.localSigner.privateKey : null;
    return [getPrivateKeyHexImpl(), clientKey].some((key) =>
      Boolean(key && value.toLowerCase().includes(key.toLowerCase())),
    );
  }

  const publicGroups = createPublicGroupRuntime({
    starterRoom: STARTER_PUBLIC_GROUP,
    client: ndk,
    account: getLoggedInPublicKeyHex,
    signer: () => getOrCreateSignerRuntime(),
    relays: async () => getAppRelayUrls(),
    containsSecret: containsSessionSecret,
    notify: (row, event) => showIncomingMessageBrowserNotification({
      chatPubkey: row.address, title: row.room.name, messageText: event.content,
      iconUrl: row.room.picture,
    }),
  });

  return {
    publicGroups,
    containsSessionSecret,
    searchPublicGroups: async (
      query: string,
      signal: AbortSignal,
      onResults: (rooms: PublicRoom[]) => void,
    ) => {
      if (!profileSearchAllowed(query) || containsSessionSecret(query))
        return 'invalid' as const;
      const owner = getLoggedInPublicKeyHex();
      const relayUrls = await resolveLoggedInReadRelayUrls();
      if (signal.aborted || owner !== getLoggedInPublicKeyHex()) return 'complete' as const;
      return searchRelayPublicGroups(ndk, query, relayUrls, {
        signal,
        onResults: (rooms) => {
          if (owner === getLoggedInPublicKeyHex()) onResults(rooms);
        },
        isBlocked: (key) => isPubkeyBlockedRuntime(key),
      });
    },
    searchProfiles: async (
      query: string,
      signal: AbortSignal,
      onResults: (results: ProfileSearchResult[]) => void,
    ) => {
      if (!profileSearchAllowed(query) || containsSessionSecret(query))
        return 'invalid' as const;
      const owner = getLoggedInPublicKeyHex();
      const relayUrls = resolveLoggedInReadRelayUrls().catch(() => []);
      const followList = owner
        ? await contactsService.getPublicFollowList(owner).catch(() => undefined)
        : undefined;
      await contactsService
        .restorePublicProfiles([...followListEntries(followList).keys()])
        .catch(() => {});
      if (signal.aborted || owner !== getLoggedInPublicKeyHex()) return 'complete' as const;
      return searchRelayProfiles(ndk, query, relayUrls, {
        signal,
        account: owner,
        followList,
        cachedProfile: getPublicProfile,
        onFollowList: (event) => {
          if (!signal.aborted && owner === getLoggedInPublicKeyHex())
            void contactsService.savePublicFollowList(event).catch(() => {});
        },
        onFollowProfile: (profile) => {
          if (signal.aborted || owner !== getLoggedInPublicKeyHex()) return;
          rememberPublicProfile(
            profile.publicKey,
            profile,
            profile.createdAt,
            profile.eventId,
          );
          const cached = getPublicProfile(profile.publicKey);
          if (cached?.eventId === profile.eventId)
            void contactsService.savePublicProfile(profile.publicKey, cached).catch(() => {});
        },
        onResults: (results) => {
          if (owner === getLoggedInPublicKeyHex()) onResults(results);
        },
        isBlocked: (key) => isPubkeyBlockedRuntime(key),
        resolveNip05: getNip05Data,
      });
    },
    sendCallSignal,
    sendRoomSignal,
    clearPrivateKey: clearPrivateKeyImpl,
    createRemoteSignerNostrConnectLogin: createRemoteSignerNostrConnectLoginImpl,
    createGroupChat,
    groupRecovery,
    clearDeveloperTraceEntries,
    get contactListVersion() {
      return contactListVersion;
    },
    set contactListVersion(value) {
      contactListVersion = value;
    },
    get developerDiagnosticsEnabled() {
      return developerDiagnosticsEnabled;
    },
    set developerDiagnosticsEnabled(value) {
      developerDiagnosticsEnabled = value;
    },
    get developerDiagnosticsVersion() {
      return developerDiagnosticsVersion;
    },
    set developerDiagnosticsVersion(value) {
      developerDiagnosticsVersion = value;
    },
    get developerTraceVersion() {
      return developerTraceVersion;
    },
    set developerTraceVersion(value) {
      developerTraceVersion = value;
    },
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
    async initializeSessionState(seedRelayUrls: string[] = []) {
      await initializeSessionState(seedRelayUrls);
      void ratchet.resume().catch(() => console.warn('Unable to resume double-ratchet messages.'));
      const account = getLoggedInPublicKeyHex();
      if (account) {
        void resumePendingPrivateMessages(ndk, account).catch(() =>
          console.warn('Unable to resume pending messages'),
        );
        void repairRestoredOutgoingChats(account).catch(() =>
          console.warn('Unable to restore conversation visibility'),
        );
      }
    },
    ingestAndroidRelayNotificationEvent,
    getLoggedInPublicKeyHex,
    getPrivateKeyHex: getPrivateKeyHexRuntime,
    refreshDeveloperPendingQueues,
    async refreshPrivateMessages() {
      const account = getLoggedInPublicKeyHex();
      if (account)
        void resumePendingPrivateMessages(ndk, account).catch(() =>
          console.warn('Unable to resume pending messages'),
        );
      await refreshPrivateMessages();
    },
    refreshPrivateMessagesLiveSubscriptionForReconnect,
    getRelayConnectionState,
    isRelayConnectionPending,
    get isAppForeground() {
      return isAppForeground;
    },
    set isAppForeground(value) {
      isAppForeground = value;
    },
    get isReconnectHealing() {
      return isReconnectHealing;
    },
    set isReconnectHealing(value) {
      isReconnectHealing = value;
    },
    runReconnectHealing: runReconnectHealingImpl,
    get isRestoringStartupState() {
      return isRestoringStartupState;
    },
    set isRestoringStartupState(value) {
      isRestoringStartupState = value;
    },
    listDeveloperTraceEntries,
    listPrivateMessageReadRelayUrls: () => resolvePrivateMessageReadRelayUrls(),
    listPrivateMessageRecipientPubkeys,
    loginWithExtension: loginWithExtensionImpl,
    loginWithRemoteSignerBunker: loginWithRemoteSignerBunkerImpl,
    async logout() {
      await ratchet.close();
      await logoutImpl();
    },
    getDirectMessageProtocol: ratchet.getDirectMessageProtocol,
    getCurrentDirectMessageProtocol: ratchet.getCurrentDirectMessageProtocol,
    readMessagingDevices: ratchet.readMessagingDevices,
    directMessageMode: ratchet.directMessageMode,
    watchDirectMessagePeer: ratchet.watchDirectMessagePeer,
    getPreferRatchet: ratchet.getPreferRatchet,
    setPreferRatchet: ratchet.setPreferRatchet,
    setDirectMessageProtocol: ratchet.setDirectMessageProtocol,
    publishPrivateContactList,
    blockPubkey: (
      pubkey: string,
      seedRelayUrls?: string[],
      options?: { fallbackName?: string; type?: 'user' | 'group' },
    ) => setPubkeyBlocked(pubkey, true, seedRelayUrls, options),
    isPubkeyBlocked,
    isPubkeyMuted,
    mutePubkey: (pubkey: string, seedRelayUrls?: string[]) =>
      setPubkeyMuted(pubkey, true, seedRelayUrls),
    publishGroupRelayList,
    publishGroupMetadata,
    privateGroupPins: createPrivateGroupPins({
      account: getLoggedInPublicKeyHex,
      publish: publishGroupMetadata,
      refresh: (group) => refreshContactByPublicKey(group),
    }),
    publishGroupMemberChanges,
    publishUserMetadata,
    publishMyRelayList,
    get privateMessagesSubscriptionLastEoseAt() {
      return privateMessagesSubscriptionLastEoseAt;
    },
    set privateMessagesSubscriptionLastEoseAt(value) {
      privateMessagesSubscriptionLastEoseAt = value;
    },
    get relayStatusVersion() {
      return relayStatusVersion;
    },
    set relayStatusVersion(value) {
      relayStatusVersion = value;
    },
    get reconnectHealingStatusLabel() {
      return reconnectHealingStatusLabel;
    },
    set reconnectHealingStatusLabel(value) {
      reconnectHealingStatusLabel = value;
    },
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
    groupHistoryState,
    loadOlderGroupHistory,
    prioritizeThreadHistory,
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
    refreshReplyPreviewsForTargetMessage,
    repairMissingMessageDependency: async (
      chatPublicKey: string,
      targetEventId: string,
      options: RepairMissingMessageDependencyOptions,
    ) => {
      const account = getLoggedInPublicKeyHex();
      const found = await repairMissingMessageDependencyRuntime(
        chatPublicKey,
        targetEventId,
        options,
      );
      // A crash can also land between target persistence and preview repair.
      if (found && account && account === getLoggedInPublicKeyHex()) {
        const target = await chatDataService.getMessageByEventIdOrEditReference(targetEventId);
        if (target?.chat_public_key === chatPublicKey && account === getLoggedInPublicKeyHex())
          await refreshReplyPreviewsForTargetMessage(target);
      }
      return found;
    },
    restartPrivateMessagesDiagnosticsSubscription,
    retryDirectMessageRelay,
    retryGroupEpochTicketRelay,
    scheduleContactCursorPublish,
    sendGroupEpochTicket,
    sendDirectMessage,
    async sendRatchetEdit(peer: string, target: string, content: string) {
      const now = Date.now();
      return ratchet.send(peer, {
        pubkey: getLoggedInPublicKeyHex() ?? '', kind: 1009, content,
        created_at: Math.floor(now / 1000),
        tags: [['p', peer], ['e', target], ['k', '14'], ['ms', String(now)]],
      }, { targetEventId: target });
    },
    ensureBlossomUploadAuthentication,
    getBlossomServerUrl,
    saveBlossomServerUrl,
    getIrohRelays,
    getIrohRelaySettings,
    saveIrohRelaySettings,
    signBlossomUploadAuthHeader,
    sendDirectMessageDeletion,
    sendDirectMessageReaction,
    unblockPubkey: (
      pubkey: string,
      seedRelayUrls?: string[],
      options?: { fallbackName?: string; type?: 'user' | 'group' },
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
    retainVisibleProfileTarget,
    setVisibleProfileTargets,
    syncRecentChatContacts,
    get startupDisplay() {
      return startupDisplay;
    },
    set startupDisplay(value) {
      startupDisplay = value;
    },
    get startupSteps() {
      return startupSteps;
    },
    set startupSteps(value) {
      startupSteps = value;
    },
    validatePrivateKey,
    validateNpub,
    validateNsec,
    waitForPrivateMessagesIngestQueue: () => getPrivateMessagesIngestQueueRuntime(),
  };
});
