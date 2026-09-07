import NDK, { type NDKEvent, type NDKFilter } from '@nostr-dev-kit/ndk';
import { createPrivateMessagesSubscriptionRuntime } from 'src/stores/nostr/privateMessagesSubscriptionRuntime';
import { createStartupRuntime } from 'src/stores/nostr/startupRuntime';
import {
  createInitialStartupStepSnapshots,
  type StartupDisplaySnapshot,
} from 'src/stores/nostr/startupState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    init: vi.fn(),
  },
  contactsService: {
    init: vi.fn(),
  },
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: serviceMocks.contactsService,
}));

const LOGGED_IN_PUBLIC_KEY = 'a'.repeat(64);
const RELAY_URLS = ['wss://relay.example'];

type SubscriptionOptions = {
  onEvent?: (event: NDKEvent) => void;
  onEose?: () => void;
  onClose?: () => void;
};

function createRuntime(
  overrides: {
    subscribeWithReqLogging?: ReturnType<typeof vi.fn>;
    refreshAllStoredContacts?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const privateMessagesSubscriptionLiveCoverageAt = ref<number | null>(null);
  const subscribeWithReqLogging =
    overrides.subscribeWithReqLogging ??
    vi.fn(
      (
        _label: string,
        _requestLabel: string,
        _filters: NDKFilter,
        options: SubscriptionOptions
      ) => {
        Promise.resolve().then(() => {
          options.onEose?.();
        });

        return {
          stop: vi.fn(),
        } as never;
      }
    );

  const logSubscription = vi.fn();
  const startupRuntime = createStartupRuntime({
    startupSteps: ref(createInitialStartupStepSnapshots()),
    startupDisplay: ref<StartupDisplaySnapshot>({
      stepId: null,
      label: null,
      status: null,
      showProgress: false,
    }),
    startupState: { startupDisplayShownAt: 0, startupDisplayTimer: null, startupDisplayToken: 0 },
    startupStepMinProgressMs: 0,
  });
  const refreshAllStoredContacts = overrides.refreshAllStoredContacts ?? vi.fn(async () => ({}));
  const startPrivateMessagesStartupBackfill = vi.fn();
  const queuePrivateMessageIngestion = vi.fn();
  const runtime = createPrivateMessagesSubscriptionRuntime({
    beginStartupStep: startupRuntime.beginStartupStep,
    buildFilterSinceDetails: (since) => ({ since }),
    buildPrivateMessageSubscriptionTargetDetails: vi.fn(async () => ({})),
    buildSubscriptionEventDetails: vi.fn(() => ({})),
    buildSubscriptionRelayDetails: (relayUrls) => ({ relayUrls }),
    bumpDeveloperDiagnosticsVersion: vi.fn(),
    clearPrivateMessagesUiRefreshState: vi.fn(),
    completeStartupStep: startupRuntime.completeStartupStep,
    ensureRelayConnections: vi.fn(async () => {}),
    extractRelayUrlsFromEvent: vi.fn(() => RELAY_URLS),
    failStartupStep: startupRuntime.failStartupStep,
    flushPrivateMessagesUiRefreshNow: vi.fn(),
    formatSubscriptionLogValue: (value) => value ?? null,
    getFilterSince: () => 100,
    getLoggedInPublicKeyHex: () => LOGGED_IN_PUBLIC_KEY,
    getOrCreateSigner: vi.fn(async () => ({})),
    getPrivateMessagesIngestQueue: vi.fn(async () => {}),
    getPrivateMessagesRestoreThrottleMs: () => 0,
    getPrivateMessagesStartupLiveSince: () => 90,
    getRelaySnapshots: vi.fn(() => []),
    getStartupStepSnapshot: startupRuntime.getStartupStepSnapshot,
    getStoredAuthMethod: () => 'nsec',
    isRestoringStartupState: ref(false),
    listPrivateMessageRecipientPubkeys: vi.fn(async () => [LOGGED_IN_PUBLIC_KEY]),
    logSubscription,
    ndk: new NDK(),
    normalizeEventId: (value) => (typeof value === 'string' ? value : null),
    normalizeRelayStatusUrls: (relayUrls) => relayUrls,
    normalizeThrottleMs: (value) => (typeof value === 'number' ? value : 0),
    privateMessagesSubscriptionLastEoseAt: ref(null),
    privateMessagesSubscriptionLastEventCreatedAt: ref(null),
    privateMessagesSubscriptionLastEventId: ref(null),
    privateMessagesSubscriptionLastEventSeenAt: ref(null),
    privateMessagesSubscriptionLiveCoverageAt,
    privateMessagesSubscriptionRelayUrls: ref([]),
    privateMessagesSubscriptionSince: ref(null),
    privateMessagesSubscriptionStartedAt: ref(null),
    queuePrivateMessageIngestion,
    refreshAllStoredContacts,
    relaySignature: (relayUrls) => relayUrls.join(','),
    resolvePrivateMessageReadRelayUrls: vi.fn(async () => RELAY_URLS),
    schedulePostPrivateMessagesEoseChecks: vi.fn(),
    setPrivateMessagesRestoreThrottleMs: vi.fn(),
    startPrivateMessagesStartupBackfill,
    subscribeWithReqLogging,
    updateStoredEventSinceFromCreatedAt: vi.fn(),
    updateStoredPrivateMessagesLastReceivedFromCreatedAt: vi.fn(),
  });

  return {
    logSubscription,
    privateMessagesSubscriptionLiveCoverageAt,
    runtime,
    startupRuntime,
    startPrivateMessagesStartupBackfill,
    queuePrivateMessageIngestion,
    subscribeWithReqLogging,
  };
}

describe('privateMessagesSubscriptionRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('listens independently and starts history only when step 16 is requested', async () => {
    const {
      runtime,
      startupRuntime,
      startPrivateMessagesStartupBackfill,
      subscribeWithReqLogging,
    } = createRuntime();
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true });

    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success'
    );
    expect(startupRuntime.getStartupStepSnapshot('message-history-restore').status).toBe('pending');
    expect(startPrivateMessagesStartupBackfill).not.toHaveBeenCalled();

    runtime.startPrivateMessagesHistoryRestore();
    await vi.waitFor(() =>
      expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledWith(
        LOGGED_IN_PUBLIC_KEY,
        [LOGGED_IN_PUBLIC_KEY],
        RELAY_URLS,
        90
      )
    );
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success'
    );
    expect(startupRuntime.getStartupStepSnapshot('message-history-restore').status).toBe(
      'in_progress'
    );

    runtime.startPrivateMessagesHistoryRestore();
    await vi.waitFor(() => expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(2));
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
  });

  it('waits for live EOSE before history and keeps receiving new messages afterward', async () => {
    let liveOptions: SubscriptionOptions = {};
    const subscribeWithReqLogging = vi.fn((_label, _requestLabel, _filters, options) => {
      liveOptions = options;
      return { stop: vi.fn() } as never;
    });
    const {
      runtime,
      startupRuntime,
      startPrivateMessagesStartupBackfill,
      queuePrivateMessageIngestion,
    } = createRuntime({ subscribeWithReqLogging });
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true });
    runtime.startPrivateMessagesHistoryRestore();
    expect(startPrivateMessagesStartupBackfill).not.toHaveBeenCalled();
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'in_progress'
    );

    liveOptions.onEose?.();
    await vi.waitFor(() => expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(1));
    liveOptions.onEose?.();
    liveOptions.onEvent?.({
      id: 'b'.repeat(64),
      kind: 1059,
      created_at: 100,
      pubkey: LOGGED_IN_PUBLIC_KEY,
      tags: [],
      content: '',
    } as NDKEvent);
    expect(queuePrivateMessageIngestion).toHaveBeenCalledTimes(1);
    expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(1);
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success'
    );
  });

  it('does not start history after logout interrupts preparation', async () => {
    let finishRefresh = () => {};
    const refreshAllStoredContacts = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    const { runtime, startPrivateMessagesStartupBackfill } = createRuntime({
      refreshAllStoredContacts,
    });
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true });
    runtime.startPrivateMessagesHistoryRestore();
    await vi.waitFor(() => expect(refreshAllStoredContacts).toHaveBeenCalled());
    runtime.stopPrivateMessagesLiveSubscription('logout');
    runtime.resetPrivateMessagesSubscriptionRuntimeState();
    finishRefresh();
    await Promise.resolve();
    expect(startPrivateMessagesStartupBackfill).not.toHaveBeenCalled();
    expect(() => runtime.startPrivateMessagesHistoryRestore()).toThrow(
      'Start the message listener'
    );
  });

  it('recreates the live subscription directly when forced', async () => {
    const { runtime, subscribeWithReqLogging } = createRuntime();

    const result = await runtime.refreshPrivateMessagesLiveSubscription({
      forceRecreate: true,
      sinceOverride: 123,
    });

    expect(result).toEqual({ recreatedLiveSubscription: true });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
    expect(subscribeWithReqLogging).toHaveBeenCalledWith(
      'private-messages',
      'private-messages-live',
      expect.objectContaining({
        '#p': [LOGGED_IN_PUBLIC_KEY],
        since: 123,
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('keeps the live subscription when the probe reaches EOSE', async () => {
    const { privateMessagesSubscriptionLiveCoverageAt, runtime, subscribeWithReqLogging } =
      createRuntime();

    const result = await runtime.refreshPrivateMessagesLiveSubscription({
      sinceOverride: 123,
      probeTimeoutMs: 10,
    });

    expect(result).toEqual({ recreatedLiveSubscription: false });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
    expect(subscribeWithReqLogging).toHaveBeenCalledWith(
      'private-messages',
      'private-messages-live-probe',
      expect.objectContaining({
        '#p': [LOGGED_IN_PUBLIC_KEY],
        since: 123,
      }),
      expect.objectContaining({
        closeOnEose: true,
      }),
      expect.any(Object)
    );
    expect(privateMessagesSubscriptionLiveCoverageAt.value).toBeGreaterThan(0);
  });

  it('recreates the live subscription when the probe times out', async () => {
    vi.useFakeTimers();
    const subscribeWithReqLogging = vi.fn(
      (_label: string, _requestLabel: string, _filters: NDKFilter, _options: SubscriptionOptions) =>
        ({
          stop: vi.fn(),
        }) as never
    );
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
    });

    const refreshPromise = runtime.refreshPrivateMessagesLiveSubscription({
      sinceOverride: 123,
      probeTimeoutMs: 10,
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10);
    const result = await refreshPromise;

    expect(result).toEqual({ recreatedLiveSubscription: true });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(2);
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      1,
      'private-messages',
      'private-messages-live-probe',
      expect.objectContaining({
        '#p': [LOGGED_IN_PUBLIC_KEY],
        since: 123,
      }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      2,
      'private-messages',
      'private-messages-live',
      expect.objectContaining({
        '#p': [LOGGED_IN_PUBLIC_KEY],
        since: 123,
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });
});
