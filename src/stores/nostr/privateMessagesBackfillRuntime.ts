import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKKind,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKSubscriptionOptions,
} from '@nostr-dev-kit/ndk';
import { type ChatRow, chatDataService } from 'src/services/chatDataService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import {
  MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS,
  MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS,
  PRIVATE_MESSAGES_BACKFILL_DELAY_STEP_MS,
  PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
  PRIVATE_MESSAGES_BACKFILL_WINDOW_SECONDS,
  PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS,
  PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
} from 'src/stores/nostr/constants';
import type { StartupStepId } from 'src/stores/nostr/startupState';
import type {
  MissingMessageDependencyRepairReason,
  PrivateMessagesBackfillState,
  RepairMissingMessageDependencyOptions,
} from 'src/stores/nostr/types';

interface GroupEpochHistoryRestoreOptions {
  force?: boolean;
  seedRelayUrls?: string[];
}

interface PrivateMessagesForRecipientRestoreOptions {
  force?: boolean;
  seedRelayUrls?: string[];
}

interface MissingMessageDependencyRepairTarget {
  groupPublicKey: string | null;
  recipientPubkeys: string[];
}

interface MissingMessageDependencyRepairState {
  chatPublicKey: string;
  targetEventId: string;
  referenceCreatedAt: number | null;
  reason: MissingMessageDependencyRepairReason;
  scheduledAt: number | null;
  seedRelayUrls: string[];
  timerId: ReturnType<typeof globalThis.setTimeout> | null;
  attemptIndex: number;
  runningPromise: Promise<boolean> | null;
  cancelled: boolean;
}

function getAggressiveMissingMessageDependencyRepairAttemptIndex(): number {
  return Math.max(0, MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1);
}

function toUnixTimestampFromIso(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const unixTimestamp = Math.floor(parsed / 1000);
  return unixTimestamp > 0 ? unixTimestamp : null;
}

interface PrivateMessagesBackfillRuntimeDeps {
  beginStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    label: string,
    updates?: { eventCount?: number | null; label?: string }
  ) => void;
  buildFilterSinceDetails: (since: number | undefined) => Record<string, unknown>;
  buildFilterUntilDetails: (until: number | undefined) => Record<string, unknown>;
  buildPrivateMessageSubscriptionTargetDetails: (
    recipientPubkeys: string[],
    loggedInPubkeyHex: string
  ) => Promise<Record<string, unknown>>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  completeStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    updates?: { eventCount?: number | null; label?: string }
  ) => void;
  completeStartupStep: (stepId: StartupStepId) => void;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  failStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    error: unknown,
    updates?: { eventCount?: number | null; label?: string }
  ) => void;
  failStartupStep: (stepId: StartupStepId, error: unknown) => void;
  flushPrivateMessagesUiRefreshNow: () => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getLoggedInPublicKeyHex: () => string | null;
  getPrivateMessagesBackfillResumeState: (
    pubkeyHex: string,
    liveSince: number,
    floorSince: number
  ) => PrivateMessagesBackfillState | null;
  getPrivateMessagesIngestQueue: () => Promise<void>;
  getPrivateMessagesStartupFloorSince: (baseUnixTime?: number) => number;
  logSubscription: (
    label: 'private-messages',
    stage: string,
    details?: Record<string, unknown>
  ) => void;
  ndk: NDK;
  normalizeThrottleMs: (value: number | undefined) => number;
  queuePrivateMessageIngestion: (
    wrappedEvent: NDKEvent,
    loggedInPubkeyHex: string,
    options?: {
      uiThrottleMs?: number;
    }
  ) => void;
  relaySignature: (relays: string[]) => string;
  resolveGroupChatEpochEntries: (
    chat: Pick<ChatRow, 'meta' | 'type'>
  ) => Array<{ epoch_public_key: string }>;
  resolvePrivateMessageReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  schedulePostPrivateMessagesEoseChecks: () => void;
  subscribeWithReqLogging: (
    label: string,
    requestLabel: string,
    filters: NDKFilter | NDKFilter[],
    options: NDKSubscriptionOptions & {
      onEvent?: (event: NDKEvent) => void;
      onEose?: () => void;
      onClose?: () => void;
    },
    details?: Record<string, unknown>
  ) => ReturnType<NDK['subscribe']>;
  toOptionalIsoTimestampFromUnix: (value: number | null | undefined) => string | null;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
  updateStoredPrivateMessagesLastReceivedFromCreatedAt: (value: unknown) => void;
  updateStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    updates: { eventCount?: number | null; label?: string }
  ) => void;
  writePrivateMessagesBackfillState: (state: PrivateMessagesBackfillState) => void;
}

export function createPrivateMessagesBackfillRuntime({
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
  getPrivateMessagesIngestQueue,
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
}: PrivateMessagesBackfillRuntimeDeps) {
  let privateMessagesBackfillSubscription: ReturnType<NDK['subscribe']> | null = null;
  let privateMessagesBackfillPromise: Promise<void> | null = null;
  let privateMessagesBackfillRunToken = 0;
  let privateMessagesBackfillSignature = '';
  let privateMessagesBackfillDelayTimerId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let privateMessagesBackfillDelayResolver: (() => void) | null = null;
  const groupEpochHistoryRestorePromises = new Map<string, Promise<void>>();
  const restoredGroupEpochHistoryKeys = new Set<string>();
  const privateMessagesForRecipientRestorePromises = new Map<string, Promise<void>>();
  const restoredPrivateMessagesForRecipientKeys = new Set<string>();
  const missingMessageDependencyRepairs = new Map<string, MissingMessageDependencyRepairState>();

  function normalizeRepairDelayMs(value: number): number {
    return Math.max(0, Math.floor(value));
  }

  function buildStartupBackfillChunkTaskId(since: number, until: number): string {
    return `private-message-backfill:${Math.max(0, Math.floor(since))}:${Math.max(0, Math.floor(until))}`;
  }

  function formatStartupBackfillChunkLabel(since: number, until: number): string {
    const sinceIso = toOptionalIsoTimestampFromUnix(since) ?? String(since);
    const untilIso = toOptionalIsoTimestampFromUnix(until) ?? String(until);
    return `Backfill ${sinceIso} -> ${untilIso}`;
  }

  function normalizeRepairReferenceCreatedAt(value: number | null | undefined): number | null {
    if (!Number.isFinite(value)) {
      return null;
    }

    const normalizedValue = Math.floor(Number(value));
    return normalizedValue > 0 ? normalizedValue : null;
  }

  function mergeSeedRelayUrls(currentRelayUrls: string[], nextRelayUrls: string[] = []): string[] {
    return Array.from(
      new Set(
        [...currentRelayUrls, ...nextRelayUrls]
          .map((relayUrl) => relayUrl.trim())
          .filter((relayUrl) => relayUrl.length > 0)
      )
    );
  }

  async function hasStoredDependencyTarget(targetEventId: string): Promise<boolean> {
    await Promise.all([chatDataService.init(), nostrEventDataService.init()]);

    if (await chatDataService.getMessageByEventIdOrEditReference(targetEventId)) {
      return true;
    }

    return Boolean(await nostrEventDataService.getEventById(targetEventId));
  }

  async function resolveMissingMessageDependencyRepairTarget(
    chatPublicKey: string,
    loggedInPubkeyHex: string
  ): Promise<MissingMessageDependencyRepairTarget | null> {
    await chatDataService.init();

    const chat = await chatDataService.getChatByPublicKey(chatPublicKey);
    if (chat?.type === 'group') {
      const recipientPubkeys = Array.from(
        new Set(
          resolveGroupChatEpochEntries(chat)
            .map((entry) => inputSanitizerService.normalizeHexKey(entry.epoch_public_key))
            .filter((value): value is string => Boolean(value))
        )
      );
      if (recipientPubkeys.length === 0) {
        return null;
      }

      return {
        groupPublicKey: chatPublicKey,
        recipientPubkeys,
      };
    }

    return {
      groupPublicKey: null,
      recipientPubkeys: Array.from(new Set([loggedInPubkeyHex, chatPublicKey])),
    };
  }

  function clearMissingMessageDependencyRepairTimer(
    state: MissingMessageDependencyRepairState
  ): void {
    if (state.timerId !== null) {
      globalThis.clearTimeout(state.timerId);
      state.timerId = null;
    }

    state.scheduledAt = null;
  }

  function deleteMissingMessageDependencyRepairState(targetEventId: string): void {
    const existingState = missingMessageDependencyRepairs.get(targetEventId);
    if (!existingState) {
      return;
    }

    clearMissingMessageDependencyRepairTimer(existingState);
    existingState.cancelled = true;
    missingMessageDependencyRepairs.delete(targetEventId);
  }

  function clearPrivateMessagesBackfillDelay(): void {
    if (privateMessagesBackfillDelayTimerId !== null) {
      globalThis.clearTimeout(privateMessagesBackfillDelayTimerId);
      privateMessagesBackfillDelayTimerId = null;
    }

    if (privateMessagesBackfillDelayResolver) {
      const resolver = privateMessagesBackfillDelayResolver;
      privateMessagesBackfillDelayResolver = null;
      resolver();
    }
  }

  function stopPrivateMessagesBackfill(reason = 'replace'): void {
    privateMessagesBackfillRunToken += 1;
    clearPrivateMessagesBackfillDelay();

    if (privateMessagesBackfillSubscription) {
      logSubscription('private-messages', 'backfill-stop', {
        reason,
        signature: privateMessagesBackfillSignature || null,
      });
      privateMessagesBackfillSubscription.stop();
      privateMessagesBackfillSubscription = null;
    }

    privateMessagesBackfillPromise = null;
    privateMessagesBackfillSignature = '';
  }

  async function waitForPrivateMessagesBackfillDelay(
    delayMs: number,
    runToken: number
  ): Promise<boolean> {
    const normalizedDelayMs = normalizeThrottleMs(delayMs);
    if (normalizedDelayMs <= 0) {
      return runToken === privateMessagesBackfillRunToken;
    }

    await new Promise<void>((resolve) => {
      privateMessagesBackfillDelayResolver = () => {
        privateMessagesBackfillDelayResolver = null;
        resolve();
      };
      privateMessagesBackfillDelayTimerId = globalThis.setTimeout(() => {
        privateMessagesBackfillDelayTimerId = null;
        const resolver = privateMessagesBackfillDelayResolver;
        privateMessagesBackfillDelayResolver = null;
        resolver?.();
      }, normalizedDelayMs);
    });

    return runToken === privateMessagesBackfillRunToken;
  }

  async function runPrivateMessagesBackfillWindow(options: {
    loggedInPubkeyHex: string;
    recipientPubkeys: string[];
    relayUrls: string[];
    since: number;
    until: number;
    signature: string;
    startupTaskId: string;
  }): Promise<number> {
    const privateMessageTargetDetails = await buildPrivateMessageSubscriptionTargetDetails(
      options.recipientPubkeys,
      options.loggedInPubkeyHex
    );

    return new Promise<number>((resolve, reject) => {
      let didFinish = false;
      let eventCount = 0;
      let subscription: ReturnType<NDK['subscribe']> | null = null;

      const finish = (error?: unknown) => {
        if (didFinish) {
          return;
        }

        didFinish = true;
        if (subscription && privateMessagesBackfillSubscription === subscription) {
          privateMessagesBackfillSubscription = null;
        }

        if (error) {
          reject(error);
          return;
        }

        resolve(eventCount);
      };

      try {
        const relaySet = NDKRelaySet.fromRelayUrls(options.relayUrls, ndk, false);
        logSubscription('private-messages', 'backfill-window-subscribe', {
          signature: options.signature,
          ...buildFilterSinceDetails(options.since),
          ...buildFilterUntilDetails(options.until),
          ...buildSubscriptionRelayDetails(options.relayUrls),
          recipientCount: options.recipientPubkeys.length,
          recipients: options.recipientPubkeys.map((value) => formatSubscriptionLogValue(value)),
          ...privateMessageTargetDetails,
        });
        const privateMessagesBackfillFilters: NDKFilter = {
          kinds: [NDKKind.GiftWrap],
          '#p': options.recipientPubkeys,
          since: options.since,
          until: options.until,
        };
        subscription = subscribeWithReqLogging(
          'private-messages',
          'private-messages-backfill',
          privateMessagesBackfillFilters,
          {
            relaySet,
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
            closeOnEose: true,
            onEvent: (event) => {
              const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
              eventCount += 1;
              updateStartupInternalTask('private-messages-subscribe', options.startupTaskId, {
                eventCount,
              });
              updateStoredPrivateMessagesLastReceivedFromCreatedAt(wrappedEvent.created_at);
              updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
              queuePrivateMessageIngestion(wrappedEvent, options.loggedInPubkeyHex, {
                uiThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
              });
            },
            onEose: () => {
              logSubscription('private-messages', 'backfill-eose', {
                signature: options.signature,
                eventCount,
                ...buildFilterSinceDetails(options.since),
                ...buildFilterUntilDetails(options.until),
              });
              schedulePostPrivateMessagesEoseChecks();
              flushPrivateMessagesUiRefreshNow();
              finish();
            },
            onClose: () => {
              finish();
            },
          },
          {
            signature: options.signature,
            ...buildFilterSinceDetails(options.since),
            ...buildFilterUntilDetails(options.until),
            ...buildSubscriptionRelayDetails(options.relayUrls),
          }
        );

        privateMessagesBackfillSubscription = subscription;
      } catch (error) {
        reject(error);
      }
    });
  }

  async function runGroupEpochHistoryRestoreWindow(options: {
    loggedInPubkeyHex: string;
    groupPublicKey: string;
    recipientPubkey: string;
    relayUrls: string[];
    since: number;
    until?: number;
  }): Promise<void> {
    const normalizedUntil = Number.isInteger(options.until) ? Number(options.until) : undefined;
    if (
      options.relayUrls.length === 0 ||
      (normalizedUntil !== undefined && options.since >= normalizedUntil)
    ) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let didFinish = false;
      let subscription: ReturnType<NDK['subscribe']> | null = null;

      const finish = (error?: unknown) => {
        if (didFinish) {
          return;
        }

        didFinish = true;
        if (subscription) {
          subscription.stop();
          subscription = null;
        }

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      try {
        const relaySet = NDKRelaySet.fromRelayUrls(options.relayUrls, ndk, false);
        logSubscription('private-messages', 'epoch-history-subscribe', {
          subscriptionTargetType: 'epoch',
          groupChatPubkeys: [formatSubscriptionLogValue(options.groupPublicKey)],
          epochRecipientCount: 1,
          epochRecipients: [
            {
              groupChatPubkey:
                formatSubscriptionLogValue(options.groupPublicKey) ?? options.groupPublicKey,
              epochRecipientPubkey:
                formatSubscriptionLogValue(options.recipientPubkey) ?? options.recipientPubkey,
            },
          ],
          ...buildFilterSinceDetails(options.since),
          ...buildFilterUntilDetails(normalizedUntil),
          ...buildSubscriptionRelayDetails(options.relayUrls),
        });
        const groupEpochHistoryFilters: NDKFilter = {
          kinds: [NDKKind.GiftWrap],
          '#p': [options.recipientPubkey],
          since: options.since,
          ...(normalizedUntil !== undefined ? { until: normalizedUntil } : {}),
        };
        subscription = subscribeWithReqLogging(
          'private-messages',
          'private-messages-epoch-history',
          groupEpochHistoryFilters,
          {
            relaySet,
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
            closeOnEose: true,
            onEvent: (event) => {
              const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
              updateStoredPrivateMessagesLastReceivedFromCreatedAt(wrappedEvent.created_at);
              updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
              queuePrivateMessageIngestion(wrappedEvent, options.loggedInPubkeyHex, {
                uiThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
              });
            },
            onEose: () => {
              schedulePostPrivateMessagesEoseChecks();
              flushPrivateMessagesUiRefreshNow();
              finish();
            },
            onClose: () => {
              finish();
            },
          },
          {
            groupPublicKey: formatSubscriptionLogValue(options.groupPublicKey),
            epochRecipientPubkey: formatSubscriptionLogValue(options.recipientPubkey),
            ...buildFilterSinceDetails(options.since),
            ...buildFilterUntilDetails(normalizedUntil),
            ...buildSubscriptionRelayDetails(options.relayUrls),
          }
        );
      } catch (error) {
        reject(error);
      }
    });

    await getPrivateMessagesIngestQueue();
  }

  async function runPrivateMessagesForRecipientRestoreWindow(options: {
    loggedInPubkeyHex: string;
    recipientPubkey: string;
    relayUrls: string[];
    since: number;
    until?: number;
  }): Promise<void> {
    const normalizedUntil = Number.isInteger(options.until) ? Number(options.until) : undefined;
    if (
      options.relayUrls.length === 0 ||
      (normalizedUntil !== undefined && options.since >= normalizedUntil)
    ) {
      return;
    }

    const privateMessageTargetDetails = await buildPrivateMessageSubscriptionTargetDetails(
      [options.recipientPubkey],
      options.loggedInPubkeyHex
    );

    await new Promise<void>((resolve, reject) => {
      let didFinish = false;
      let subscription: ReturnType<NDK['subscribe']> | null = null;

      const finish = (error?: unknown) => {
        if (didFinish) {
          return;
        }

        didFinish = true;
        if (subscription) {
          subscription.stop();
          subscription = null;
        }

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      try {
        const relaySet = NDKRelaySet.fromRelayUrls(options.relayUrls, ndk, false);
        logSubscription('private-messages', 'private-message-recipient-subscribe', {
          recipientPubkey: formatSubscriptionLogValue(options.recipientPubkey),
          recipientCount: 1,
          recipients: [formatSubscriptionLogValue(options.recipientPubkey)],
          ...buildFilterSinceDetails(options.since),
          ...buildFilterUntilDetails(normalizedUntil),
          ...buildSubscriptionRelayDetails(options.relayUrls),
          ...privateMessageTargetDetails,
        });
        const privateMessagesForRecipientRestoreFilters: NDKFilter = {
          kinds: [NDKKind.GiftWrap],
          '#p': [options.recipientPubkey],
          since: options.since,
          ...(normalizedUntil !== undefined ? { until: normalizedUntil } : {}),
        };
        subscription = subscribeWithReqLogging(
          'private-messages',
          'private-messages-recipient-restore',
          privateMessagesForRecipientRestoreFilters,
          {
            relaySet,
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
            closeOnEose: true,
            onEvent: (event) => {
              const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
              updateStoredPrivateMessagesLastReceivedFromCreatedAt(wrappedEvent.created_at);
              updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
              queuePrivateMessageIngestion(wrappedEvent, options.loggedInPubkeyHex, {
                uiThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
              });
            },
            onEose: () => {
              logSubscription('private-messages', 'private-messages-recipient-eose', {
                recipientPubkey: formatSubscriptionLogValue(options.recipientPubkey),
                ...buildFilterSinceDetails(options.since),
                ...buildFilterUntilDetails(normalizedUntil),
              });
              schedulePostPrivateMessagesEoseChecks();
              flushPrivateMessagesUiRefreshNow();
              finish();
            },
            onClose: () => {
              finish();
            },
          },
          {
            recipientPubkey: formatSubscriptionLogValue(options.recipientPubkey),
            ...buildFilterSinceDetails(options.since),
            ...buildFilterUntilDetails(normalizedUntil),
            ...buildSubscriptionRelayDetails(options.relayUrls),
          }
        );
      } catch (error) {
        reject(error);
      }
    });

    await getPrivateMessagesIngestQueue();
  }

  function buildMissingMessageDependencyRepairBounds(
    referenceCreatedAt: number | null,
    attemptIndex: number
  ): { since: number; until: number; windowSeconds: number } {
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds =
      MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS[
        Math.min(
          attemptIndex,
          Math.max(0, MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1)
        )
      ] ?? 0;
    const until = Math.max(
      1,
      Math.min(now, normalizeRepairReferenceCreatedAt(referenceCreatedAt) ?? now)
    );
    const since = Math.max(0, until - windowSeconds);

    return {
      since,
      until,
      windowSeconds,
    };
  }

  function resolveInitialMissingMessageDependencyRepairAttemptIndex(
    options: RepairMissingMessageDependencyOptions
  ): number {
    if (options.reason === 'reply-target-missing') {
      return getAggressiveMissingMessageDependencyRepairAttemptIndex();
    }

    if (options.reason === 'reply-open' && options.force === true) {
      return getAggressiveMissingMessageDependencyRepairAttemptIndex();
    }

    return 0;
  }

  function scheduleMissingMessageDependencyRepair(
    state: MissingMessageDependencyRepairState,
    delayMs: number
  ): void {
    if (state.cancelled) {
      return;
    }

    const normalizedDelayMs = normalizeRepairDelayMs(delayMs);
    const nextScheduledAt = Date.now() + normalizedDelayMs;
    if (
      state.timerId !== null &&
      state.scheduledAt !== null &&
      state.scheduledAt <= nextScheduledAt
    ) {
      return;
    }

    clearMissingMessageDependencyRepairTimer(state);
    state.scheduledAt = nextScheduledAt;
    state.timerId = globalThis.setTimeout(() => {
      state.timerId = null;
      state.scheduledAt = null;
      void startMissingMessageDependencyRepairAttempt(state);
    }, normalizedDelayMs);
  }

  async function runMissingMessageDependencyRepairAttempt(
    state: MissingMessageDependencyRepairState
  ): Promise<boolean> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      logSubscription('private-messages', 'dependency-repair-skip', {
        targetEventId: formatSubscriptionLogValue(state.targetEventId),
        chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
        reason: 'missing-logged-in-pubkey',
        repairReason: state.reason,
        attemptIndex: state.attemptIndex,
      });
      return false;
    }

    if (await hasStoredDependencyTarget(state.targetEventId)) {
      logSubscription('private-messages', 'dependency-repair-skip', {
        targetEventId: formatSubscriptionLogValue(state.targetEventId),
        chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
        reason: 'target-already-present',
        repairReason: state.reason,
        attemptIndex: state.attemptIndex,
      });
      return true;
    }

    const relayUrls = await resolvePrivateMessageReadRelayUrls(state.seedRelayUrls);
    if (relayUrls.length === 0) {
      logSubscription('private-messages', 'dependency-repair-skip', {
        targetEventId: formatSubscriptionLogValue(state.targetEventId),
        chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
        reason: 'no-read-relays',
        repairReason: state.reason,
        attemptIndex: state.attemptIndex,
      });
      return false;
    }

    const repairTarget = await resolveMissingMessageDependencyRepairTarget(
      state.chatPublicKey,
      loggedInPubkeyHex
    );
    if (!repairTarget || repairTarget.recipientPubkeys.length === 0) {
      logSubscription('private-messages', 'dependency-repair-skip', {
        targetEventId: formatSubscriptionLogValue(state.targetEventId),
        chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
        reason: 'no-repair-recipients',
        repairReason: state.reason,
        attemptIndex: state.attemptIndex,
      });
      return false;
    }

    const { since, until, windowSeconds } = buildMissingMessageDependencyRepairBounds(
      state.referenceCreatedAt,
      state.attemptIndex
    );
    if (since >= until) {
      logSubscription('private-messages', 'dependency-repair-skip', {
        targetEventId: formatSubscriptionLogValue(state.targetEventId),
        chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
        reason: 'invalid-window',
        repairReason: state.reason,
        attemptIndex: state.attemptIndex,
        ...buildFilterSinceDetails(since),
        ...buildFilterUntilDetails(until),
      });
      return false;
    }

    await ensureRelayConnections(relayUrls);
    logSubscription('private-messages', 'dependency-repair-attempt', {
      targetEventId: formatSubscriptionLogValue(state.targetEventId),
      chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
      repairReason: state.reason,
      attemptIndex: state.attemptIndex,
      recipientCount: repairTarget.recipientPubkeys.length,
      recipients: repairTarget.recipientPubkeys.map((value) => formatSubscriptionLogValue(value)),
      groupPublicKey: formatSubscriptionLogValue(repairTarget.groupPublicKey),
      windowSeconds,
      ...buildFilterSinceDetails(since),
      ...buildFilterUntilDetails(until),
      ...buildSubscriptionRelayDetails(relayUrls),
    });

    for (const recipientPubkey of repairTarget.recipientPubkeys) {
      if (repairTarget.groupPublicKey) {
        await runGroupEpochHistoryRestoreWindow({
          loggedInPubkeyHex,
          groupPublicKey: repairTarget.groupPublicKey,
          recipientPubkey,
          relayUrls,
          since,
          until,
        });
      } else {
        await runPrivateMessagesForRecipientRestoreWindow({
          loggedInPubkeyHex,
          recipientPubkey,
          relayUrls,
          since,
          until,
        });
      }

      if (await hasStoredDependencyTarget(state.targetEventId)) {
        return true;
      }
    }

    return hasStoredDependencyTarget(state.targetEventId);
  }

  async function startMissingMessageDependencyRepairAttempt(
    state: MissingMessageDependencyRepairState
  ): Promise<boolean> {
    if (state.cancelled) {
      return false;
    }

    if (state.runningPromise) {
      return state.runningPromise;
    }

    clearMissingMessageDependencyRepairTimer(state);
    logSubscription('private-messages', 'dependency-repair-start', {
      targetEventId: formatSubscriptionLogValue(state.targetEventId),
      chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
      repairReason: state.reason,
      attemptIndex: state.attemptIndex,
      referenceCreatedAt: state.referenceCreatedAt,
      referenceCreatedAtIso: toOptionalIsoTimestampFromUnix(state.referenceCreatedAt),
    });

    const currentAttemptPromise = (async () => {
      try {
        const found = await runMissingMessageDependencyRepairAttempt(state);
        if (missingMessageDependencyRepairs.get(state.targetEventId) !== state || state.cancelled) {
          return found;
        }

        if (found) {
          logSubscription('private-messages', 'dependency-repair-found', {
            targetEventId: formatSubscriptionLogValue(state.targetEventId),
            chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
            repairReason: state.reason,
            attemptIndex: state.attemptIndex,
          });
          deleteMissingMessageDependencyRepairState(state.targetEventId);
          return true;
        }

        const nextAttemptIndex = state.attemptIndex + 1;
        if (nextAttemptIndex >= MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS.length) {
          logSubscription('private-messages', 'dependency-repair-complete', {
            targetEventId: formatSubscriptionLogValue(state.targetEventId),
            chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
            repairReason: state.reason,
            attemptIndex: state.attemptIndex,
            resolved: false,
          });
          deleteMissingMessageDependencyRepairState(state.targetEventId);
          return false;
        }

        state.attemptIndex = nextAttemptIndex;
        const nextDelayMs =
          MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS[nextAttemptIndex] ?? 0;
        logSubscription('private-messages', 'dependency-repair-retry-scheduled', {
          targetEventId: formatSubscriptionLogValue(state.targetEventId),
          chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
          repairReason: state.reason,
          attemptIndex: nextAttemptIndex,
          delayMs: nextDelayMs,
        });
        scheduleMissingMessageDependencyRepair(state, nextDelayMs);
        return false;
      } catch (error) {
        console.warn(
          'Failed to repair missing message dependency',
          state.chatPublicKey,
          state.targetEventId,
          error
        );
        if (missingMessageDependencyRepairs.get(state.targetEventId) !== state || state.cancelled) {
          return false;
        }

        const nextAttemptIndex = state.attemptIndex + 1;
        if (nextAttemptIndex >= MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS.length) {
          logSubscription('private-messages', 'dependency-repair-error', {
            targetEventId: formatSubscriptionLogValue(state.targetEventId),
            chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
            repairReason: state.reason,
            attemptIndex: state.attemptIndex,
            error,
          });
          deleteMissingMessageDependencyRepairState(state.targetEventId);
          return false;
        }

        state.attemptIndex = nextAttemptIndex;
        const nextDelayMs =
          MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS[nextAttemptIndex] ?? 0;
        logSubscription('private-messages', 'dependency-repair-retry-scheduled', {
          targetEventId: formatSubscriptionLogValue(state.targetEventId),
          chatPubkey: formatSubscriptionLogValue(state.chatPublicKey),
          repairReason: state.reason,
          attemptIndex: nextAttemptIndex,
          delayMs: nextDelayMs,
          retryAfterError: true,
        });
        scheduleMissingMessageDependencyRepair(state, nextDelayMs);
        return false;
      } finally {
        if (state.runningPromise === currentAttemptPromise) {
          state.runningPromise = null;
        }
      }
    })();

    state.runningPromise = currentAttemptPromise;
    return currentAttemptPromise;
  }

  async function repairMissingMessageDependency(
    chatPublicKey: string,
    targetEventId: string,
    options: RepairMissingMessageDependencyOptions
  ): Promise<boolean> {
    const normalizedChatPublicKey = inputSanitizerService.normalizeHexKey(chatPublicKey);
    const normalizedTargetEventId = inputSanitizerService.normalizeHexKey(targetEventId);
    if (!normalizedChatPublicKey || !normalizedTargetEventId) {
      return false;
    }

    if (await hasStoredDependencyTarget(normalizedTargetEventId)) {
      return true;
    }

    let state = missingMessageDependencyRepairs.get(normalizedTargetEventId) ?? null;
    if (!state) {
      state = {
        chatPublicKey: normalizedChatPublicKey,
        targetEventId: normalizedTargetEventId,
        referenceCreatedAt: normalizeRepairReferenceCreatedAt(options.referenceCreatedAt),
        reason: options.reason,
        scheduledAt: null,
        seedRelayUrls: mergeSeedRelayUrls([], options.seedRelayUrls),
        timerId: null,
        attemptIndex: resolveInitialMissingMessageDependencyRepairAttemptIndex(options),
        runningPromise: null,
        cancelled: false,
      };
      missingMessageDependencyRepairs.set(normalizedTargetEventId, state);
    } else {
      state.chatPublicKey = normalizedChatPublicKey;
      state.reason = options.reason;
      state.seedRelayUrls = mergeSeedRelayUrls(state.seedRelayUrls, options.seedRelayUrls);
      const normalizedReferenceCreatedAt = normalizeRepairReferenceCreatedAt(
        options.referenceCreatedAt
      );
      if (
        normalizedReferenceCreatedAt !== null &&
        (state.referenceCreatedAt === null ||
          normalizedReferenceCreatedAt < state.referenceCreatedAt)
      ) {
        state.referenceCreatedAt = normalizedReferenceCreatedAt;
      }
      state.cancelled = false;
    }

    logSubscription('private-messages', 'dependency-repair-queued', {
      targetEventId: formatSubscriptionLogValue(normalizedTargetEventId),
      chatPubkey: formatSubscriptionLogValue(normalizedChatPublicKey),
      repairReason: options.reason,
      immediate: options.immediate !== false,
      force: options.force === true,
      attemptIndex: state.attemptIndex,
      referenceCreatedAt: state.referenceCreatedAt,
      referenceCreatedAtIso: toOptionalIsoTimestampFromUnix(state.referenceCreatedAt),
    });

    if (options.force === true && state.runningPromise === null) {
      state.attemptIndex = resolveInitialMissingMessageDependencyRepairAttemptIndex(options);
    }

    if (state.runningPromise) {
      return state.runningPromise;
    }

    if (options.immediate === false) {
      scheduleMissingMessageDependencyRepair(
        state,
        MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS[state.attemptIndex] ?? 0
      );
      return false;
    }

    return startMissingMessageDependencyRepairAttempt(state);
  }

  function resolveMissingMessageDependencyRepair(targetEventId: string): void {
    const normalizedTargetEventId = inputSanitizerService.normalizeHexKey(targetEventId);
    if (!normalizedTargetEventId) {
      return;
    }

    logSubscription('private-messages', 'dependency-repair-resolved', {
      targetEventId: formatSubscriptionLogValue(normalizedTargetEventId),
    });
    deleteMissingMessageDependencyRepairState(normalizedTargetEventId);
  }

  async function restoreGroupEpochHistory(
    groupPublicKey: string,
    epochPublicKey: string,
    options: GroupEpochHistoryRestoreOptions = {}
  ): Promise<void> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedEpochPublicKey = inputSanitizerService.normalizeHexKey(epochPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!normalizedGroupPublicKey || !normalizedEpochPublicKey || !loggedInPubkeyHex) {
      return;
    }

    await chatDataService.init();
    const groupChat = await chatDataService.getChatByPublicKey(normalizedGroupPublicKey);
    if (!groupChat || groupChat.type !== 'group') {
      return;
    }

    let epochPublicKeys = Array.from(
      new Set(
        resolveGroupChatEpochEntries(groupChat)
          .map((entry) => inputSanitizerService.normalizeHexKey(entry.epoch_public_key))
          .filter((value): value is string => Boolean(value))
      )
    );
    if (!epochPublicKeys.includes(normalizedEpochPublicKey)) {
      return;
    }

    const relayUrls = await resolvePrivateMessageReadRelayUrls(options.seedRelayUrls);
    if (relayUrls.length === 0) {
      return;
    }

    await ensureRelayConnections(relayUrls);
    const now = Math.floor(Date.now() / 1000);
    const widestRepairWindowSeconds =
      MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS[
        MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1
      ] ?? PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS;
    let since = Math.max(0, now - widestRepairWindowSeconds);
    if (!options.force) {
      const latestMessages = await chatDataService.listLatestMessages(normalizedGroupPublicKey, 1);
      const latestMessageTime =
        toUnixTimestampFromIso(latestMessages.rows[0]?.created_at) ??
        toUnixTimestampFromIso(groupChat.last_message_at);
      since =
        latestMessageTime !== null
          ? Math.max(0, latestMessageTime - PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS)
          : getPrivateMessagesStartupFloorSince(now);
    }

    const handledEpochPublicKeys = new Set<string>();

    while (epochPublicKeys.length > 0) {
      await Promise.all(
        epochPublicKeys.map((epochPublicKeyToRestore) => {
          handledEpochPublicKeys.add(epochPublicKeyToRestore);
          const restoreKey = `${normalizedGroupPublicKey}:${epochPublicKeyToRestore}`;
          if (!options.force && restoredGroupEpochHistoryKeys.has(restoreKey)) {
            return Promise.resolve();
          }

          const existingRestore = groupEpochHistoryRestorePromises.get(restoreKey);
          if (existingRestore) {
            return existingRestore;
          }

          const restorePromise = runGroupEpochHistoryRestoreWindow({
            loggedInPubkeyHex,
            groupPublicKey: normalizedGroupPublicKey,
            recipientPubkey: epochPublicKeyToRestore,
            relayUrls,
            since,
            until: now,
          })
            .then(() => {
              restoredGroupEpochHistoryKeys.add(restoreKey);
            })
            .catch((error) => {
              console.warn(
                'Failed to restore group epoch history',
                normalizedGroupPublicKey,
                epochPublicKeyToRestore,
                error
              );
            })
            .finally(() => {
              groupEpochHistoryRestorePromises.delete(restoreKey);
            });

          groupEpochHistoryRestorePromises.set(restoreKey, restorePromise);
          return restorePromise;
        })
      );

      const latestGroupChat = await chatDataService.getChatByPublicKey(normalizedGroupPublicKey);
      if (!latestGroupChat || latestGroupChat.type !== 'group') {
        return;
      }

      epochPublicKeys = Array.from(
        new Set(
          resolveGroupChatEpochEntries(latestGroupChat)
            .map((entry) => inputSanitizerService.normalizeHexKey(entry.epoch_public_key))
            .filter((value): value is string => Boolean(value))
        )
      ).filter((epochPublicKeyToRestore) => !handledEpochPublicKeys.has(epochPublicKeyToRestore));
    }
  }

  async function restorePrivateMessagesForRecipient(
    recipientPubkey: string,
    options: PrivateMessagesForRecipientRestoreOptions = {}
  ): Promise<void> {
    const normalizedRecipientPubkey = inputSanitizerService.normalizeHexKey(recipientPubkey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!normalizedRecipientPubkey || !loggedInPubkeyHex) {
      return;
    }

    const restoreKey = `${loggedInPubkeyHex}:${normalizedRecipientPubkey}`;
    if (!options.force && restoredPrivateMessagesForRecipientKeys.has(restoreKey)) {
      return;
    }

    const existingRestore = privateMessagesForRecipientRestorePromises.get(restoreKey);
    if (existingRestore) {
      return existingRestore;
    }

    const restorePromise = (async () => {
      const relayUrls = await resolvePrivateMessageReadRelayUrls(options.seedRelayUrls);
      if (relayUrls.length === 0) {
        return;
      }

      await ensureRelayConnections(relayUrls);
      const now = Math.floor(Date.now() / 1000);
      await runPrivateMessagesForRecipientRestoreWindow({
        loggedInPubkeyHex,
        recipientPubkey: normalizedRecipientPubkey,
        relayUrls,
        since: getPrivateMessagesStartupFloorSince(now),
        until: now,
      });
      restoredPrivateMessagesForRecipientKeys.add(restoreKey);
    })()
      .catch((error) => {
        console.warn(
          'Failed to restore private messages for recipient',
          normalizedRecipientPubkey,
          error
        );
      })
      .finally(() => {
        privateMessagesForRecipientRestorePromises.delete(restoreKey);
      });

    privateMessagesForRecipientRestorePromises.set(restoreKey, restorePromise);
    return restorePromise;
  }

  function startPrivateMessagesStartupBackfill(
    loggedInPubkeyHex: string,
    recipientPubkeys: string[],
    relayUrls: string[],
    liveSince: number
  ): void {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(loggedInPubkeyHex);
    const normalizedRecipientPubkeys = Array.from(
      new Set(
        recipientPubkeys
          .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
          .filter((pubkey): pubkey is string => Boolean(pubkey))
      )
    );
    if (!normalizedPubkey || relayUrls.length === 0 || normalizedRecipientPubkeys.length === 0) {
      completeStartupStep('private-messages-subscribe');
      return;
    }

    const signature = `${normalizedPubkey}:${normalizedRecipientPubkeys.join(',')}:${relaySignature(relayUrls)}:${liveSince}`;
    if (privateMessagesBackfillPromise && privateMessagesBackfillSignature === signature) {
      return;
    }

    stopPrivateMessagesBackfill('replace');
    privateMessagesBackfillSignature = signature;
    const runToken = ++privateMessagesBackfillRunToken;
    privateMessagesBackfillPromise = (async () => {
      const floorSince = getPrivateMessagesStartupFloorSince();
      let state = getPrivateMessagesBackfillResumeState(normalizedPubkey, liveSince, floorSince);

      if (!state) {
        logSubscription('private-messages', 'backfill-skip', {
          signature,
          reason: 'no-pending-window',
          ...buildFilterSinceDetails(liveSince),
          floorSince,
          floorSinceIso: toOptionalIsoTimestampFromUnix(floorSince),
        });
        completeStartupStep('private-messages-subscribe');
        return;
      }

      logSubscription('private-messages', 'backfill-start', {
        signature,
        ...buildFilterSinceDetails(state.nextSince),
        ...buildFilterUntilDetails(state.nextUntil),
        floorSince: state.floorSince,
        floorSinceIso: toOptionalIsoTimestampFromUnix(state.floorSince),
        delayMs: state.delayMs,
      });

      while (runToken === privateMessagesBackfillRunToken) {
        if (state.nextSince >= state.nextUntil || state.nextUntil <= state.floorSince) {
          writePrivateMessagesBackfillState({
            ...state,
            completed: true,
          });
          logSubscription('private-messages', 'backfill-complete', {
            signature,
            ...buildFilterSinceDetails(state.nextSince),
            ...buildFilterUntilDetails(state.nextUntil),
            floorSince: state.floorSince,
            floorSinceIso: toOptionalIsoTimestampFromUnix(state.floorSince),
          });
          completeStartupStep('private-messages-subscribe');
          return;
        }

        writePrivateMessagesBackfillState(state);
        const startupTaskId = buildStartupBackfillChunkTaskId(state.nextSince, state.nextUntil);
        const startupTaskLabel = formatStartupBackfillChunkLabel(state.nextSince, state.nextUntil);
        beginStartupInternalTask('private-messages-subscribe', startupTaskId, startupTaskLabel, {
          eventCount: 0,
        });
        logSubscription('private-messages', 'backfill-window-start', {
          signature,
          ...buildFilterSinceDetails(state.nextSince),
          ...buildFilterUntilDetails(state.nextUntil),
          delayMs: state.delayMs,
        });

        try {
          const eventCount = await runPrivateMessagesBackfillWindow({
            loggedInPubkeyHex: normalizedPubkey,
            recipientPubkeys: normalizedRecipientPubkeys,
            relayUrls,
            since: state.nextSince,
            until: state.nextUntil,
            signature,
            startupTaskId,
          });
          completeStartupInternalTask('private-messages-subscribe', startupTaskId, {
            eventCount,
          });
        } catch (error) {
          failStartupInternalTask('private-messages-subscribe', startupTaskId, error);
          throw error;
        }

        if (runToken !== privateMessagesBackfillRunToken) {
          return;
        }

        const reachedFloor = state.nextSince <= state.floorSince;
        if (reachedFloor) {
          writePrivateMessagesBackfillState({
            ...state,
            completed: true,
          });
          logSubscription('private-messages', 'backfill-complete', {
            signature,
            ...buildFilterSinceDetails(state.nextSince),
            ...buildFilterUntilDetails(state.nextUntil),
            floorSince: state.floorSince,
            floorSinceIso: toOptionalIsoTimestampFromUnix(state.floorSince),
          });
          completeStartupStep('private-messages-subscribe');
          return;
        }

        const waitDelayMs = state.delayMs;
        const nextUntil = state.nextSince;
        const nextSince = Math.max(
          state.floorSince,
          nextUntil - PRIVATE_MESSAGES_BACKFILL_WINDOW_SECONDS
        );
        state = {
          ...state,
          nextSince,
          nextUntil,
          delayMs: Math.min(
            PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
            state.delayMs + PRIVATE_MESSAGES_BACKFILL_DELAY_STEP_MS
          ),
          completed: false,
        };
        writePrivateMessagesBackfillState(state);

        logSubscription('private-messages', 'backfill-wait', {
          signature,
          delayMs: waitDelayMs,
          nextSince,
          nextSinceIso: toOptionalIsoTimestampFromUnix(nextSince),
          nextUntil,
          nextUntilIso: toOptionalIsoTimestampFromUnix(nextUntil),
        });

        const shouldContinue = await waitForPrivateMessagesBackfillDelay(waitDelayMs, runToken);
        if (!shouldContinue) {
          return;
        }
      }
    })()
      .catch((error) => {
        console.error('Failed to backfill private messages', error);
        logSubscription('private-messages', 'backfill-error', {
          signature,
          error,
        });
        failStartupStep('private-messages-subscribe', error);
      })
      .finally(() => {
        if (runToken !== privateMessagesBackfillRunToken) {
          return;
        }

        clearPrivateMessagesBackfillDelay();
        privateMessagesBackfillSubscription = null;
        privateMessagesBackfillPromise = null;
        privateMessagesBackfillSignature = '';
      });
  }

  function resetPrivateMessagesBackfillRuntimeState(): void {
    stopPrivateMessagesBackfill('reset');
    for (const state of missingMessageDependencyRepairs.values()) {
      clearMissingMessageDependencyRepairTimer(state);
      state.cancelled = true;
    }
    missingMessageDependencyRepairs.clear();
    groupEpochHistoryRestorePromises.clear();
    restoredGroupEpochHistoryKeys.clear();
    privateMessagesForRecipientRestorePromises.clear();
    restoredPrivateMessagesForRecipientKeys.clear();
  }

  return {
    repairMissingMessageDependency,
    resetPrivateMessagesBackfillRuntimeState,
    resolveMissingMessageDependencyRepair,
    restoreGroupEpochHistory,
    restorePrivateMessagesForRecipient,
    startPrivateMessagesStartupBackfill,
    stopPrivateMessagesBackfill,
  };
}
