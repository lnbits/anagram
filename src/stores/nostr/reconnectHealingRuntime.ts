import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  RECONNECT_HEALING_FOCUS_DELAY_MS,
  RECONNECT_HEALING_MIN_BACKGROUND_MS,
  RECONNECT_HEALING_MIN_INTERVAL_MS,
  RECONNECT_HEALING_ONLINE_DELAY_MS,
  RECONNECT_HEALING_RELAY_LIST_CHANGE_DELAY_MS,
  RECONNECT_HEALING_RELAY_RECONNECT_DELAY_MS,
  RECONNECT_HEALING_VISIBILITY_DELAY_MS,
} from 'src/stores/nostr/constants';
import type { ChatType } from 'src/types/chat';
import type { Ref } from 'vue';

export type ReconnectHealingReason =
  | 'browser-online'
  | 'session-resume'
  | 'window-focus'
  | 'visibility-regain'
  | 'relay-connected'
  | 'relay-list-changed';

interface RefreshDirectMessagesOptions {
  forceLiveSubscriptionRecreate?: boolean;
  sinceMode?: 'reconnect' | 'startup';
}

interface RefreshDirectMessagesResult {
  recreatedLiveSubscription: boolean;
}

export interface ReconnectHealingRunOptions {
  propagateError?: boolean;
  sessionRelayUrls?: string[];
}

export interface ReconnectHealingChatTarget {
  id: string;
  publicKey: string;
  type: ChatType;
  epochPublicKey: string | null;
}

interface ReconnectHealingRuntimeDeps {
  getLoggedInPublicKeyHex: () => string | null;
  getPrivateMessagesLiveEoseAt: () => string | null;
  getVisibleChatTarget: () => ReconnectHealingChatTarget | null;
  isNativeAndroid: () => boolean;
  isRestoringStartupState: Ref<boolean>;
  queueOutboundMessageReplay: (reason: 'reconnect-healing', delayMs?: number) => void;
  queuePrivateMessagesWatchdog: (delayMs?: number) => void;
  refreshDeveloperPendingQueues: () => Promise<unknown>;
  refreshDirectMessages: (
    options?: RefreshDirectMessagesOptions
  ) => Promise<RefreshDirectMessagesResult>;
  restartSessionSubscriptions: (relayUrls: string[]) => Promise<void>;
  setIsReconnectHealing: (value: boolean) => void;
  setReconnectHealingStatusLabel: (value: string | null) => void;
  waitForPrivateMessagesIngestQueue: () => Promise<void>;
}

const RECONNECT_HEALING_STATUS_LABELS = {
  preparingSync: 'sync.preparing',
  resumingSession: 'sync.resumingSession',
  checkingSessionAndNetwork: 'sync.checkingSessionNetwork',
  checkingMessageRelays: 'sync.checkingMessageRelays',
  retryingUnsentMessages: 'sync.retryingUnsentMessages',
  refreshingDirectMessages: 'sync.refreshingDirectMessages',
  applyingPendingMessageUpdates: 'sync.applyingPendingMessageUpdates',
  finishingSync: 'sync.finishing',
} as const;
const RECONNECT_HEALING_QUEUED_STATUS_LABEL_PREFIX = 'sync.started:';
const RECONNECT_HEALING_REASON_LABELS: Record<ReconnectHealingReason, string> = {
  'browser-online': 'sync.reason.browserOnline',
  'session-resume': 'sync.reason.sessionResume',
  'window-focus': 'sync.reason.windowFocus',
  'visibility-regain': 'sync.reason.visibilityRestored',
  'relay-connected': 'sync.reason.relayConnected',
  'relay-list-changed': 'sync.reason.relayListChanged',
};
const RECONNECT_HEALING_STATUS_MIN_VISIBLE_MS = 500;
const RECONNECT_HEALING_PRIVATE_MESSAGES_EOSE_TIMEOUT_MS = 60 * 1000;
const RECONNECT_HEALING_PRIVATE_MESSAGES_EOSE_POLL_MS = 100;

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function logReconnectHealing(phase: string, details: Record<string, unknown> = {}): void {
  console.log('[nostr-chat][reconnect-healing]', phase, details);
}

function normalizeChatTarget(
  target: ReconnectHealingChatTarget | null | undefined
): ReconnectHealingChatTarget | null {
  if (!target) {
    return null;
  }

  const normalizedId = inputSanitizerService.normalizeHexKey(target.id);
  const normalizedPublicKey = inputSanitizerService.normalizeHexKey(target.publicKey);
  const normalizedEpochPublicKey =
    typeof target.epochPublicKey === 'string'
      ? inputSanitizerService.normalizeHexKey(target.epochPublicKey)
      : null;
  if (!normalizedId || !normalizedPublicKey) {
    return null;
  }

  return {
    id: normalizedId,
    publicKey: normalizedPublicKey,
    type: target.type,
    epochPublicKey: normalizedEpochPublicKey,
  };
}

function getReconnectHealingDelayMs(reason: ReconnectHealingReason): number {
  switch (reason) {
    case 'window-focus':
      return RECONNECT_HEALING_FOCUS_DELAY_MS;
    case 'visibility-regain':
      return RECONNECT_HEALING_VISIBILITY_DELAY_MS;
    case 'relay-connected':
      return RECONNECT_HEALING_RELAY_RECONNECT_DELAY_MS;
    case 'relay-list-changed':
      return RECONNECT_HEALING_RELAY_LIST_CHANGE_DELAY_MS;
    default:
      return RECONNECT_HEALING_ONLINE_DELAY_MS;
  }
}

function getReconnectHealingQueuedStatusLabel(reason: ReconnectHealingReason): string {
  return `${RECONNECT_HEALING_QUEUED_STATUS_LABEL_PREFIX}${RECONNECT_HEALING_REASON_LABELS[reason]}`;
}

function isReconnectHealingQueuedStatusLabel(value: string | null): boolean {
  return value?.startsWith(RECONNECT_HEALING_QUEUED_STATUS_LABEL_PREFIX) === true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, Math.floor(ms)));
  });
}

export function createReconnectHealingRuntime({
  getLoggedInPublicKeyHex,
  getPrivateMessagesLiveEoseAt,
  getVisibleChatTarget,
  isNativeAndroid,
  isRestoringStartupState,
  queueOutboundMessageReplay,
  queuePrivateMessagesWatchdog,
  refreshDeveloperPendingQueues,
  refreshDirectMessages,
  restartSessionSubscriptions,
  setIsReconnectHealing,
  setReconnectHealingStatusLabel,
  waitForPrivateMessagesIngestQueue,
}: ReconnectHealingRuntimeDeps) {
  let reconnectHealingTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let reconnectHealingScheduledAt = 0;
  let reconnectHealingRunPromise: Promise<void> | null = null;
  let reconnectHealingPendingReason: ReconnectHealingReason | null = null;
  let reconnectHealingLastFinishedAt = 0;
  let reconnectHealingLastBlurAt = 0;
  let reconnectHealingLastHiddenAt = 0;
  let reconnectHealingStatusLabel: string | null = null;
  let reconnectHealingStatusLabelSetAt = 0;
  let reconnectHealingStatusLabelVersion = 0;

  function getReconnectHealingSessionNetworkSnapshot(): Record<string, unknown> {
    return {
      hasWindow: hasWindow(),
      hasLoggedInPubkey: Boolean(getLoggedInPublicKeyHex()),
      isRestoringStartupState: isRestoringStartupState.value,
      browserOnline: typeof navigator === 'undefined' ? null : navigator.onLine !== false,
    };
  }

  function setReconnectHealingStatusLabelNow(value: string | null): void {
    reconnectHealingStatusLabel = value;
    reconnectHealingStatusLabelSetAt = value === null ? 0 : Date.now();
    reconnectHealingStatusLabelVersion += 1;
    setReconnectHealingStatusLabel(value);
  }

  function getReconnectHealingStatusRemainingVisibleMs(): number {
    if (reconnectHealingStatusLabel === null || reconnectHealingStatusLabelSetAt <= 0) {
      return 0;
    }

    return Math.max(
      0,
      RECONNECT_HEALING_STATUS_MIN_VISIBLE_MS - (Date.now() - reconnectHealingStatusLabelSetAt)
    );
  }

  async function waitForReconnectHealingStatusMinimumVisibleMs(): Promise<boolean> {
    const statusLabelVersion = reconnectHealingStatusLabelVersion;
    const remainingMs = getReconnectHealingStatusRemainingVisibleMs();
    if (remainingMs > 0) {
      await delay(remainingMs);
    }

    return statusLabelVersion === reconnectHealingStatusLabelVersion;
  }

  async function showReconnectHealingStatusLabel(value: string): Promise<boolean> {
    if (!(await waitForReconnectHealingStatusMinimumVisibleMs())) {
      return false;
    }

    setReconnectHealingStatusLabelNow(value);
    return true;
  }

  async function hideReconnectHealingStatus(): Promise<void> {
    await waitForReconnectHealingStatusMinimumVisibleMs();
    setIsReconnectHealing(false);
    setReconnectHealingStatusLabelNow(null);
  }

  async function waitForPrivateMessagesLiveEoseAfter(
    previousEoseAt: string | null
  ): Promise<boolean> {
    const deadlineAt = Date.now() + RECONNECT_HEALING_PRIVATE_MESSAGES_EOSE_TIMEOUT_MS;

    while (Date.now() < deadlineAt) {
      const nextEoseAt = getPrivateMessagesLiveEoseAt();
      if (nextEoseAt && nextEoseAt !== previousEoseAt) {
        return true;
      }

      await delay(
        Math.min(
          RECONNECT_HEALING_PRIVATE_MESSAGES_EOSE_POLL_MS,
          Math.max(1, deadlineAt - Date.now())
        )
      );
    }

    return false;
  }

  async function waitForRefreshedPrivateMessagesLiveEose(previousEoseAt: string | null) {
    logReconnectHealing('private-messages-live-eose-wait-start', {
      timeoutMs: RECONNECT_HEALING_PRIVATE_MESSAGES_EOSE_TIMEOUT_MS,
    });
    const didReachEose = await waitForPrivateMessagesLiveEoseAfter(previousEoseAt);
    logReconnectHealing(
      didReachEose
        ? 'private-messages-live-eose-wait-complete'
        : 'private-messages-live-eose-wait-timeout',
      {
        timeoutMs: RECONNECT_HEALING_PRIVATE_MESSAGES_EOSE_TIMEOUT_MS,
      }
    );

    if (didReachEose) {
      await waitForPrivateMessagesIngestQueue();
    }
  }

  function clearReconnectHealingTimer(): void {
    if (reconnectHealingTimeoutId !== null) {
      globalThis.clearTimeout(reconnectHealingTimeoutId);
      reconnectHealingTimeoutId = null;
    }

    reconnectHealingScheduledAt = 0;
  }

  function getReconnectHealingCooldownRemainingMs(): number {
    if (reconnectHealingLastFinishedAt <= 0) {
      return 0;
    }

    return Math.max(
      0,
      reconnectHealingLastFinishedAt + RECONNECT_HEALING_MIN_INTERVAL_MS - Date.now()
    );
  }

  function rememberPendingReconnectHealing(reason: ReconnectHealingReason): void {
    if (reconnectHealingPendingReason === null) {
      reconnectHealingPendingReason = reason;
      logReconnectHealing('pending', {
        reason,
      });
    }
  }

  function consumePendingReconnectHealing(reason: ReconnectHealingReason): void {
    if (reconnectHealingPendingReason === reason) {
      reconnectHealingPendingReason = null;
    }
  }

  function clearQueuedReconnectHealingStatus(): void {
    if (!isReconnectHealingQueuedStatusLabel(reconnectHealingStatusLabel)) {
      return;
    }

    setIsReconnectHealing(false);
    setReconnectHealingStatusLabelNow(null);
  }

  function deferReconnectHealingWhileStartupRestores(reason: ReconnectHealingReason): boolean {
    if (!isRestoringStartupState.value || reason === 'session-resume') {
      return false;
    }

    logReconnectHealing('deferred', {
      reason,
      deferReason: 'startup-restore-in-progress',
      ...getReconnectHealingSessionNetworkSnapshot(),
    });
    clearQueuedReconnectHealingStatus();
    rememberPendingReconnectHealing(reason);
    scheduleReconnectHealing(
      reconnectHealingPendingReason ?? reason,
      RECONNECT_HEALING_ONLINE_DELAY_MS,
      {
        showQueuedLabel: false,
      }
    );
    return true;
  }

  function notifyBrowserOnline(): void {
    if (!getLoggedInPublicKeyHex()) {
      return;
    }

    queueReconnectHealing('browser-online');
  }

  function notifyWindowBlur(): void {
    reconnectHealingLastBlurAt = Date.now();
  }

  function shouldRunAfterBackground(lastBackgroundAt: number): boolean {
    return (
      lastBackgroundAt > 0 && Date.now() - lastBackgroundAt >= RECONNECT_HEALING_MIN_BACKGROUND_MS
    );
  }

  function notifyWindowFocus(): void {
    if (!getLoggedInPublicKeyHex()) {
      return;
    }

    const lastBackgroundAt = Math.max(reconnectHealingLastBlurAt, reconnectHealingLastHiddenAt);
    if (!shouldRunAfterBackground(lastBackgroundAt)) {
      return;
    }

    queueReconnectHealing('window-focus');
  }

  function notifyVisibilityHidden(): void {
    reconnectHealingLastHiddenAt = Date.now();
  }

  function notifyVisibilityRegain(): void {
    if (!getLoggedInPublicKeyHex()) {
      return;
    }

    if (!shouldRunAfterBackground(reconnectHealingLastHiddenAt)) {
      return;
    }

    queueReconnectHealing('visibility-regain');
  }

  function queueReconnectHealing(
    reason: ReconnectHealingReason,
    delayMs = getReconnectHealingDelayMs(reason)
  ): void {
    if (!hasWindow() || !getLoggedInPublicKeyHex()) {
      return;
    }

    if (reconnectHealingRunPromise) {
      rememberPendingReconnectHealing(reason);
      return;
    }

    if (deferReconnectHealingWhileStartupRestores(reason)) {
      return;
    }

    const cooldownRemainingMs = getReconnectHealingCooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      rememberPendingReconnectHealing(reason);
      scheduleReconnectHealing(
        reconnectHealingPendingReason ?? reason,
        Math.max(0, Math.floor(delayMs), cooldownRemainingMs),
        { showQueuedLabel: false }
      );
      return;
    }

    scheduleReconnectHealing(reason, Math.max(0, Math.floor(delayMs)), {
      showQueuedLabel: true,
    });
  }

  function scheduleReconnectHealing(
    reason: ReconnectHealingReason,
    delayMs: number,
    options: { showQueuedLabel: boolean }
  ): void {
    if (!hasWindow() || !getLoggedInPublicKeyHex()) {
      return;
    }

    const normalizedDelayMs = Math.max(
      0,
      Math.floor(delayMs),
      getReconnectHealingCooldownRemainingMs()
    );
    const nextScheduledAt = Date.now() + normalizedDelayMs;
    if (
      reconnectHealingTimeoutId !== null &&
      reconnectHealingScheduledAt > 0 &&
      reconnectHealingScheduledAt <= nextScheduledAt
    ) {
      return;
    }

    clearReconnectHealingTimer();
    reconnectHealingScheduledAt = nextScheduledAt;
    const queuedStatusLabel = getReconnectHealingQueuedStatusLabel(reason);
    if (options.showQueuedLabel && reconnectHealingStatusLabel !== queuedStatusLabel) {
      setReconnectHealingStatusLabelNow(queuedStatusLabel);
      setIsReconnectHealing(true);
    }
    logReconnectHealing('queued', {
      reason,
      delayMs: normalizedDelayMs,
    });
    reconnectHealingTimeoutId = globalThis.setTimeout(() => {
      clearReconnectHealingTimer();
      void runReconnectHealing(reason);
    }, normalizedDelayMs);
  }

  async function runReconnectHealing(
    reason: ReconnectHealingReason,
    options: ReconnectHealingRunOptions = {}
  ): Promise<void> {
    if (reconnectHealingRunPromise) {
      rememberPendingReconnectHealing(reason);
      return reconnectHealingRunPromise;
    }

    if (!hasWindow() || !getLoggedInPublicKeyHex()) {
      return;
    }

    const cooldownRemainingMs =
      reason === 'session-resume' ? 0 : getReconnectHealingCooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      rememberPendingReconnectHealing(reason);
      scheduleReconnectHealing(reconnectHealingPendingReason ?? reason, cooldownRemainingMs, {
        showQueuedLabel: false,
      });
      return;
    }

    if (deferReconnectHealingWhileStartupRestores(reason)) {
      return;
    }

    consumePendingReconnectHealing(reason);
    clearReconnectHealingTimer();
    reconnectHealingRunPromise = (async () => {
      await showReconnectHealingStatusLabel(
        reason === 'session-resume'
          ? RECONNECT_HEALING_STATUS_LABELS.resumingSession
          : RECONNECT_HEALING_STATUS_LABELS.preparingSync
      );
      setIsReconnectHealing(true);

      const loggedInPublicKeyHex = getLoggedInPublicKeyHex();
      if (!loggedInPublicKeyHex) {
        logReconnectHealing('skip', {
          reason,
          skipReason: 'missing-login',
          ...getReconnectHealingSessionNetworkSnapshot(),
        });
        return;
      }

      await showReconnectHealingStatusLabel(
        RECONNECT_HEALING_STATUS_LABELS.checkingSessionAndNetwork
      );
      logReconnectHealing('session-network-check', {
        reason,
        ...getReconnectHealingSessionNetworkSnapshot(),
      });
      if (isRestoringStartupState.value && reason !== 'session-resume') {
        logReconnectHealing('skip', {
          reason,
          skipReason: 'startup-restore-in-progress',
          ...getReconnectHealingSessionNetworkSnapshot(),
        });
        rememberPendingReconnectHealing(reason);
        return;
      }

      if (isBrowserOffline()) {
        logReconnectHealing('skip', {
          reason,
          skipReason: 'browser-offline',
          ...getReconnectHealingSessionNetworkSnapshot(),
        });
        return;
      }

      const visibleChatTarget = normalizeChatTarget(getVisibleChatTarget());
      logReconnectHealing('start', {
        reason,
        visibleChatId: visibleChatTarget?.id ?? null,
        visibleChatType: visibleChatTarget?.type ?? null,
        directMessageRecipientPubkey: loggedInPublicKeyHex,
      });

      let refreshedDirectMessages = false;

      if (reason === 'session-resume') {
        await restartSessionSubscriptions(
          inputSanitizerService.normalizeStringArray(options.sessionRelayUrls ?? [])
        );
      }

      await showReconnectHealingStatusLabel(
        RECONNECT_HEALING_STATUS_LABELS.refreshingDirectMessages
      );
      const previousPrivateMessagesLiveEoseAt = getPrivateMessagesLiveEoseAt();
      const directMessagesRefreshResult = await refreshDirectMessages({
        forceLiveSubscriptionRecreate: isNativeAndroid(),
        sinceMode: reason === 'session-resume' ? 'startup' : 'reconnect',
      });
      if (directMessagesRefreshResult.recreatedLiveSubscription) {
        await waitForRefreshedPrivateMessagesLiveEose(previousPrivateMessagesLiveEoseAt);
      }
      refreshedDirectMessages = true;

      await showReconnectHealingStatusLabel(RECONNECT_HEALING_STATUS_LABELS.checkingMessageRelays);
      queuePrivateMessagesWatchdog(0);
      await showReconnectHealingStatusLabel(RECONNECT_HEALING_STATUS_LABELS.retryingUnsentMessages);
      queueOutboundMessageReplay('reconnect-healing', 0);

      await showReconnectHealingStatusLabel(
        RECONNECT_HEALING_STATUS_LABELS.applyingPendingMessageUpdates
      );
      const pendingQueueSummary = await refreshDeveloperPendingQueues();
      await showReconnectHealingStatusLabel(RECONNECT_HEALING_STATUS_LABELS.finishingSync);
      logReconnectHealing('complete', {
        reason,
        refreshedDirectMessages,
        pendingQueueSummary,
      });
    })()
      .catch((error) => {
        console.warn('[nostr-chat][reconnect-healing] failed', {
          reason,
          error: error instanceof Error ? error.message : String(error ?? ''),
        });
        if (options.propagateError === true) {
          throw error;
        }
      })
      .finally(async () => {
        await hideReconnectHealingStatus();
        reconnectHealingRunPromise = null;
        reconnectHealingLastFinishedAt = Date.now();

        if (reconnectHealingPendingReason !== null && getLoggedInPublicKeyHex()) {
          const nextReason = reconnectHealingPendingReason;
          reconnectHealingPendingReason = null;
          scheduleReconnectHealing(nextReason, RECONNECT_HEALING_MIN_INTERVAL_MS, {
            showQueuedLabel: false,
          });
          return;
        }

        reconnectHealingPendingReason = null;
      });

    return reconnectHealingRunPromise;
  }

  function notifyRelayConnected(): void {
    queueReconnectHealing('relay-connected');
  }

  function notifyRelayListChanged(): void {
    queueReconnectHealing('relay-list-changed');
  }

  function resetReconnectHealingRuntimeState(): void {
    clearReconnectHealingTimer();
    reconnectHealingPendingReason = null;
    reconnectHealingRunPromise = null;
    reconnectHealingLastFinishedAt = 0;
    reconnectHealingLastBlurAt = 0;
    reconnectHealingLastHiddenAt = 0;
    setIsReconnectHealing(false);
    setReconnectHealingStatusLabelNow(null);
  }

  return {
    notifyBrowserOnline,
    notifyRelayConnected,
    notifyRelayListChanged,
    notifyVisibilityHidden,
    notifyVisibilityRegain,
    notifyWindowBlur,
    notifyWindowFocus,
    queueReconnectHealing,
    resetReconnectHealingRuntimeState,
    runReconnectHealing,
  };
}
