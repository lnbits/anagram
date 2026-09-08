import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKKind,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKSubscriptionOptions,
  normalizeRelayUrl,
} from '@nostr-dev-kit/ndk';
import {
  PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
  PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS,
  PRIVATE_MESSAGES_WATCHDOG_RECOVERY_COOLDOWN_MS,
} from 'src/stores/nostr/constants';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from 'src/stores/nostr/desiredSubscriptions';
import { resolvePrivateMessageRelayScopes } from 'src/stores/nostr/privateMessageRouting';
import type {
  RefreshPrivateMessagesLiveSubscriptionOptions,
  RefreshPrivateMessagesLiveSubscriptionResult,
  SubscribePrivateMessagesOptions,
} from 'src/stores/nostr/types';
import type { Ref } from 'vue';

type MessageStartupTrackId = 'private-message-events' | 'message-history-restore';

interface MessageHistoryRestoreContext {
  loggedInPubkeyHex: string;
  recipientPubkeys: string[];
  relayUrls: string[];
  liveSince: number;
  ready: boolean;
  preparing: boolean;
}

interface PrivateMessagesSubscriptionRuntimeDeps {
  beginStartupStep: (stepId: MessageStartupTrackId) => void;
  buildFilterSinceDetails: (since: number | undefined) => Record<string, unknown>;
  buildPrivateMessageSubscriptionTargetDetails: (
    recipientPubkeys: string[],
    loggedInPubkeyHex: string
  ) => Promise<Record<string, unknown>>;
  buildSubscriptionEventDetails: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  bumpDeveloperDiagnosticsVersion: () => void;
  clearPrivateMessagesUiRefreshState: () => void;
  completeStartupStep: (stepId: MessageStartupTrackId) => void;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: NDKEvent) => string[];
  failStartupStep: (stepId: MessageStartupTrackId, error: unknown) => void;
  flushPrivateMessagesUiRefreshNow: () => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getOrCreateSigner: () => Promise<unknown>;
  getPrivateMessagesIngestQueue: () => Promise<void>;
  getPrivateMessagesRestoreThrottleMs: () => number;
  getPrivateMessagesStartupLiveSince: () => number;
  getRelaySnapshots: (relayUrls: string[]) => unknown[];
  getStartupStepSnapshot: (stepId: MessageStartupTrackId) => { status: string };
  getStoredAuthMethod: () => string | null;
  isRestoringStartupState: Ref<boolean>;
  listPrivateMessageRecipientPubkeys: () => Promise<string[]>;
  logSubscription: (
    label: 'private-messages',
    stage: string,
    details?: Record<string, unknown>
  ) => void;
  ndk: NDK;
  normalizeEventId: (value: unknown) => string | null;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  normalizeThrottleMs: (value: number | undefined) => number;
  privateMessagesSubscriptionLastEoseAt: Ref<string | null>;
  privateMessagesSubscriptionLastEventCreatedAt: Ref<number | null>;
  privateMessagesSubscriptionLastEventId: Ref<string | null>;
  privateMessagesSubscriptionLastEventSeenAt: Ref<string | null>;
  privateMessagesSubscriptionLiveCoverageAt: Ref<number | null>;
  privateMessagesSubscriptionRelayUrls: Ref<string[]>;
  privateMessagesSubscriptionSince: Ref<number | null>;
  privateMessagesSubscriptionStartedAt: Ref<string | null>;
  queuePrivateMessageIngestion: (wrappedEvent: NDKEvent, loggedInPubkeyHex: string) => void;
  refreshAllStoredContacts: () => Promise<unknown>;
  relaySignature: (relays: string[]) => string;
  resolvePrivateMessageReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  schedulePostPrivateMessagesEoseChecks: () => void;
  setPrivateMessagesRestoreThrottleMs: (value: number) => void;
  startPrivateMessagesStartupBackfill: (
    loggedInPubkeyHex: string,
    recipientPubkeys: string[],
    relayUrls: string[],
    liveSince: number
  ) => void;
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
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
  updateStoredPrivateMessagesLastReceivedFromCreatedAt: (value: unknown) => void;
}

export function createPrivateMessagesSubscriptionRuntime({
  beginStartupStep,
  buildFilterSinceDetails,
  buildSubscriptionRelayDetails,
  bumpDeveloperDiagnosticsVersion,
  clearPrivateMessagesUiRefreshState,
  completeStartupStep,
  ensureRelayConnections,
  failStartupStep,
  flushPrivateMessagesUiRefreshNow,
  getLoggedInPublicKeyHex,
  getOrCreateSigner,
  getPrivateMessagesIngestQueue,
  getPrivateMessagesStartupLiveSince,
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
  resolvePrivateMessageReadRelayUrls,
  schedulePostPrivateMessagesEoseChecks,
  setPrivateMessagesRestoreThrottleMs,
  startPrivateMessagesStartupBackfill,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
  updateStoredPrivateMessagesLastReceivedFromCreatedAt,
}: PrivateMessagesSubscriptionRuntimeDeps) {
  let privateMessagesSubscription: ReturnType<NDK['subscribe']> | null = null;
  let privateMessagesSubscriptionSignature = '';
  const subscriptions = createDesiredSubscriptions();
  let generation = 0;
  let desiredScopeCount = 0;
  const scopes = new Map<
    string,
    { signature: string; since: number; ready: boolean; subscription: ReturnType<NDK['subscribe']> }
  >();
  let subscriptionSetup: Promise<void> = Promise.resolve();
  let privateMessagesWatchdogTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let privateMessagesWatchdogRunPromise: Promise<void> | null = null;
  let privateMessagesWatchdogLastRecoveryAt = 0;
  let privateMessagesSubscriptionShouldBeActive = false;
  let hasPrivateMessagesWatchdogOnlineListener = false;
  let messageHistoryRestoreContext: MessageHistoryRestoreContext | null = null;
  let messageHistoryRestoreRequested = false;
  const privateMessagesWatchdogRelayConnectionStates = new Map<string, boolean>();

  function startPrivateMessagesHistoryRestore(): void {
    if (!messageHistoryRestoreContext || !getLoggedInPublicKeyHex()) {
      throw new Error('Start the message listener before restoring message history.');
    }

    beginStartupStep('message-history-restore');
    messageHistoryRestoreRequested = true;
    void runPendingMessageHistoryRestore();
  }

  async function runPendingMessageHistoryRestore(): Promise<void> {
    const context = messageHistoryRestoreContext;
    if (!messageHistoryRestoreRequested || !context?.ready || context.preparing) {
      return;
    }

    messageHistoryRestoreRequested = false;
    context.preparing = true;
    try {
      await getPrivateMessagesIngestQueue();
      if (context !== messageHistoryRestoreContext) {
        return;
      }
      if (
        context !== messageHistoryRestoreContext ||
        context.loggedInPubkeyHex !== getLoggedInPublicKeyHex()
      ) {
        return;
      }

      startPrivateMessagesStartupBackfill(
        context.loggedInPubkeyHex,
        context.recipientPubkeys,
        context.relayUrls,
        context.liveSince
      );
    } catch (error) {
      if (context === messageHistoryRestoreContext) {
        failStartupStep('message-history-restore', error);
      }
    } finally {
      context.preparing = false;
    }
  }

  function ensurePrivateMessagesWatchdog(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (!hasPrivateMessagesWatchdogOnlineListener) {
      window.addEventListener('online', handlePrivateMessagesWatchdogBrowserOnline);
      hasPrivateMessagesWatchdogOnlineListener = true;
    }

    queuePrivateMessagesWatchdog(PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS);
  }

  function handlePrivateMessagesWatchdogBrowserOnline(): void {
    if (!privateMessagesSubscriptionShouldBeActive) {
      return;
    }

    logSubscription('private-messages', 'watchdog-browser-online');
    queuePrivateMessagesWatchdog(0);
  }

  function queuePrivateMessagesWatchdog(delayMs = PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (privateMessagesWatchdogTimeoutId !== null) {
      globalThis.clearTimeout(privateMessagesWatchdogTimeoutId);
    }

    privateMessagesWatchdogTimeoutId = globalThis.setTimeout(
      () => {
        privateMessagesWatchdogTimeoutId = null;
        void runPrivateMessagesWatchdog();
      },
      Math.max(0, Math.floor(delayMs))
    );
  }

  function syncPrivateMessagesWatchdogRelayConnectionStates(relayUrls: string[]): void {
    const normalizedRelayUrls = normalizeRelayStatusUrls(relayUrls);
    const nextRelayUrlSet = new Set(normalizedRelayUrls);

    for (const relayUrl of privateMessagesWatchdogRelayConnectionStates.keys()) {
      if (!nextRelayUrlSet.has(relayUrl)) {
        privateMessagesWatchdogRelayConnectionStates.delete(relayUrl);
      }
    }

    for (const relayUrl of normalizedRelayUrls) {
      const relay = ndk.pool.getRelay(normalizeRelayUrl(relayUrl), false);
      privateMessagesWatchdogRelayConnectionStates.set(relayUrl, Boolean(relay?.connected));
    }
  }

  function markPrivateMessagesWatchdogRelayDisconnected(relayUrl: string): void {
    privateMessagesWatchdogRelayConnectionStates.set(relayUrl, false);
  }

  function isPrivateMessagesSubscriptionRelayTracked(relayUrl: string): boolean {
    return privateMessagesSubscriptionRelayUrls.value.includes(relayUrl);
  }

  function isBrowserOfflineForPrivateMessagesWatchdog(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  function markPrivateMessagesLiveCoverageNow(): void {
    const now = Math.floor(Date.now() / 1000);
    if (
      privateMessagesSubscriptionLiveCoverageAt.value !== null &&
      privateMessagesSubscriptionLiveCoverageAt.value >= now
    ) {
      return;
    }

    privateMessagesSubscriptionLiveCoverageAt.value = now;
    bumpDeveloperDiagnosticsVersion();
  }

  function getPrivateMessagesSubscriptionSinceOverride(value: number | undefined): number | null {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
  }

  async function refreshPrivateMessagesLiveSubscription(
    options: RefreshPrivateMessagesLiveSubscriptionOptions = {}
  ): Promise<RefreshPrivateMessagesLiveSubscriptionResult> {
    const sinceOverride = getPrivateMessagesSubscriptionSinceOverride(options.sinceOverride);
    const subscribeOptions: SubscribePrivateMessagesOptions = {
      ...(options.seedRelayUrls ? { seedRelayUrls: options.seedRelayUrls } : {}),
      ...(sinceOverride !== null ? { sinceOverride } : {}),
      restoreThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
    };

    const recreateLiveSubscription = async (
      reason: string
    ): Promise<RefreshPrivateMessagesLiveSubscriptionResult> => {
      const previousStartedAt = privateMessagesSubscriptionStartedAt.value;
      logSubscription('private-messages', 'live-refresh-recreate', {
        reason,
        ...buildFilterSinceDetails(subscribeOptions.sinceOverride),
      });
      try {
        await subscribePrivateMessagesForLoggedInUser(true, {
          ...subscribeOptions,
          unhealthy: true,
        });
        return {
          recreatedLiveSubscription:
            privateMessagesSubscription !== null &&
            privateMessagesSubscriptionStartedAt.value !== previousStartedAt,
        };
      } catch (error) {
        console.warn('Failed to refresh private messages live subscription', error);
        logSubscription('private-messages', 'live-refresh-recreate-error', {
          reason,
          error,
          ...buildFilterSinceDetails(subscribeOptions.sinceOverride),
        });
        return { recreatedLiveSubscription: false };
      }
    };

    if (options.forceRecreate === true) {
      return recreateLiveSubscription('force-recreate');
    }

    if (
      privateMessagesSubscription &&
      scopes.size > 0 &&
      privateMessagesSubscriptionRelayUrls.value.every(
        (url) => ndk.pool.getRelay(normalizeRelayUrl(url), false)?.connected
      )
    ) {
      await subscribePrivateMessagesForLoggedInUser(false, subscribeOptions);
      return { recreatedLiveSubscription: false };
    }
    if (!privateMessagesSubscription) return recreateLiveSubscription('missing-subscription');

    // NDK reissues the existing filters when transport reconnects. A second probe
    // downloads the same window and is not evidence that a healthy listener needs replacing.
    await ensureRelayConnections(privateMessagesSubscriptionRelayUrls.value);
    await subscribePrivateMessagesForLoggedInUser(false, subscribeOptions);
    return { recreatedLiveSubscription: false };
  }

  async function recoverPrivateMessagesSubscriptionFromWatchdog(
    reason: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const now = Date.now();
    if (
      now - privateMessagesWatchdogLastRecoveryAt <
      PRIVATE_MESSAGES_WATCHDOG_RECOVERY_COOLDOWN_MS
    ) {
      logSubscription('private-messages', 'watchdog-recover-skipped', {
        reason,
        cooldownMs: PRIVATE_MESSAGES_WATCHDOG_RECOVERY_COOLDOWN_MS,
        ...details,
      });
      return;
    }

    privateMessagesWatchdogLastRecoveryAt = now;
    logSubscription('private-messages', 'watchdog-recover', {
      reason,
      ...details,
    });
    await subscribePrivateMessagesForLoggedInUser(false, {
      restoreThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
    });
  }

  async function runPrivateMessagesWatchdog(): Promise<void> {
    if (privateMessagesWatchdogRunPromise) {
      return privateMessagesWatchdogRunPromise;
    }

    privateMessagesWatchdogRunPromise = (async () => {
      try {
        if (!privateMessagesSubscriptionShouldBeActive) {
          privateMessagesWatchdogRelayConnectionStates.clear();
          return;
        }

        if (isRestoringStartupState.value) {
          return;
        }

        const loggedInPubkeyHex = getLoggedInPublicKeyHex();
        const authMethod = getStoredAuthMethod();
        if (!loggedInPubkeyHex || !authMethod) {
          privateMessagesSubscriptionShouldBeActive = false;
          privateMessagesWatchdogRelayConnectionStates.clear();
          return;
        }

        const browserOffline = isBrowserOfflineForPrivateMessagesWatchdog();
        const relayUrls = normalizeRelayStatusUrls(privateMessagesSubscriptionRelayUrls.value);
        if (
          scopes.size !== desiredScopeCount ||
          !privateMessagesSubscription ||
          !privateMessagesSubscriptionSignature ||
          relayUrls.length === 0
        ) {
          if (browserOffline) {
            return;
          }

          await recoverPrivateMessagesSubscriptionFromWatchdog('subscription-missing', {
            hasSubscription: Boolean(privateMessagesSubscription),
            hasSignature: Boolean(privateMessagesSubscriptionSignature),
            relayCount: relayUrls.length,
          });
          return;
        }

        const relayStatesBefore = new Map<string, boolean>();
        for (const relayUrl of relayUrls) {
          const relay = ndk.pool.getRelay(normalizeRelayUrl(relayUrl), false);
          relayStatesBefore.set(relayUrl, Boolean(relay?.connected));
        }

        const disconnectedRelayUrls = relayUrls.filter(
          (relayUrl) => !relayStatesBefore.get(relayUrl)
        );
        if (disconnectedRelayUrls.length > 0 && !browserOffline) {
          const shouldLogReconnectAttempt = disconnectedRelayUrls.some(
            (relayUrl) => privateMessagesWatchdogRelayConnectionStates.get(relayUrl) !== false
          );
          if (shouldLogReconnectAttempt) {
            logSubscription('private-messages', 'watchdog-reconnect-relays', {
              disconnectedRelayUrls,
              ...buildSubscriptionRelayDetails(relayUrls),
            });
          }
          await ensureRelayConnections(relayUrls);
        }

        const relayStatesAfter = new Map<string, boolean>();
        for (const relayUrl of relayUrls) {
          const relay = ndk.pool.getRelay(normalizeRelayUrl(relayUrl), false);
          relayStatesAfter.set(relayUrl, Boolean(relay?.connected));
        }

        const reconnectedRelayUrls = relayUrls.filter((relayUrl) => {
          const before = relayStatesBefore.get(relayUrl) ?? false;
          const after = relayStatesAfter.get(relayUrl) ?? false;
          const previous = privateMessagesWatchdogRelayConnectionStates.get(relayUrl);
          return (
            after && ((!before && disconnectedRelayUrls.includes(relayUrl)) || previous === false)
          );
        });

        syncPrivateMessagesWatchdogRelayConnectionStates(relayUrls);

        if (reconnectedRelayUrls.length > 0) {
          await recoverPrivateMessagesSubscriptionFromWatchdog('relay-reconnected', {
            reconnectedRelayUrls,
            ...buildSubscriptionRelayDetails(relayUrls),
          });
        }
      } catch (error) {
        console.warn('Private messages watchdog failed', error);
        logSubscription('private-messages', 'watchdog-error', {
          error,
        });
      } finally {
        privateMessagesWatchdogRunPromise = null;
        queuePrivateMessagesWatchdog(PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS);
      }
    })();

    return privateMessagesWatchdogRunPromise;
  }

  function stopPrivateMessagesLiveSubscription(reason = 'replace'): void {
    generation += 1;
    desiredScopeCount = 0;
    messageHistoryRestoreContext = null;
    subscriptions.stop();
    scopes.clear();
    if (privateMessagesSubscription) {
      logSubscription('private-messages', 'stop', {
        reason,
        signature: privateMessagesSubscriptionSignature || null,
      });
      privateMessagesSubscription = null;
    }

    clearPrivateMessagesUiRefreshState();
    privateMessagesWatchdogRelayConnectionStates.clear();
    privateMessagesSubscriptionSignature = '';
    setPrivateMessagesRestoreThrottleMs(0);
    privateMessagesSubscriptionRelayUrls.value = [];
    privateMessagesSubscriptionSince.value = null;
    bumpDeveloperDiagnosticsVersion();
  }

  function resetPrivateMessagesSubscriptionRuntimeState(
    options: { clearLastEventState?: boolean } = {}
  ): void {
    privateMessagesWatchdogLastRecoveryAt = 0;
    privateMessagesSubscriptionShouldBeActive = false;
    messageHistoryRestoreRequested = false;
    messageHistoryRestoreContext = null;
    privateMessagesWatchdogRelayConnectionStates.clear();

    if (!options.clearLastEventState) {
      return;
    }

    privateMessagesSubscriptionStartedAt.value = null;
    privateMessagesSubscriptionLastEventSeenAt.value = null;
    privateMessagesSubscriptionLastEventId.value = null;
    privateMessagesSubscriptionLastEventCreatedAt.value = null;
    privateMessagesSubscriptionLastEoseAt.value = null;
    privateMessagesSubscriptionLiveCoverageAt.value = null;
  }

  function subscribePrivateMessagesForLoggedInUser(
    _force = false,
    options: SubscribePrivateMessagesOptions = {}
  ): Promise<void> {
    // Serialize desired-state reads as well as creation; later callers recheck effective signatures.
    const session = getLoggedInPublicKeyHex();
    const operation = subscriptionSetup
      .catch(() => {})
      .then(async () => {
        if (session !== getLoggedInPublicKeyHex()) return;
        try {
          await reconcilePrivateMessages(options.unhealthy === true, options);
        } catch (error) {
          if (options.startupTrackStep) failStartupStep('private-message-events', error);
          throw error;
        }
      });
    subscriptionSetup = operation;
    return operation;
  }

  async function reconcilePrivateMessages(
    unhealthy: boolean,
    options: SubscribePrivateMessagesOptions
  ): Promise<void> {
    const runGeneration = generation;
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex || !getStoredAuthMethod()) {
      stopPrivateMessagesLiveSubscription('missing-login');
      return;
    }
    privateMessagesSubscriptionShouldBeActive = true;
    const shouldTrackStartupStep =
      options.startupTrackStep === true ||
      getStartupStepSnapshot('private-message-events').status === 'in_progress';
    if (options.startupTrackStep) beginStartupStep('private-message-events');
    const recipients = await listPrivateMessageRecipientPubkeys();
    const routes = await resolvePrivateMessageRelayScopes(
      recipients,
      await resolvePrivateMessageReadRelayUrls(options.seedRelayUrls)
    );
    if (runGeneration !== generation || loggedInPubkeyHex !== getLoggedInPublicKeyHex()) return;
    const requestedSince = options.sinceOverride ?? getPrivateMessagesStartupLiveSince();
    const activeKeys = new Set(
      routes.filter((route) => route.relayUrls.length).map((route) => route.publicKey)
    );
    for (const key of scopes.keys()) if (!activeKeys.has(key)) scopes.delete(key);
    let changed = false;
    const desired = routes
      .filter((route) => route.relayUrls.length)
      .map(({ publicKey, relayUrls }) => {
        const current = scopes.get(publicKey);
        // A wall-clock/cursor advance never narrows an existing live listener. Epoch catch-up
        // is owned by history restore and must not broaden unrelated recipients' windows.
        const since = current && !unhealthy ? current.since : requestedSince;
        const filters: NDKFilter = { kinds: [NDKKind.GiftWrap], '#p': [publicKey], since };
        const signature = subscriptionSignature(filters, relayUrls);
        return {
          key: publicKey,
          signature,
          prepare: async () => {
            await ensureRelayConnections(relayUrls);
            await getOrCreateSigner();
          },
          start: (onEose: () => void, onClose: () => void) => {
            changed = true;
            const state = {
              signature,
              since,
              ready: false,
              subscription: null as unknown as ReturnType<NDK['subscribe']>,
            };
            scopes.set(publicKey, state);
            state.subscription = subscribeWithReqLogging(
              'private-messages',
              'private-messages-live',
              filters,
              {
                relaySet: NDKRelaySet.fromRelayUrls(relayUrls, ndk, false),
                cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
                onEvent: (event) => {
                  if (getLoggedInPublicKeyHex() !== loggedInPubkeyHex) return;
                  const wrapped = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
                  markPrivateMessagesLiveCoverageNow();
                  privateMessagesSubscriptionLastEventSeenAt.value = new Date().toISOString();
                  privateMessagesSubscriptionLastEventId.value =
                    normalizeEventId(wrapped.id) ?? wrapped.id ?? null;
                  privateMessagesSubscriptionLastEventCreatedAt.value = wrapped.created_at ?? null;
                  updateStoredPrivateMessagesLastReceivedFromCreatedAt(wrapped.created_at);
                  updateStoredEventSinceFromCreatedAt(wrapped.created_at);
                  queuePrivateMessageIngestion(wrapped, loggedInPubkeyHex);
                  bumpDeveloperDiagnosticsVersion();
                },
                onEose: () => {
                  state.ready = true;
                  onEose();
                  finishInitialMessages();
                },
                onClose: () => {
                  if (scopes.get(publicKey) === state) scopes.delete(publicKey);
                  onClose();
                  queuePrivateMessagesWatchdog(0);
                },
              },
              {
                signature,
                ...buildSubscriptionRelayDetails(relayUrls),
                ...buildFilterSinceDetails(since),
              }
            );
            return state.subscription;
          },
        };
      });
    desiredScopeCount = desired.length;
    await subscriptions.reconcile(desired, unhealthy);
    if (runGeneration !== generation) return;
    const relayUrls = normalizeRelayStatusUrls(routes.flatMap((route) => route.relayUrls));
    privateMessagesSubscription = [...scopes.values()][0]?.subscription ?? null;
    privateMessagesSubscriptionSignature = desired.map((item) => item.signature).join('|');
    privateMessagesSubscriptionRelayUrls.value = relayUrls;
    privateMessagesSubscriptionSince.value = Math.min(
      ...[...scopes.values()].map((state) => state.since)
    );
    syncPrivateMessagesWatchdogRelayConnectionStates(relayUrls);
    if (changed) {
      privateMessagesSubscriptionStartedAt.value = new Date().toISOString();
      privateMessagesSubscriptionLastEoseAt.value = null;
      setPrivateMessagesRestoreThrottleMs(normalizeThrottleMs(options.restoreThrottleMs));
    }
    // Keep the original global backfill context while epoch recipients change.
    messageHistoryRestoreContext ??= {
      loggedInPubkeyHex,
      recipientPubkeys: recipients,
      relayUrls,
      liveSince: requestedSince,
      ready: false,
      preparing: false,
    };
    finishInitialMessages();
    bumpDeveloperDiagnosticsVersion();

    function finishInitialMessages(): void {
      if (
        !messageHistoryRestoreContext ||
        !scopes.size ||
        [...scopes.values()].some((state) => !state.ready)
      )
        return;
      messageHistoryRestoreContext.ready = true;
      markPrivateMessagesLiveCoverageNow();
      privateMessagesSubscriptionLastEoseAt.value ??= new Date().toISOString();
      setPrivateMessagesRestoreThrottleMs(0);
      if (shouldTrackStartupStep) completeStartupStep('private-message-events');
      if (changed) {
        flushPrivateMessagesUiRefreshNow();
        schedulePostPrivateMessagesEoseChecks();
      }
      void runPendingMessageHistoryRestore();
    }
  }

  function getPrivateMessagesSubscription(): ReturnType<NDK['subscribe']> | null {
    return privateMessagesSubscription;
  }

  function getPrivateMessagesSubscriptionSignature(): string {
    return privateMessagesSubscriptionSignature;
  }

  return {
    ensurePrivateMessagesWatchdog,
    getPrivateMessagesSubscription,
    getLiveRecipientSince: (publicKey: string) => scopes.get(publicKey)?.since ?? null,
    getPrivateMessagesSubscriptionSignature,
    isPrivateMessagesSubscriptionRelayTracked,
    markPrivateMessagesWatchdogRelayDisconnected,
    queuePrivateMessagesWatchdog,
    refreshPrivateMessagesLiveSubscription,
    resetPrivateMessagesSubscriptionRuntimeState,
    startPrivateMessagesHistoryRestore,
    stopPrivateMessagesLiveSubscription,
    subscribePrivateMessagesForLoggedInUser,
  };
}
