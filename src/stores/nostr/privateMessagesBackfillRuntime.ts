import { createThreadHistoryRuntime } from '#src/stores/nostr/threadHistoryRuntime.ts';
import { MESSAGE_HYDRATION_VERSION } from '#src/lib/nostr/hydrationVersion.ts';
import { messageInbox } from '#src/lib/nostr/inbox.ts';
import { HistoryPager } from '#src/stores/nostr/historyPager.ts';
import { hydrateTimeWindows } from '#src/stores/nostr/timeWindowHydrator.ts';
import NostrClient, {
  ClientEvent,
  type NostrFilter,
  NostrKind,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  type NostrSubscriptionOptions,
} from '#src/lib/nostr/client.ts';
import { type ChatRow, chatDataService } from '#src/services/chatDataService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
import { createHistoryCoverage } from '#src/services/nostrHistoryCoverageService.ts';
import {
  MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS,
  MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS,
  PRIVATE_MESSAGES_BACKFILL_WINDOW_SECONDS,
  PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS,
  PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
} from '#src/stores/nostr/constants.ts';
import {
  historyCoverageScope,
  uncoveredHistoryWindows,
} from '#src/stores/nostr/historyCoverage.ts';
import { resolvePrivateMessageRelayScopes } from '#src/stores/nostr/privateMessageRouting.ts';
import {
  createReadyRelaySet,
  RelayQueryUnavailableError,
} from '#src/stores/nostr/relayQueryUtils.ts';
import type { StartupStepId } from '#src/stores/nostr/startupState.ts';
import type {
  MissingMessageDependencyRepairReason,
  RepairMissingMessageDependencyOptions,
} from '#src/stores/nostr/types.ts';

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

interface PrivateMessagesBackfillRuntimeDeps {
  ensureLiveRecipientSubscription?: () => Promise<void>;
  beginStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    label: string,
    updates?: { eventCount?: number | null; label?: string },
  ) => void;
  buildFilterSinceDetails: (since: number | undefined) => Record<string, unknown>;
  buildFilterUntilDetails: (until: number | undefined) => Record<string, unknown>;
  buildPrivateMessageSubscriptionTargetDetails: (
    recipientPubkeys: string[],
    loggedInPubkeyHex: string,
  ) => Promise<Record<string, unknown>>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  completeStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    updates?: { eventCount?: number | null; label?: string },
  ) => void;
  completeStartupStep: (stepId: StartupStepId) => void;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  failStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    error: unknown,
    updates?: { eventCount?: number | null; label?: string },
  ) => void;
  failStartupStep: (stepId: StartupStepId, error: unknown) => void;
  flushPrivateMessagesUiRefreshNow: () => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getLoggedInPublicKeyHex: () => string | null;
  getPrivateMessagesIngestQueue: () => Promise<void>;
  logSubscription: (
    label: 'private-messages',
    stage: string,
    details?: Record<string, unknown>,
  ) => void;
  ndk: NostrClient;
  normalizeThrottleMs: (value: number | undefined) => number;
  queuePrivateMessageIngestion: (
    wrappedEvent: ClientEvent,
    loggedInPubkeyHex: string,
    options?: {
      uiThrottleMs?: number;
      priority?: 'foreground' | 'background';
      reprocess?: boolean;
    },
  ) => void | Promise<boolean>;
  relaySignature: (relays: string[]) => string;
  resolveGroupChatEpochEntries: (
    chat: Pick<ChatRow, 'meta' | 'type'>,
  ) => Array<{ epoch_public_key: string }>;
  resolvePrivateMessageReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  schedulePostPrivateMessagesEoseChecks: () => void;
  subscribeWithReqLogging: (
    label: string,
    requestLabel: string,
    filters: NostrFilter | NostrFilter[],
    options: NostrSubscriptionOptions & {
      onEvent?: (event: ClientEvent) => void;
      onEose?: () => void;
      onClose?: () => void;
    },
    details?: Record<string, unknown>,
  ) => ReturnType<NostrClient['subscribe']>;
  toOptionalIsoTimestampFromUnix: (value: number | null | undefined) => string | null;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
  updateStoredPrivateMessagesLastReceivedFromCreatedAt: (value: unknown) => void;
  updateStartupInternalTask: (
    parentStepId: StartupStepId,
    taskId: string,
    updates: { eventCount?: number | null; label?: string },
  ) => void;
}

export function createPrivateMessagesBackfillRuntime({
  ensureLiveRecipientSubscription = async () => {},
  beginStartupInternalTask,
  buildFilterSinceDetails,
  buildFilterUntilDetails,
  buildSubscriptionRelayDetails,
  completeStartupInternalTask,
  completeStartupStep,
  ensureRelayConnections,
  failStartupInternalTask,
  failStartupStep,
  flushPrivateMessagesUiRefreshNow,
  formatSubscriptionLogValue,
  getLoggedInPublicKeyHex,
  getPrivateMessagesIngestQueue,
  logSubscription,
  ndk,
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
}: PrivateMessagesBackfillRuntimeDeps) {
  const historySubscriptions = new Set<ReturnType<NostrClient['subscribe']>>();
  let privateMessagesBackfillPromise: Promise<void> | null = null;
  let privateMessagesBackfillRunToken = 0;
  let historyAbort: AbortController | null = null;
  const coverage = createHistoryCoverage(getLoggedInPublicKeyHex);
  const historyRecipients = new Set<string>();
  const historyRelaySeeds = new Set<string>();
  const missingMessageDependencyRepairs = new Map<string, MissingMessageDependencyRepairState>();

  function normalizeRepairDelayMs(value: number): number {
    return Math.max(0, Math.floor(value));
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
          .filter((relayUrl) => relayUrl.length > 0),
      ),
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
    loggedInPubkeyHex: string,
  ): Promise<MissingMessageDependencyRepairTarget | null> {
    await chatDataService.init();

    const chat = await chatDataService.getChatByPublicKey(chatPublicKey);
    if (chat?.meta.deleted_locally === true) return null;
    if (chat?.type === 'group') {
      const recipientPubkeys = Array.from(
        new Set(
          resolveGroupChatEpochEntries(chat)
            .map((entry) => inputSanitizerService.normalizeHexKey(entry.epoch_public_key))
            .filter((value): value is string => Boolean(value)),
        ),
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
      recipientPubkeys: [loggedInPubkeyHex],
    };
  }

  function clearMissingMessageDependencyRepairTimer(
    state: MissingMessageDependencyRepairState,
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

  function stopPrivateMessagesBackfill(reason = 'replace'): void {
    historyRecipients.clear();
    historyRelaySeeds.clear();
    historyAbort?.abort();
    historyAbort = null;
    privateMessagesBackfillRunToken += 1;

    for (const subscription of historySubscriptions) subscription.stop();
    historySubscriptions.clear();

    privateMessagesBackfillPromise = null;
  }

  async function runPrivateMessagesBackfillWindow(options: {
    loggedInPubkeyHex: string;
    recipientPubkeys: string[];
    relayUrls: string[];
    since: number;
    until: number;
    signature: string;
    startupTaskId?: string;
    requireReady?: boolean;
    requestLabel?: string;
    details?: Record<string, unknown>;
    pager?: HistoryPager;
    probe?: boolean;
    signal?: AbortSignal;
    foreground?: boolean;
    reprocess?: boolean;
  }): Promise<{ eventCount: number; relayUrls: string[]; oldest: number }> {
    const runToken = privateMessagesBackfillRunToken;
    let eventCount = 0;
    let oldestEvent = Infinity;
    const cancelled = () =>
      options.signal?.aborted ||
      runToken !== privateMessagesBackfillRunToken ||
      options.loggedInPubkeyHex !== getLoggedInPublicKeyHex();
    const completedRelays: string[] = [];
    const readyRelays =
      options.requireReady === false
        ? NostrRelaySet.fromRelayUrls(options.relayUrls, ndk, false)
        : createReadyRelaySet(ndk, options.relayUrls);
    if (!readyRelays) throw new RelayQueryUnavailableError();
    // Each relay owns a bounded cursor. A busy or unavailable relay cannot widen
    // another relay's request, and only a real EOSE plus committed ingestion counts.
    await Promise.all(
      readyRelays.relayUrls.map(async (relayUrl) => {
        const pager = options.pager ?? new HistoryPager(options.since, options.until);
        const pageLimit = () => (options.probe ? 1 : pager.limit);
        while (!pager.done) {
          if (cancelled()) throw new Error('History restore cancelled');
          const relaySet = NostrRelaySet.fromRelayUrls([relayUrl], ndk, false);
          const page = await new Promise<{ count: number; oldest: number }>((resolve, reject) => {
            let settled = false,
              receivedEose = false,
              count = 0,
              oldest = Infinity;
            let subscription: ReturnType<NostrClient['subscribe']> | undefined;
            const ingestions: Array<Promise<boolean | void>> = [];
            const finish = (error?: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(deadline);
              options.signal?.removeEventListener('abort', aborted);
              if (subscription) {
                historySubscriptions.delete(subscription);
                subscription.stop();
              }
              if (error) reject(error);
              else resolve({ count, oldest });
            };
            const aborted = () => finish(new Error('Thread history cancelled'));
            const deadline = setTimeout(
              () => finish(new Error('Message history relay timed out')),
              30000,
            );
            options.signal?.addEventListener('abort', aborted, { once: true });
            if (cancelled()) {
              aborted();
              return;
            }
            try {
              subscription = subscribeWithReqLogging(
                'private-messages',
                options.requestLabel ?? 'private-messages-backfill',
                {
                  kinds: [NostrKind.GiftWrap],
                  '#p': options.recipientPubkeys,
                  since: pager.since,
                  until: pager.until,
                  limit: pageLimit(),
                },
                {
                  relaySet,
                  cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
                  closeOnEose: true,
                  onEvent: (event) => {
                    if (settled || receivedEose || cancelled()) return;
                    const wrap = event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
                    if (
                      count >= pageLimit() ||
                      !Number.isFinite(wrap.created_at) ||
                      wrap.created_at! < pager.since ||
                      wrap.created_at! > pager.until
                    ) {
                      finish(new Error('Relay returned an invalid history page'));
                      return;
                    }
                    count++;
                    eventCount++;
                    oldest = Math.min(oldest, wrap.created_at ?? Infinity);
                    if (options.startupTaskId)
                      updateStartupInternalTask('message-history-restore', options.startupTaskId, {
                        eventCount,
                      });
                    ingestions.push(
                      Promise.resolve(
                        queuePrivateMessageIngestion(wrap, options.loggedInPubkeyHex, {
                          uiThrottleMs: options.foreground
                            ? 0
                            : PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
                          ...(options.foreground ? { priority: 'foreground' as const } : {}),
                          ...(options.reprocess ? { reprocess: true } : {}),
                        }),
                      ).then(async (accepted) => {
                        if (cancelled()) throw new Error('History restore cancelled');
                        // An undecryptable envelope must not trap paging on this
                        // window. Its ciphertext stays in the account's durable
                        // inbox for replay when keys/signer become available.
                        if (
                          accepted === false &&
                          !(await messageInbox.hasPending(options.loggedInPubkeyHex, wrap.id))
                        )
                          throw new Error('History message has not committed');
                        if (cancelled()) throw new Error('History restore cancelled');
                        updateStoredPrivateMessagesLastReceivedFromCreatedAt(wrap.created_at);
                        updateStoredEventSinceFromCreatedAt(wrap.created_at);
                        return accepted;
                      }),
                    );
                    // Attach a rejection handler immediately; EOSE still awaits the result.
                    void ingestions[ingestions.length - 1]!.catch(() => {});
                  },
                  onEose: () => {
                    receivedEose = true;
                    clearTimeout(deadline);
                    // The adapter closes after EOSE; disk work can complete afterwards.
                    if (subscription) historySubscriptions.delete(subscription);
                    void Promise.all(ingestions).then(() => finish(), finish);
                  },
                  onClose: () => {
                    if (!receivedEose) finish(new Error('Message history closed before EOSE'));
                  },
                },
                {
                  ...options.details,
                  signature: options.signature,
                  relayUrl,
                  since: pager.since,
                  until: pager.until,
                  limit: pageLimit(),
                },
              );
              if (!settled && !receivedEose) historySubscriptions.add(subscription);
              else subscription.stop();
            } catch (error) {
              finish(error);
            }
          });
          if (cancelled()) throw new Error('History restore cancelled');
          oldestEvent = Math.min(oldestEvent, page.oldest);
          if (!options.probe) pager.advance(page.count, page.oldest);
          // The background scheduler yields and discovers new groups after every page.
          if (options.pager || options.probe) break;
        }
        completedRelays.push(relayUrl);
      }),
    );
    schedulePostPrivateMessagesEoseChecks();
    flushPrivateMessagesUiRefreshNow();
    return { eventCount, relayUrls: completedRelays, oldest: oldestEvent };
  }

  async function runGroupEpochHistoryRestoreWindow(options: {
    loggedInPubkeyHex: string;
    groupPublicKey: string;
    recipientPubkey: string;
    relayUrls: string[];
    since: number;
    until?: number;
    reprocess?: boolean;
  }): Promise<void> {
    if (!options.relayUrls.length) return;
    const until = options.until ?? Math.floor(Date.now() / 1000);
    if (options.since > until) return;
    await runPrivateMessagesBackfillWindow({
      ...options,
      recipientPubkeys: [options.recipientPubkey],
      until,
      details: {
        groupPublicKey: formatSubscriptionLogValue(options.groupPublicKey),
        epochRecipientPubkey: formatSubscriptionLogValue(options.recipientPubkey),
      },
      signature: options.groupPublicKey,
      requestLabel: 'private-messages-epoch-history',
      requireReady: false,
    });
    await getPrivateMessagesIngestQueue();
  }

  async function runPrivateMessagesForRecipientRestoreWindow(options: {
    loggedInPubkeyHex: string;
    recipientPubkey: string;
    relayUrls: string[];
    since: number;
    until?: number;
    reprocess?: boolean;
  }): Promise<void> {
    if (!options.relayUrls.length) return;
    const until = options.until ?? Math.floor(Date.now() / 1000);
    if (options.since > until) return;
    await runPrivateMessagesBackfillWindow({
      ...options,
      recipientPubkeys: [options.recipientPubkey],
      until,
      signature: options.recipientPubkey,
      requestLabel: 'private-messages-recipient-restore',
      requireReady: false,
    });
    await getPrivateMessagesIngestQueue();
  }

  function buildMissingMessageDependencyRepairBounds(
    referenceCreatedAt: number | null,
    attemptIndex: number,
  ): { since: number; until: number; windowSeconds: number } {
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds =
      MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS[
        Math.min(
          attemptIndex,
          Math.max(0, MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1),
        )
      ] ?? 0;
    const until = Math.max(
      1,
      Math.min(now, normalizeRepairReferenceCreatedAt(referenceCreatedAt) ?? now),
    );
    const since = Math.max(0, until - windowSeconds);

    return {
      since,
      until,
      windowSeconds,
    };
  }

  function resolveInitialMissingMessageDependencyRepairAttemptIndex(
    options: RepairMissingMessageDependencyOptions,
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
    delayMs: number,
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
    state: MissingMessageDependencyRepairState,
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
      loggedInPubkeyHex,
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
      state.attemptIndex,
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

    const repairRoutes = await resolvePrivateMessageRelayScopes(
      repairTarget.recipientPubkeys,
      relayUrls,
    );
    for (const { publicKey: recipientPubkey, relayUrls: recipientRelayUrls } of repairRoutes) {
      if (repairTarget.groupPublicKey) {
        await runGroupEpochHistoryRestoreWindow({
          loggedInPubkeyHex,
          groupPublicKey: repairTarget.groupPublicKey,
          recipientPubkey,
          relayUrls: recipientRelayUrls,
          since,
          until,
          reprocess: true,
        });
      } else {
        await runPrivateMessagesForRecipientRestoreWindow({
          loggedInPubkeyHex,
          recipientPubkey,
          relayUrls: recipientRelayUrls,
          since,
          until,
          reprocess: true,
        });
      }

      if (await hasStoredDependencyTarget(state.targetEventId)) {
        return true;
      }
    }

    return hasStoredDependencyTarget(state.targetEventId);
  }

  async function startMissingMessageDependencyRepairAttempt(
    state: MissingMessageDependencyRepairState,
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
          error,
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
    options: RepairMissingMessageDependencyOptions,
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
        options.referenceCreatedAt,
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
        MISSING_MESSAGE_DEPENDENCY_REPAIR_RETRY_DELAYS_MS[state.attemptIndex] ?? 0,
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
    options: GroupEpochHistoryRestoreOptions = {},
  ): Promise<void> {
    const owner = getLoggedInPublicKeyHex();
    const group = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const epoch = inputSanitizerService.normalizeHexKey(epochPublicKey);
    if (!owner || !group || !epoch) return;
    const chat = await chatDataService.getChatByPublicKey(group);
    if (!chat || chat.type !== 'group' || chat.meta.deleted_locally === true) return;
    const recipients = resolveGroupChatEpochEntries(chat).map((entry) => entry.epoch_public_key);
    if (!recipients.includes(epoch)) return;
    await ensureLiveRecipientSubscription();
    const relays = await resolvePrivateMessageReadRelayUrls(options.seedRelayUrls);
    if (owner !== getLoggedInPublicKeyHex()) return;
    startPrivateMessagesStartupBackfill(owner, [owner, ...recipients], relays, 0);
  }

  async function restorePrivateMessagesForRecipient(
    recipientPubkey: string,
    options: PrivateMessagesForRecipientRestoreOptions = {},
  ): Promise<void> {
    const owner = getLoggedInPublicKeyHex();
    const recipient = inputSanitizerService.normalizeHexKey(recipientPubkey);
    if (!owner || !recipient) return;
    const relays = await resolvePrivateMessageReadRelayUrls(options.seedRelayUrls);
    if (owner !== getLoggedInPublicKeyHex()) return;
    startPrivateMessagesStartupBackfill(owner, [owner, recipient], relays, 0);
  }

  function startPrivateMessagesStartupBackfill(
    loggedInPubkeyHex: string,
    recipientPubkeys: string[],
    relayUrls: string[],
    liveSince: number,
  ): void {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(loggedInPubkeyHex);
    const normalizedRecipientPubkeys = Array.from(
      new Set(
        recipientPubkeys
          .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
          .filter((pubkey): pubkey is string => Boolean(pubkey)),
      ),
    );
    if (!normalizedPubkey || relayUrls.length === 0 || normalizedRecipientPubkeys.length === 0) {
      completeStartupStep('message-history-restore');
      return;
    }

    const signature = `${normalizedPubkey}:${normalizedRecipientPubkeys.join(',')}:${relaySignature(relayUrls)}:${liveSince}`;
    if (privateMessagesBackfillPromise) {
      normalizedRecipientPubkeys.forEach((key) => historyRecipients.add(key));
      relayUrls.forEach((url) => historyRelaySeeds.add(url));
      return;
    }

    stopPrivateMessagesBackfill('replace');
    normalizedRecipientPubkeys.forEach((key) => historyRecipients.add(key));
    relayUrls.forEach((url) => historyRelaySeeds.add(url));
    const runToken = ++privateMessagesBackfillRunToken;
    const controller = new AbortController();
    historyAbort = controller;
    const cancelled = () =>
      controller.signal.aborted ||
      runToken !== privateMessagesBackfillRunToken ||
      normalizedPubkey !== getLoggedInPublicKeyHex();
    const initialUntil = Math.floor(Date.now() / 1000);
    // Resume unfinished ranges first, then revalidate the saved coverage. EOSE
    // describes one relay snapshot, not a permanent promise that older messages
    // will never be replicated/restored there. Cached receipts avoid redecryption.
    const verifiedCoverage = createHistoryCoverage(getLoggedInPublicKeyHex, false);
    const recordCoverage = (key: string, window: { since: number; until: number }) => {
      coverage.add(key, window);
      verifiedCoverage.add(key, window);
    };
    type Target = {
      key: string;
      publicKey: string;
      relayUrl: string;
      until: number;
      revalidating?: boolean;
      window?: { since: number; until: number; pager: HistoryPager; eventCount: number };
    };
    privateMessagesBackfillPromise = hydrateTimeWindows<Target>({
      signal: controller.signal,
      concurrency: 4,
      concurrencyKey: (target) => target.relayUrl,
      cancelled,
      onDiscoveryError: (error) =>
        logSubscription('private-messages', 'backfill-discovery-retry', { error }),
      discover: async () => {
        const chats = await chatDataService.listChats();
        if (cancelled()) return [];
        const recipients = [
          ...new Set([
            ...historyRecipients,
            ...chats
              .filter((chat) => chat.type === 'group')
              .flatMap((chat) =>
                resolveGroupChatEpochEntries(chat).map((entry) => entry.epoch_public_key),
              ),
          ]),
        ];
        const routes = await resolvePrivateMessageRelayScopes(
          recipients,
          await resolvePrivateMessageReadRelayUrls([...historyRelaySeeds]),
        );
        return routes.flatMap((route) =>
          route.relayUrls.map((relayUrl) => ({
            // Do not reuse old age-limited or combined-relay completion markers.
            key: `time-v${MESSAGE_HYDRATION_VERSION}:${historyCoverageScope(route.publicKey, [relayUrl])}`,
            publicKey: route.publicKey,
            relayUrl,
            until: initialUntil,
          })),
        );
      },
      step: async (target) => {
        if (cancelled()) return true;
        let gap = uncoveredHistoryWindows(
          { since: 0, until: target.until },
          (target.revalidating ? verifiedCoverage : coverage).read(target.key),
        ).at(-1);
        if (!gap && !target.revalidating) {
          target.revalidating = true;
          target.until = initialUntil;
          target.window = undefined;
          gap = uncoveredHistoryWindows(
            { since: 0, until: target.until },
            verifiedCoverage.read(target.key),
          ).at(-1);
        }
        if (!gap) return true;
        target.window ??= (() => {
          const since = Math.max(
            gap.since,
            gap.until - PRIVATE_MESSAGES_BACKFILL_WINDOW_SECONDS + 1,
          );
          return {
            since,
            until: gap.until,
            pager: new HistoryPager(since, gap.until, true),
            eventCount: 0,
          };
        })();
        const window = target.window;
        const taskId = `history:${target.key}`;
        beginStartupInternalTask(
          'message-history-restore',
          taskId,
          formatStartupBackfillChunkLabel(window.since, window.until),
          { eventCount: window.eventCount },
        );
        await ensureRelayConnections([target.relayUrl]);
        if (cancelled()) return true;
        const query = {
          loggedInPubkeyHex: normalizedPubkey,
          recipientPubkeys: [target.publicKey],
          relayUrls: [target.relayUrl],
          signature,
          startupTaskId: taskId,
        };
        const result = await runPrivateMessagesBackfillWindow({
          ...query,
          since: window.since,
          until: window.until,
          pager: window.pager,
        });
        if (cancelled()) return true;
        window.eventCount += result.eventCount;
        if (!window.pager.done) {
          // Resume large windows after the last fully stored timestamp boundary.
          if (window.pager.until < window.until)
            recordCoverage(target.key, { since: window.pager.until + 1, until: window.until });
          return false;
        }
        // Each page's own commits have finished. Never wait for the live inbox queue.
        recordCoverage(target.key, { since: window.since, until: window.until });
        target.until = window.since - 1;
        target.window = undefined;
        if (!window.eventCount && target.until >= gap.since) {
          // One encrypted envelope locates the next occupied period across sparse
          // history. An empty recent week alone never proves history is exhausted.
          const olderUntil = target.until;
          const probe = await runPrivateMessagesBackfillWindow({
            ...query,
            since: gap.since,
            until: olderUntil,
            probe: true,
          });
          if (cancelled()) return true;
          if (!probe.eventCount) {
            recordCoverage(target.key, { since: gap.since, until: olderUntil });
            target.until = gap.since - 1;
          } else {
            if (probe.oldest < olderUntil)
              recordCoverage(target.key, { since: probe.oldest + 1, until: olderUntil });
            target.until = probe.oldest;
          }
        }
        completeStartupInternalTask('message-history-restore', taskId, {
          eventCount: window.eventCount,
        });
        // One final step checks whether saved ranges still need revalidation.
        return target.revalidating === true && target.until < 0;
      },
      onError: (target, error) => {
        failStartupInternalTask('message-history-restore', `history:${target.key}`, error);
        logSubscription('private-messages', 'backfill-retry', { relayUrl: target.relayUrl, error });
      },
    })
      .then(() => {
        if (!cancelled()) completeStartupStep('message-history-restore');
      })
      .catch((error) => {
        if (!cancelled()) failStartupStep('message-history-restore', error);
      })
      .finally(() => {
        if (runToken !== privateMessagesBackfillRunToken) return;
        historyAbort = null;
        privateMessagesBackfillPromise = null;
      });
  }

  const threadHistory = createThreadHistoryRuntime({
    owner: getLoggedInPublicKeyHex,
    context: async (chatPublicKey) => {
      const owner = getLoggedInPublicKeyHex();
      if (!owner) return { routes: [], timestamps: [] };
      await chatDataService.init();
      const [chat, batch, relays] = await Promise.all([
        chatDataService.getChatByPublicKey(chatPublicKey),
        chatDataService.listLatestMessages(chatPublicKey, 100),
        resolvePrivateMessageReadRelayUrls(),
      ]);
      if (chat?.meta.deleted_locally === true) return { routes: [], timestamps: [] };
      if (chat?.type === 'group') await ensureLiveRecipientSubscription();
      const recipients =
        chat?.type === 'group'
          ? resolveGroupChatEpochEntries(chat).map((entry) => entry.epoch_public_key)
          : [owner];
      return {
        routes: await resolvePrivateMessageRelayScopes(recipients, relays),
        timestamps: batch.rows.map((row) => Math.floor(Date.parse(row.created_at) / 1000)),
      };
    },
    query: async ({ owner, publicKey, relayUrl, signal, ...window }) => {
      if (signal.aborted || owner !== getLoggedInPublicKeyHex())
        throw new Error('Thread history cancelled');
      return runPrivateMessagesBackfillWindow({
        ...window,
        signal,
        foreground: true,
        requireReady: false,
        loggedInPubkeyHex: owner,
        recipientPubkeys: [publicKey],
        relayUrls: [relayUrl],
        signature: `thread:${publicKey}:${relayUrl}`,
        requestLabel: 'selected-thread-history',
      });
    },
    onError: () => logSubscription('private-messages', 'selected-thread-history-retry'),
  });

  function prioritizeThreadHistory(chatPublicKey: string | null, refresh = false): void {
    threadHistory.select(
      chatPublicKey ? inputSanitizerService.normalizeHexKey(chatPublicKey) : null,
      refresh,
    );
  }

  function resetPrivateMessagesBackfillRuntimeState(): void {
    threadHistory.stop();
    stopPrivateMessagesBackfill('reset');
    for (const state of missingMessageDependencyRepairs.values()) {
      clearMissingMessageDependencyRepairTimer(state);
      state.cancelled = true;
    }
    missingMessageDependencyRepairs.clear();
  }

  return {
    prioritizeThreadHistory,
    repairMissingMessageDependency,
    resetPrivateMessagesBackfillRuntimeState,
    resolveMissingMessageDependencyRepair,
    restoreGroupEpochHistory,
    restorePrivateMessagesForRecipient,
    startPrivateMessagesStartupBackfill,
    stopPrivateMessagesBackfill,
  };
}
