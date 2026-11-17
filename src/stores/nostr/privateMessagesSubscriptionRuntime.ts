import { startupRelayObserver } from '#src/stores/nostr/startupRelayTracking.ts';
import NostrClient, {
  ClientEvent,
  type NostrFilter,
  NostrKind,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  type NostrSubscriptionOptions,
  normalizeRelayUrl,
} from '#src/lib/nostr/client.ts';
import {
  PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
  PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS,
  PRIVATE_MESSAGES_WATCHDOG_RECOVERY_COOLDOWN_MS,
  PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS,
} from '#src/stores/nostr/constants.ts';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import { resolvePrivateMessageRelayScopes } from '#src/stores/nostr/privateMessageRouting.ts';
import type {
  RefreshPrivateMessagesLiveSubscriptionOptions,
  RefreshPrivateMessagesLiveSubscriptionResult,
  SubscribePrivateMessagesOptions,
} from '#src/stores/nostr/types.ts';

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
    loggedInPubkeyHex: string,
  ) => Promise<Record<string, unknown>>;
  buildSubscriptionEventDetails: (
    event: Pick<ClientEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>,
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  bumpDeveloperDiagnosticsVersion: () => void;
  clearPrivateMessagesUiRefreshState: () => void;
  completeStartupStep: (stepId: MessageStartupTrackId, partial?: boolean) => void;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: ClientEvent) => string[];
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
  isRestoringStartupState: boolean;
  listPrivateMessageRecipientPubkeys: () => Promise<string[]>;
  logSubscription: (
    label: 'private-messages',
    stage: string,
    details?: Record<string, unknown>,
  ) => void;
  ndk: NostrClient;
  normalizeEventId: (value: unknown) => string | null;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  normalizeThrottleMs: (value: number | undefined) => number;
  privateMessagesSubscriptionLastEoseAt: string | null;
  privateMessagesSubscriptionLastEventCreatedAt: number | null;
  privateMessagesSubscriptionLastEventId: string | null;
  privateMessagesSubscriptionLastEventSeenAt: string | null;
  privateMessagesSubscriptionLiveCoverageAt: number | null;
  privateMessagesSubscriptionRelayUrls: string[];
  privateMessagesSubscriptionSince: number | null;
  privateMessagesSubscriptionStartedAt: string | null;
  queuePrivateMessageIngestion: (
    wrappedEvent: ClientEvent,
    loggedInPubkeyHex: string,
    options?: { priority: 'foreground' | 'background'; live?: boolean },
  ) => void;
  refreshAllStoredContacts: () => Promise<unknown>;
  relaySignature: (relays: string[]) => string;
  resolvePrivateMessageReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  schedulePostPrivateMessagesEoseChecks: () => void;
  setPrivateMessagesRestoreThrottleMs: (value: number) => void;
  startPrivateMessagesStartupBackfill: (
    loggedInPubkeyHex: string,
    recipientPubkeys: string[],
    relayUrls: string[],
    liveSince: number,
  ) => void;
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
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
  updateStoredPrivateMessagesLastReceivedFromCreatedAt: (value: unknown) => void;
}

export function createPrivateMessagesSubscriptionRuntime(
  runtimeState: PrivateMessagesSubscriptionRuntimeDeps,
) {
  const {
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
    getPrivateMessagesStartupLiveSince,
    getStartupStepSnapshot,
    getStoredAuthMethod,
    listPrivateMessageRecipientPubkeys,
    logSubscription,
    ndk,
    normalizeEventId,
    normalizeRelayStatusUrls,
    normalizeThrottleMs,
    queuePrivateMessageIngestion,
    resolvePrivateMessageReadRelayUrls,
    schedulePostPrivateMessagesEoseChecks,
    setPrivateMessagesRestoreThrottleMs,
    startPrivateMessagesStartupBackfill,
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt,
    updateStoredPrivateMessagesLastReceivedFromCreatedAt,
  } = runtimeState;
  let privateMessagesSubscription: ReturnType<NostrClient['subscribe']> | null = null;
  let privateMessagesSubscriptionSignature = '';
  const subscriptions = createDesiredSubscriptions();
  let generation = 0;
  let desiredScopeCount = 0;
  const scopes = new Map<
    string,
    {
      signature: string;
      since: number;
      ready: boolean;
      partial: boolean;
      completedRelayUrls: string[];
      subscription: ReturnType<NostrClient['subscribe']>;
    }
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
    if (!messageHistoryRestoreRequested || !context || context.preparing) {
      return;
    }

    messageHistoryRestoreRequested = false;
    context.preparing = true;
    try {
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
        context.liveSince,
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

  function queuePrivateMessagesWatchdog(
    delayMs = PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS,
  ): void {
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
      Math.max(0, Math.floor(delayMs)),
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
    return runtimeState.privateMessagesSubscriptionRelayUrls.includes(relayUrl);
  }

  function isBrowserOfflineForPrivateMessagesWatchdog(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  function markPrivateMessagesLiveCoverageNow(): void {
    const now = Math.floor(Date.now() / 1000);
    if (
      runtimeState.privateMessagesSubscriptionLiveCoverageAt !== null &&
      runtimeState.privateMessagesSubscriptionLiveCoverageAt >= now
    ) {
      return;
    }

    runtimeState.privateMessagesSubscriptionLiveCoverageAt = now;
    bumpDeveloperDiagnosticsVersion();
  }

  function getPrivateMessagesSubscriptionSinceOverride(
    value: number | undefined,
  ): number | null {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
  }

  async function refreshPrivateMessagesLiveSubscription(
    options: RefreshPrivateMessagesLiveSubscriptionOptions = {},
  ): Promise<RefreshPrivateMessagesLiveSubscriptionResult> {
    const sinceOverride = getPrivateMessagesSubscriptionSinceOverride(options.sinceOverride);
    const subscribeOptions: SubscribePrivateMessagesOptions = {
      ...(options.seedRelayUrls ? { seedRelayUrls: options.seedRelayUrls } : {}),
      ...(sinceOverride !== null ? { sinceOverride } : {}),
      restoreThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
    };

    const recreateLiveSubscription = async (
      reason: string,
    ): Promise<RefreshPrivateMessagesLiveSubscriptionResult> => {
      const previousStartedAt = runtimeState.privateMessagesSubscriptionStartedAt;
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
            runtimeState.privateMessagesSubscriptionStartedAt !== previousStartedAt,
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
      runtimeState.privateMessagesSubscriptionRelayUrls.every(
        (url) => ndk.pool.getRelay(normalizeRelayUrl(url), false)?.connected,
      )
    ) {
      await subscribePrivateMessagesForLoggedInUser(false, subscribeOptions);
      return { recreatedLiveSubscription: false };
    }
    if (!privateMessagesSubscription) return recreateLiveSubscription('missing-subscription');

    // NostrClient reissues the existing filters when transport reconnects. A second probe
    // downloads the same window and is not evidence that a healthy listener needs replacing.
    await ensureRelayConnections(runtimeState.privateMessagesSubscriptionRelayUrls);
    await subscribePrivateMessagesForLoggedInUser(false, subscribeOptions);
    return { recreatedLiveSubscription: false };
  }

  async function recoverPrivateMessagesSubscriptionFromWatchdog(
    reason: string,
    details: Record<string, unknown> = {},
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

        if (runtimeState.isRestoringStartupState) {
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
        const relayUrls = normalizeRelayStatusUrls(
          runtimeState.privateMessagesSubscriptionRelayUrls,
        );
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
          (relayUrl) => !relayStatesBefore.get(relayUrl),
        );
        if (disconnectedRelayUrls.length > 0 && !browserOffline) {
          const shouldLogReconnectAttempt = disconnectedRelayUrls.some(
            (relayUrl) => privateMessagesWatchdogRelayConnectionStates.get(relayUrl) !== false,
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
            after &&
            ((!before && disconnectedRelayUrls.includes(relayUrl)) || previous === false)
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
      }
    })().finally(() => {
      // Run after assignment even when the check returns before its first await.
      // Otherwise a completed promise can permanently block future recovery.
      privateMessagesWatchdogRunPromise = null;
      queuePrivateMessagesWatchdog(PRIVATE_MESSAGES_WATCHDOG_INTERVAL_MS);
    });

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
    runtimeState.privateMessagesSubscriptionRelayUrls = [];
    runtimeState.privateMessagesSubscriptionSince = null;
    bumpDeveloperDiagnosticsVersion();
  }

  function resetPrivateMessagesSubscriptionRuntimeState(
    options: { clearLastEventState?: boolean } = {},
  ): void {
    privateMessagesWatchdogLastRecoveryAt = 0;
    privateMessagesSubscriptionShouldBeActive = false;
    messageHistoryRestoreRequested = false;
    messageHistoryRestoreContext = null;
    privateMessagesWatchdogRelayConnectionStates.clear();

    if (!options.clearLastEventState) {
      return;
    }

    runtimeState.privateMessagesSubscriptionStartedAt = null;
    runtimeState.privateMessagesSubscriptionLastEventSeenAt = null;
    runtimeState.privateMessagesSubscriptionLastEventId = null;
    runtimeState.privateMessagesSubscriptionLastEventCreatedAt = null;
    runtimeState.privateMessagesSubscriptionLastEoseAt = null;
    runtimeState.privateMessagesSubscriptionLiveCoverageAt = null;
  }

  function subscribePrivateMessagesForLoggedInUser(
    _force = false,
    options: SubscribePrivateMessagesOptions = {},
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
    options: SubscribePrivateMessagesOptions,
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
      await resolvePrivateMessageReadRelayUrls(options.seedRelayUrls),
    );
    if (runGeneration !== generation || loggedInPubkeyHex !== getLoggedInPublicKeyHex())
      return;
    const requestedSince = options.sinceOverride ?? getPrivateMessagesStartupLiveSince();
    const activeKeys = new Set(
      routes.filter((route) => route.relayUrls.length).map((route) => route.publicKey),
    );
    for (const key of scopes.keys()) if (!activeKeys.has(key)) scopes.delete(key);
    let changed = false;
    const desired = routes
      .filter((route) => route.relayUrls.length)
      .map(({ publicKey, relayUrls }) => {
        const current = scopes.get(publicKey);
        // A wall-clock/cursor advance never narrows an existing live listener. Epoch catch-up
        // is owned by history restore and must not broaden unrelated recipients' windows.
        const groupRecipient = publicKey !== loggedInPubkeyHex;
        const initialSince = groupRecipient
          ? Math.max(
              requestedSince,
              Math.floor(Date.now() / 1000) - PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS,
            )
          : requestedSince;
        const since = current && !unhealthy ? current.since : initialSince;
        // Recovered old tickets can move the account's receive watermark far
        // back. A live epoch listener must not become an unbounded archive query.
        const filters: NostrFilter = {
          kinds: [NostrKind.GiftWrap],
          '#p': [publicKey],
          since,
          ...(groupRecipient ? { limit: 128 } : {}),
        };
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
              partial: false,
              completedRelayUrls: [] as string[],
              subscription: null as unknown as ReturnType<NostrClient['subscribe']>,
            };
            scopes.set(publicKey, state);
            state.subscription = subscribeWithReqLogging(
              'private-messages',
              'private-messages-live',
              filters,
              {
                relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
                cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
                onRelayStatus: startupRelayObserver(ndk, ['private-message-events'], publicKey, relayUrls),
                onEvent: (event) => {
                  if (getLoggedInPublicKeyHex() !== loggedInPubkeyHex) return;
                  const wrapped =
                    event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
                  markPrivateMessagesLiveCoverageNow();
                  runtimeState.privateMessagesSubscriptionLastEventSeenAt =
                    new Date().toISOString();
                  runtimeState.privateMessagesSubscriptionLastEventId =
                    normalizeEventId(wrapped.id) ?? wrapped.id ?? null;
                  runtimeState.privateMessagesSubscriptionLastEventCreatedAt =
                    wrapped.created_at ?? null;
                  updateStoredPrivateMessagesLastReceivedFromCreatedAt(wrapped.created_at);
                  updateStoredEventSinceFromCreatedAt(wrapped.created_at);
                  queuePrivateMessageIngestion(wrapped, loggedInPubkeyHex, {
                    priority: 'foreground',
                    ...(state.ready &&
                    (!state.partial || state.completedRelayUrls.includes(wrapped.relay?.url ?? ''))
                      ? { live: true }
                      : {}),
                  });
                  bumpDeveloperDiagnosticsVersion();
                },
                onEose: () => {
                  state.ready = true;
                  state.partial = false;
                  onEose();
                  finishInitialMessages();
                },
                onInitialSync: (completed, pending) => {
                  if (runGeneration !== generation || scopes.get(publicKey) !== state) return;
                  state.ready = true;
                  state.partial = pending.length > 0;
                  state.completedRelayUrls = completed;
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
              },
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
    runtimeState.privateMessagesSubscriptionRelayUrls = relayUrls;
    runtimeState.privateMessagesSubscriptionSince = Math.min(
      ...[...scopes.values()].map((state) => state.since),
    );
    syncPrivateMessagesWatchdogRelayConnectionStates(relayUrls);
    if (changed) {
      runtimeState.privateMessagesSubscriptionStartedAt = new Date().toISOString();
      runtimeState.privateMessagesSubscriptionLastEoseAt = null;
      setPrivateMessagesRestoreThrottleMs(normalizeThrottleMs(options.restoreThrottleMs));
    }
    // Keep the original global backfill context while epoch recipients change.
    const updatingHistory = messageHistoryRestoreContext !== null;
    messageHistoryRestoreContext ??= {
      loggedInPubkeyHex,
      recipientPubkeys: recipients,
      relayUrls,
      liveSince: requestedSince,
      ready: false,
      preparing: false,
    };
    if (changed && updatingHistory) {
      messageHistoryRestoreContext.recipientPubkeys = recipients;
      messageHistoryRestoreContext.relayUrls = relayUrls;
      messageHistoryRestoreRequested = true;
    }
    finishInitialMessages();
    void runPendingMessageHistoryRestore();
    bumpDeveloperDiagnosticsVersion();

    function finishInitialMessages(): void {
      if (
        !messageHistoryRestoreContext ||
        !scopes.size ||
        [...scopes.values()].some((state) => !state.ready)
      )
        return;
      messageHistoryRestoreContext.ready = true;
      const partial = [...scopes.values()].some((state) => state.partial);
      const hasCompletedRelay = [...scopes.values()].some(
        (state) => !state.partial || state.completedRelayUrls.length > 0,
      );
      if (!partial) {
        markPrivateMessagesLiveCoverageNow();
        runtimeState.privateMessagesSubscriptionLastEoseAt ??= new Date().toISOString();
      }
      setPrivateMessagesRestoreThrottleMs(0);
      if (shouldTrackStartupStep) {
        if (hasCompletedRelay) completeStartupStep('private-message-events', partial);
        else
          failStartupStep(
            'private-message-events',
            new Error(
              'No relay completed initial message synchronization. Retrying in the background.',
            ),
          );
      }
      if (changed) {
        flushPrivateMessagesUiRefreshNow();
        schedulePostPrivateMessagesEoseChecks();
      }
      void runPendingMessageHistoryRestore();
    }
  }

  function getPrivateMessagesSubscription(): ReturnType<NostrClient['subscribe']> | null {
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
