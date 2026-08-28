import {
  createReconnectHealingRuntime,
  type ReconnectHealingChatTarget,
} from 'src/stores/nostr/reconnectHealingRuntime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const GROUP_PUBLIC_KEY = 'a'.repeat(64);
const GROUP_EPOCH_PUBLIC_KEY = 'b'.repeat(64);
const LOGGED_IN_PUBLIC_KEY = 'f'.repeat(64);
const MIN_STATUS_VISIBLE_MS = 500;

type StatusLabelUpdate = {
  at: number;
  value: string | null;
};

describe('reconnectHealingRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      onLine: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function createRuntime(
    options: {
      visibleChat?: ReconnectHealingChatTarget | null;
      isRestoringStartupState?: boolean;
      isNativeAndroid?: boolean;
      refreshRecreatedLiveSubscription?: boolean;
      refreshDirectMessages?: () => Promise<{ recreatedLiveSubscription: boolean }>;
    } = {}
  ) {
    let privateMessagesLiveEoseAt: string | null = null;
    const healingState = ref(false);
    const statusLabel = ref<string | null>(null);
    const statusLabelUpdates: StatusLabelUpdate[] = [];
    const queueOutboundMessageReplay = vi.fn();
    const queuePrivateMessagesWatchdog = vi.fn();
    const refreshDeveloperPendingQueues = vi.fn(async () => ({
      initialEntryCount: 1,
      remainingEntryCount: 0,
    }));
    const refreshDirectMessages = vi.fn(
      options.refreshDirectMessages ??
        (async () => ({
          recreatedLiveSubscription: options.refreshRecreatedLiveSubscription ?? false,
        }))
    );
    const restartSessionSubscriptions = vi.fn(async (_relayUrls: string[]) => {});
    const waitForPrivateMessagesIngestQueue = vi.fn(async () => {});
    const isRestoringStartupState = ref(options.isRestoringStartupState ?? false);

    const runtime = createReconnectHealingRuntime({
      getLoggedInPublicKeyHex: () => LOGGED_IN_PUBLIC_KEY,
      getPrivateMessagesLiveEoseAt: () => privateMessagesLiveEoseAt,
      getVisibleChatTarget: () => options.visibleChat ?? null,
      isNativeAndroid: () => options.isNativeAndroid ?? false,
      isRestoringStartupState,
      queueOutboundMessageReplay,
      queuePrivateMessagesWatchdog,
      refreshDeveloperPendingQueues,
      refreshDirectMessages,
      restartSessionSubscriptions,
      setIsReconnectHealing: (value) => {
        healingState.value = value;
      },
      setReconnectHealingStatusLabel: (value) => {
        statusLabel.value = value;
        statusLabelUpdates.push({
          at: Date.now(),
          value,
        });
      },
      waitForPrivateMessagesIngestQueue,
    });

    return {
      healingState,
      statusLabel,
      statusLabelUpdates,
      setPrivateMessagesLiveEoseAt: (value: string | null) => {
        privateMessagesLiveEoseAt = value;
      },
      setIsRestoringStartupState: (value: boolean) => {
        isRestoringStartupState.value = value;
      },
      queueOutboundMessageReplay,
      queuePrivateMessagesWatchdog,
      refreshDeveloperPendingQueues,
      refreshDirectMessages,
      restartSessionSubscriptions,
      runtime,
      waitForPrivateMessagesIngestQueue,
    };
  }

  async function runQueuedTimersForStatusSteps(stepCount: number): Promise<void> {
    for (let index = 0; index < stepCount; index += 1) {
      await vi.advanceTimersByTimeAsync(MIN_STATUS_VISIBLE_MS);
      await vi.runAllTicks();
    }
  }

  function expectStatusLabels(
    statusLabelUpdates: StatusLabelUpdate[],
    labels: Array<string | null>
  ) {
    expect(statusLabelUpdates.map((entry) => entry.value)).toEqual(labels);
  }

  function expectStatusLabelsWereVisibleForMinimumDuration(
    statusLabelUpdates: StatusLabelUpdate[]
  ): void {
    for (let index = 0; index < statusLabelUpdates.length - 1; index += 1) {
      const current = statusLabelUpdates[index];
      const next = statusLabelUpdates[index + 1];
      if (current.value === null) {
        continue;
      }

      expect(next.at - current.at).toBeGreaterThanOrEqual(MIN_STATUS_VISIBLE_MS);
    }
  }

  it('refreshes direct messages and logs the recovery pass', async () => {
    const visibleChat: ReconnectHealingChatTarget = {
      id: GROUP_PUBLIC_KEY,
      publicKey: GROUP_PUBLIC_KEY,
      type: 'group',
      epochPublicKey: GROUP_EPOCH_PUBLIC_KEY,
    };
    const {
      healingState,
      queueOutboundMessageReplay,
      queuePrivateMessagesWatchdog,
      refreshDeveloperPendingQueues,
      refreshDirectMessages,
      runtime,
      statusLabelUpdates,
    } = createRuntime({
      visibleChat,
    });

    const runPromise = runtime.runReconnectHealing('relay-connected');
    await runQueuedTimersForStatusSteps(10);
    await runPromise;

    expect(healingState.value).toBe(false);
    expectStatusLabels(statusLabelUpdates, [
      'sync.preparing',
      'sync.checkingSessionNetwork',
      'sync.refreshingDirectMessages',
      'sync.checkingMessageRelays',
      'sync.retryingUnsentMessages',
      'sync.applyingPendingMessageUpdates',
      'sync.finishing',
      null,
    ]);
    expectStatusLabelsWereVisibleForMinimumDuration(statusLabelUpdates);
    expect(queuePrivateMessagesWatchdog).toHaveBeenCalledWith(0);
    expect(queueOutboundMessageReplay).toHaveBeenCalledWith('reconnect-healing', 0);
    expect(refreshDirectMessages).toHaveBeenCalledWith({
      forceLiveSubscriptionRecreate: false,
      sinceMode: 'reconnect',
    });
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      '[nostr-chat][reconnect-healing]',
      'start',
      expect.objectContaining({
        reason: 'relay-connected',
        visibleChatId: GROUP_PUBLIC_KEY,
        directMessageRecipientPubkey: LOGGED_IN_PUBLIC_KEY,
      })
    );
    expect(console.log).toHaveBeenCalledWith(
      '[nostr-chat][reconnect-healing]',
      'complete',
      expect.objectContaining({
        reason: 'relay-connected',
        refreshedDirectMessages: true,
      })
    );
  });

  it('forces the private messages live subscription rebuild during Android healing', async () => {
    const { refreshDirectMessages, runtime, statusLabelUpdates } = createRuntime({
      isNativeAndroid: true,
    });

    const runPromise = runtime.runReconnectHealing('visibility-regain');
    await runQueuedTimersForStatusSteps(8);
    await runPromise;

    expect(refreshDirectMessages).toHaveBeenCalledWith({
      forceLiveSubscriptionRecreate: true,
      sinceMode: 'reconnect',
    });
    expectStatusLabelsWereVisibleForMinimumDuration(statusLabelUpdates);
  });

  it('restarts persisted session subscriptions during a lightweight resume', async () => {
    const { refreshDirectMessages, restartSessionSubscriptions, runtime, statusLabelUpdates } =
      createRuntime({
        isNativeAndroid: true,
      });

    const runPromise = runtime.runReconnectHealing('session-resume', {
      propagateError: true,
      sessionRelayUrls: ['wss://relay.one/'],
    });
    await runQueuedTimersForStatusSteps(8);
    await runPromise;

    expect(restartSessionSubscriptions).toHaveBeenCalledWith(['wss://relay.one/']);
    expect(refreshDirectMessages).toHaveBeenCalledWith({
      forceLiveSubscriptionRecreate: true,
      sinceMode: 'startup',
    });
    expectStatusLabels(statusLabelUpdates, [
      'sync.resumingSession',
      'sync.checkingSessionNetwork',
      'sync.refreshingDirectMessages',
      'sync.checkingMessageRelays',
      'sync.retryingUnsentMessages',
      'sync.applyingPendingMessageUpdates',
      'sync.finishing',
      null,
    ]);
  });

  it('waits for live private-message EOSE after a recreated subscription', async () => {
    const {
      refreshDeveloperPendingQueues,
      runtime,
      setPrivateMessagesLiveEoseAt,
      waitForPrivateMessagesIngestQueue,
    } = createRuntime({
      isNativeAndroid: true,
      refreshRecreatedLiveSubscription: true,
    });

    const runPromise = runtime.runReconnectHealing('visibility-regain');
    await runQueuedTimersForStatusSteps(3);
    expect(refreshDeveloperPendingQueues).not.toHaveBeenCalled();

    setPrivateMessagesLiveEoseAt('2026-05-05T10:00:00.000Z');
    await vi.advanceTimersByTimeAsync(100);
    await runQueuedTimersForStatusSteps(5);
    await runPromise;

    expect(waitForPrivateMessagesIngestQueue).toHaveBeenCalledTimes(1);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
  });

  it('continues healing after the live private-message EOSE wait times out', async () => {
    const { refreshDeveloperPendingQueues, runtime, waitForPrivateMessagesIngestQueue } =
      createRuntime({
        isNativeAndroid: true,
        refreshRecreatedLiveSubscription: true,
      });

    const runPromise = runtime.runReconnectHealing('visibility-regain');
    await runQueuedTimersForStatusSteps(3);
    expect(refreshDeveloperPendingQueues).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await runQueuedTimersForStatusSteps(5);
    await runPromise;

    expect(waitForPrivateMessagesIngestQueue).not.toHaveBeenCalled();
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
  });

  it('defers a queued healing pass silently while startup restore is running', async () => {
    const {
      refreshDeveloperPendingQueues,
      refreshDirectMessages,
      runtime,
      setIsRestoringStartupState,
      statusLabelUpdates,
    } = createRuntime();

    runtime.notifyRelayListChanged();
    expectStatusLabels(statusLabelUpdates, ['sync.started:sync.reason.relayListChanged']);

    setIsRestoringStartupState(true);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.runAllTicks();

    expect(refreshDirectMessages).not.toHaveBeenCalled();
    expect(refreshDeveloperPendingQueues).not.toHaveBeenCalled();
    expectStatusLabels(statusLabelUpdates, ['sync.started:sync.reason.relayListChanged', null]);
    expect(statusLabelUpdates.map((entry) => entry.value)).not.toContain(
      'Checking session and network'
    );
    expect(console.log).toHaveBeenCalledWith(
      '[nostr-chat][reconnect-healing]',
      'deferred',
      expect.objectContaining({
        reason: 'relay-list-changed',
        deferReason: 'startup-restore-in-progress',
      })
    );

    setIsRestoringStartupState(false);
    await vi.advanceTimersByTimeAsync(1000);
    await runQueuedTimersForStatusSteps(8);

    expect(refreshDirectMessages).toHaveBeenCalledTimes(1);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
    expect(statusLabelUpdates.map((entry) => entry.value)).toEqual([
      'sync.started:sync.reason.relayListChanged',
      null,
      'sync.preparing',
      'sync.checkingSessionNetwork',
      'sync.refreshingDirectMessages',
      'sync.checkingMessageRelays',
      'sync.retryingUnsentMessages',
      'sync.applyingPendingMessageUpdates',
      'sync.finishing',
      null,
    ]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshDirectMessages).toHaveBeenCalledTimes(1);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
  });

  it('coalesces triggers during active healing into one follow-up pass', async () => {
    let releaseFirstRefresh: (() => void) | null = null;
    const firstRefreshPromise = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let refreshCount = 0;
    const refreshDirectMessages = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 1) {
        await firstRefreshPromise;
      }

      return { recreatedLiveSubscription: false };
    });
    const { refreshDeveloperPendingQueues, runtime, statusLabelUpdates } = createRuntime({
      refreshDirectMessages,
    });

    const runPromise = runtime.runReconnectHealing('visibility-regain');
    await runQueuedTimersForStatusSteps(3);
    expect(refreshDirectMessages).toHaveBeenCalledTimes(1);

    runtime.notifyRelayConnected();
    runtime.notifyRelayListChanged();
    releaseFirstRefresh?.();
    await runQueuedTimersForStatusSteps(5);
    await runPromise;

    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(refreshDirectMessages).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await runQueuedTimersForStatusSteps(8);

    expect(refreshDirectMessages).toHaveBeenCalledTimes(2);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(2);
    expect(statusLabelUpdates.map((entry) => entry.value)).not.toContain(
      'Sync started: relay connected'
    );
  });

  it('delays a cooldown trigger until ten seconds after the previous run finishes', async () => {
    const { refreshDeveloperPendingQueues, refreshDirectMessages, runtime, statusLabelUpdates } =
      createRuntime();

    const firstRunPromise = runtime.runReconnectHealing('visibility-regain');
    await runQueuedTimersForStatusSteps(8);
    await firstRunPromise;
    expect(refreshDirectMessages).toHaveBeenCalledTimes(1);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);

    runtime.notifyRelayConnected();
    await vi.advanceTimersByTimeAsync(9999);
    expect(refreshDirectMessages).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await runQueuedTimersForStatusSteps(8);

    expect(refreshDirectMessages).toHaveBeenCalledTimes(2);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(2);
    expect(statusLabelUpdates.map((entry) => entry.value).filter(Boolean)).not.toContain(
      'Sync started: relay connected'
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshDirectMessages).toHaveBeenCalledTimes(2);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(2);
  });

  it('runs healing when a window-focus notifier follows a long enough background period', async () => {
    const { refreshDeveloperPendingQueues, runtime, statusLabelUpdates } = createRuntime();

    runtime.notifyWindowBlur();
    await vi.advanceTimersByTimeAsync(3000);
    runtime.notifyWindowFocus();
    expectStatusLabels(statusLabelUpdates, ['sync.started:sync.reason.windowFocus']);
    await vi.advanceTimersByTimeAsync(750);
    await runQueuedTimersForStatusSteps(10);
    runtime.resetReconnectHealingRuntimeState();

    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
    expectStatusLabelsWereVisibleForMinimumDuration(statusLabelUpdates);
  });
});
