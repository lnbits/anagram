import type { PrivateMessageRelayLease } from '#src/stores/nostr/privateMessageRelayClients.ts';
import { startupRelayObserver, type RelaySyncUpdate } from '#src/stores/nostr/startupRelayTracking.ts';
import { createGroupHistoryRuntime } from '#src/stores/nostr/groupHistoryRuntime.svelte.ts';
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
  minimumWindowIndex: number;
  controller: AbortController | null;
  runningPromise: Promise<boolean> | null;
  cancelled: boolean;
}

function getAggressiveMissingMessageDependencyRepairAttemptIndex(): number {
  return Math.max(0, MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1);
}

interface PrivateMessagesBackfillRuntimeDeps {
  replayPendingGroupPage?: (recipients: string[], until: number) => Promise<void>;
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
  acquirePrivateMessageRelayClient: (recipient: string) => Promise<PrivateMessageRelayLease>;
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
  replayPendingGroupPage = async () => {},
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
  acquirePrivateMessageRelayClient,
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
  const historyRelaySeeds = new Set<string>();
  const missingMessageDependencyRepairs = new Map<
    string,
    MissingMessageDependencyRepairState
  >();

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

  function mergeSeedRelayUrls(
    currentRelayUrls: string[],
    nextRelayUrls: string[] = [],
  ): string[] {
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
    existingState.controller?.abort();
    missingMessageDependencyRepairs.delete(targetEventId);
  }

  function stopPrivateMessagesBackfill(reason = 'replace'): void {
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
    timeoutMs?: number;
  }): Promise<{ eventCount: number; relayUrls: string[]; oldest: number }> {
    const [recipient] = options.recipientPubkeys;
    if (!recipient || options.recipientPubkeys.length !== 1)
      throw new Error('History reads require a single authentication identity');
    const runToken = privateMessagesBackfillRunToken;
    const lease = await acquirePrivateMessageRelayClient(recipient);
    try {
      if (runToken !== privateMessagesBackfillRunToken)
        throw new Error('History restore cancelled');
      return await readPrivateMessagesBackfillWindow(options, lease.client);
    } finally {
      lease.release();
    }
  }

  async function readPrivateMessagesBackfillWindow(
    options: Parameters<typeof runPrivateMessagesBackfillWindow>[0],
    client: NostrClient,
  ): Promise<{ eventCount: number; relayUrls: string[]; oldest: number }> {
    const runToken = privateMessagesBackfillRunToken;
    let eventCount = 0;
    let oldestEvent = Infinity;
    const cancelled = () =>
      options.signal?.aborted ||
      (!options.signal && runToken !== privateMessagesBackfillRunToken) ||
      options.loggedInPubkeyHex !== getLoggedInPublicKeyHex();
    if (cancelled()) throw new Error('History restore cancelled');
    const report: ((update: RelaySyncUpdate) => void) | undefined = options.startupTaskId
      ? startupRelayObserver(ndk, [options.startupTaskId], options.startupTaskId, options.relayUrls, { parentStepId: 'message-history-restore' })
      : undefined;
    const completedRelays: string[] = [];
    const readyRelays =
      options.requireReady === false || client !== ndk
        ? NostrRelaySet.fromRelayUrls(options.relayUrls, client, false)
        : createReadyRelaySet(ndk, options.relayUrls);
    if (!readyRelays) {
      options.relayUrls.forEach((relayUrl) => report?.({ relayUrl, status: 'error', reason: 'unavailable' }));
      throw new RelayQueryUnavailableError();
    }
    for (const relayUrl of options.relayUrls) {
      if (!readyRelays.relayUrls.includes(relayUrl)) {
        report?.({ relayUrl, status: 'error', reason: 'unavailable' });
      }
    }
    // Each relay owns a bounded cursor. A busy or unavailable relay cannot widen
    // another relay's request, and only a real EOSE plus committed ingestion counts.
    await Promise.all(
      readyRelays.relayUrls.map(async (relayUrl) => {
        const pager = options.pager ?? new HistoryPager(options.since, options.until);
        const pageLimit = () => (options.probe ? 1 : pager.limit);
        while (!pager.done) {
          if (cancelled()) throw new Error('History restore cancelled');
          const relaySet = NostrRelaySet.fromRelayUrls([relayUrl], client, false);
          const page = await new Promise<{ count: number; oldest: number }>(
            (resolve, reject) => {
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
                if (error) {
                  if (!cancelled()) report?.({ relayUrl, status: 'error', reason: error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'closed' });
                  reject(error);
                }
                else resolve({ count, oldest });
              };
              const aborted = () => finish(new Error('Thread history cancelled'));
              const deadline = setTimeout(
                () => finish(new Error('Message history relay timed out')),
                options.timeoutMs ?? 30000,
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
                    onRelayStatus: (update) => { if (update.status !== 'success' && !cancelled()) report?.(update); },
                    onEvent: (event) => {
                      if (settled || receivedEose || cancelled()) return;
                      const wrap =
                        event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
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
                        updateStartupInternalTask(
                          'message-history-restore',
                          options.startupTaskId,
                          {
                            eventCount,
                          },
                        );
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
                            !(await messageInbox.hasPending(
                              options.loggedInPubkeyHex,
                              wrap.id,
                            ))
                          )
                            throw new Error('History message has not committed');
                          if (cancelled()) throw new Error('History restore cancelled');
                          updateStoredPrivateMessagesLastReceivedFromCreatedAt(
                            wrap.created_at,
                          );
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
                      if (!receivedEose)
                        finish(new Error('Message history closed before EOSE'));
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
                if (settled || receivedEose) subscription.stop();
                else if (!options.signal) historySubscriptions.add(subscription);
              } catch (error) {
                finish(error);
              }
            },
          );
          if (cancelled()) throw new Error('History restore cancelled');
          oldestEvent = Math.min(oldestEvent, page.oldest);
          if (!options.probe) pager.advance(page.count, page.oldest);
          // The background scheduler yields and discovers new groups after every page.
          if (options.pager || options.probe) break;
        }
        report?.({ relayUrl, status: 'success' });
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
    signal?: AbortSignal;
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
    signal?: AbortSignal;
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

  function resolveInitialMissingMessageDependencyRepairWindowIndex(
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
      Math.max(state.minimumWindowIndex, state.attemptIndex),
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
      recipients: repairTarget.recipientPubkeys.map((value) =>
        formatSubscriptionLogValue(value),
      ),
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
    // A relay owns its epoch scan: a slow or failed replica must not hold up
    // older epochs on healthy replicas. Keep at most one query per relay here.
    const routesByRelay = new Map<string, string[]>();
    for (const route of repairRoutes) {
      for (const relayUrl of route.relayUrls) {
        const recipients = routesByRelay.get(relayUrl) ?? [];
        recipients.push(route.publicKey);
        routesByRelay.set(relayUrl, recipients);
      }
    }
    const controller = new AbortController();
    state.controller = controller;
    const runToken = privateMessagesBackfillRunToken;
    const cancelled = () =>
      state.cancelled ||
      controller.signal.aborted ||
      runToken !== privateMessagesBackfillRunToken ||
      loggedInPubkeyHex !== getLoggedInPublicKeyHex();
    try {
      await Promise.all(
        [...routesByRelay].map(async ([relayUrl, recipients]) => {
          for (const recipientPubkey of recipients) {
            if (cancelled()) return;
            try {
              const options = {
                loggedInPubkeyHex,
                recipientPubkey,
                relayUrls: [relayUrl],
                since,
                until,
                reprocess: true,
                signal: controller.signal,
              };
              if (repairTarget.groupPublicKey) {
                await runGroupEpochHistoryRestoreWindow({
                  ...options,
                  groupPublicKey: repairTarget.groupPublicKey,
                });
              } else {
                await runPrivateMessagesForRecipientRestoreWindow(options);
              }
            } catch (error) {
              if (cancelled()) return;
              logSubscription('private-messages', 'dependency-repair-query-error', {
                targetEventId: formatSubscriptionLogValue(state.targetEventId),
                recipientPubkey: formatSubscriptionLogValue(recipientPubkey),
                relayUrl,
                error,
              });
            }
            if (cancelled()) return;
            if (await hasStoredDependencyTarget(state.targetEventId)) {
              controller.abort();
              return;
            }
          }
        }),
      );
    } finally {
      controller.abort();
      if (state.controller === controller) state.controller = null;
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
        if (
          missingMessageDependencyRepairs.get(state.targetEventId) !== state ||
          state.cancelled
        ) {
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
        if (
          missingMessageDependencyRepairs.get(state.targetEventId) !== state ||
          state.cancelled
        ) {
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

    const chat = await chatDataService.getChatByPublicKey(normalizedChatPublicKey);
    if (chat?.type === 'group') {
      // Passive reply/reaction/pin discovery must not silently scan group archives.
      if (options.reason !== 'reply-open' || options.force !== true) return false;
      if (targetReference !== normalizedTargetEventId) {
        targetHistory.stop();
        targetReference = normalizedTargetEventId;
      }
      await targetHistory.load(
        normalizedChatPublicKey,
        options.referenceCreatedAt ?? Math.floor(Date.now() / 1000),
      );
      return hasStoredDependencyTarget(normalizedTargetEventId);
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
        attemptIndex: 0,
        minimumWindowIndex: resolveInitialMissingMessageDependencyRepairWindowIndex(options),
        controller: null,
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
      state.attemptIndex = 0;
      state.minimumWindowIndex =
        resolveInitialMissingMessageDependencyRepairWindowIndex(options);
    }

    if (state.runningPromise) {
      return state.runningPromise;
    }

    // Repeated references to the same missing message must respect backoff.
    if (state.timerId !== null && options.force !== true) return false;

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
    const recipients = resolveGroupChatEpochEntries(chat).map(
      (entry) => entry.epoch_public_key,
    );
    if (!recipients.includes(epoch)) return;
    if (owner !== getLoggedInPublicKeyHex()) return;
    groupHistory.invalidate(group);
    await ensureLiveRecipientSubscription();
    // Key discovery enables live delivery. Historical messages are requested by
    // the selected thread coordinator, never by each recovered ticket.
    void options;
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
    if (
      !normalizedPubkey ||
      relayUrls.length === 0 ||
      normalizedRecipientPubkeys.length === 0
    ) {
      completeStartupStep('message-history-restore');
      return;
    }

    const signature = `${normalizedPubkey}:${normalizedRecipientPubkeys.join(',')}:${relaySignature(relayUrls)}:${liveSince}`;
    if (privateMessagesBackfillPromise) {
      relayUrls.forEach((url) => historyRelaySeeds.add(url));
      return;
    }

    stopPrivateMessagesBackfill('replace');
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
        if (cancelled()) return [];
        // Account-inbox discovery restores chats and encrypted epoch tickets.
        // Epoch message archives belong exclusively to demand-driven thread paging.
        const recipients = [normalizedPubkey];
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
        logSubscription('private-messages', 'backfill-retry', {
          relayUrl: target.relayUrl,
          error,
        });
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
    onError: (error) =>
      logSubscription('private-messages', 'selected-thread-history-retry', { error }),
  });

  const groupHistoryDeps: Parameters<typeof createGroupHistoryRuntime>[0] = {
    owner: getLoggedInPublicKeyHex,
    context: async (chatPublicKey) => {
      const chat = await chatDataService.getChatByPublicKey(chatPublicKey);
      const owner = getLoggedInPublicKeyHex();
      if (!chat || !owner || chat.meta.deleted_locally === true) return null;
      const relays = await resolvePrivateMessageReadRelayUrls();
      return {
        routes: await resolvePrivateMessageRelayScopes(
          chat.type === 'group'
            ? resolveGroupChatEpochEntries(chat).map((entry) => entry.epoch_public_key)
            : [owner],
          relays,
        ),
        discoveryRelays: chat.type === 'group' ? relays : [],
      };
    },
    query: async (query) => queryGroupHistoryPage(query),
    onError: (error) => logSubscription('private-messages', 'group-page-retry', { error }),
  };
  async function queryGroupHistoryPage(
    {
      owner,
      recipients,
      relayUrl,
      pager,
      signal,
      discovery,
    }: Parameters<typeof groupHistoryDeps.query>[0],
    reprocess = false,
  ) {
    if (!discovery) await replayPendingGroupPage(recipients, pager.until);
    if (signal.aborted || owner !== getLoggedInPublicKeyHex())
      throw new Error('Group page cancelled');
    return runPrivateMessagesBackfillWindow({
      loggedInPubkeyHex: owner,
      recipientPubkeys: recipients,
      relayUrls: [relayUrl],
      since: pager.since,
      until: pager.until,
      pager,
      signal,
      foreground: true,
      requireReady: false,
      signature: `group-page:${owner}:${relayUrl}`,
      timeoutMs: 10000,
      reprocess,
      requestLabel: discovery ? 'group-page-keys' : 'group-page-messages',
    });
  }
  const groupHistory = createGroupHistoryRuntime(groupHistoryDeps);
  const targetHistory = createGroupHistoryRuntime({
    ...groupHistoryDeps,
    query: (query) => queryGroupHistoryPage(query, true),
  });
  let targetReference = '';
  let selectedThread: string | null = null;
  let selectionVersion = 0;
  function prioritizeThreadHistory(chatPublicKey: string | null, refresh = false): void {
    const chat = chatPublicKey ? inputSanitizerService.normalizeHexKey(chatPublicKey) : null;
    if (chat === selectedThread && !refresh) return;
    selectedThread = chat;
    const version = ++selectionVersion;
    threadHistory.stop();
    groupHistory.stop();
    targetHistory.stop();
    if (!chat) return;
    void chatDataService
      .getChatByPublicKey(chat)
      .then((row) => {
        if (version !== selectionVersion) return;
        if (row?.type === 'group') void groupHistory.load(chat);
        else threadHistory.select(chat, refresh);
      })
      .catch((error) =>
        logSubscription('private-messages', 'thread-history-error', { error }),
      );
  }
  function loadOlderPrivateHistory(chat: string, before: number): Promise<void> {
    // Give an explicit pull the foreground lane instead of competing with the
    // selected DM's automatic inbox scan. Background discovery keeps its lane.
    threadHistory.stop();
    return groupHistory.load(chat, before);
  }

  function resetPrivateMessagesBackfillRuntimeState(): void {
    selectedThread = null;
    selectionVersion++;
    groupHistory.stop();
    targetHistory.stop();
    threadHistory.stop();
    stopPrivateMessagesBackfill('reset');
    for (const state of missingMessageDependencyRepairs.values()) {
      clearMissingMessageDependencyRepairTimer(state);
      state.cancelled = true;
      state.controller?.abort();
    }
    missingMessageDependencyRepairs.clear();
  }

  return {
    get privateHistoryState() {
      return groupHistory.state;
    },
    loadOlderPrivateHistory,
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
