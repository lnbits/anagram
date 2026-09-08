import { EventEmitter } from 'node:events';
import NDK, { type NDKEvent, type NDKFilter, type NDKSubscription } from '@nostr-dev-kit/ndk';
import { RELAY_QUERY_TIMEOUT_MS } from 'src/stores/nostr/constants';
import { createPrivateMessagesSubscriptionRuntime } from 'src/stores/nostr/privateMessagesSubscriptionRuntime';
import { createStartupRuntime } from 'src/stores/nostr/startupRuntime';
import {
  createInitialStartupStepSnapshots,
  type StartupDisplaySnapshot,
} from 'src/stores/nostr/startupState';
import { observeConnectedRelayEose } from 'src/stores/nostr/subscriptionEose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    init: vi.fn(),
    listChats: vi.fn(async () => []),
  },
  contactsService: {
    listContacts: vi.fn(async () => []),
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
const RELAY_URLS = ['wss://relay.example/'];

type SubscriptionOptions = {
  onEvent?: (event: NDKEvent) => void;
  onEose?: () => void;
  onClose?: () => void;
};

function createRuntime(
  overrides: {
    subscribeWithReqLogging?: ReturnType<typeof vi.fn>;
    refreshAllStoredContacts?: ReturnType<typeof vi.fn>;
    getPrivateMessagesIngestQueue?: () => Promise<void>;
    recipients?: () => Promise<string[]>;
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

  const ndk = new NDK();
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
    getPrivateMessagesIngestQueue: overrides.getPrivateMessagesIngestQueue ?? vi.fn(async () => {}),
    getPrivateMessagesRestoreThrottleMs: () => 0,
    getPrivateMessagesStartupLiveSince: () => 90,
    getRelaySnapshots: vi.fn(() => []),
    getStartupStepSnapshot: startupRuntime.getStartupStepSnapshot,
    getStoredAuthMethod: () => 'nsec',
    isRestoringStartupState: ref(false),
    listPrivateMessageRecipientPubkeys:
      overrides.recipients ?? vi.fn(async () => [LOGGED_IN_PUBLIC_KEY]),
    logSubscription,
    ndk,
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
    ndk,
    refreshAllStoredContacts,
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
    serviceMocks.contactsService.listContacts.mockResolvedValue([]);
    serviceMocks.chatDataService.listChats.mockResolvedValue([]);
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
    await runtime.subscribePrivateMessagesForLoggedInUser(false, { startupTrackStep: true });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
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

  it('starts step 16 after a slow live snapshot when another relay is unavailable', async () => {
    vi.useFakeTimers();
    const healthy = { connected: true };
    const unavailable = { connected: false };
    const subscription = Object.assign(new EventEmitter(), {
      relaySet: { relays: new Set([healthy, unavailable]) },
      eosesSeen: new Set(),
      stop: vi.fn(),
    });
    const subscribeWithReqLogging = vi.fn((_label, _requestLabel, _filters, options) => {
      observeConnectedRelayEose(subscription as unknown as NDKSubscription, options.onEose);
      return subscription as never;
    });
    const { runtime, startPrivateMessagesStartupBackfill, startupRuntime } = createRuntime({
      subscribeWithReqLogging,
    });
    await runtime.subscribePrivateMessagesForLoggedInUser(false, { startupTrackStep: true });
    runtime.startPrivateMessagesHistoryRestore();
    await vi.advanceTimersByTimeAsync(RELAY_QUERY_TIMEOUT_MS + 1000);
    expect(startPrivateMessagesStartupBackfill).not.toHaveBeenCalled();

    subscription.eosesSeen.add(healthy);
    await vi.advanceTimersByTimeAsync(100);
    expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledExactlyOnceWith(
      LOGGED_IN_PUBLIC_KEY,
      [LOGGED_IN_PUBLIC_KEY],
      RELAY_URLS,
      90
    );
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success'
    );
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
    expect(subscription.stop).not.toHaveBeenCalled();
    expect(subscription.listenerCount('eose')).toBe(0);
    expect(subscription.listenerCount('close')).toBe(0);
  });

  it('does not leave history waiting on a listener that failed to start', async () => {
    const { runtime, startupRuntime } = createRuntime({
      subscribeWithReqLogging: vi.fn(() => {
        throw new Error('Subscription failed');
      }),
    });
    await expect(
      runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true })
    ).rejects.toThrow('Subscription failed');
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'error'
    );
    expect(() => runtime.startPrivateMessagesHistoryRestore()).toThrow(
      'Start the message listener'
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
      getPrivateMessagesIngestQueue: refreshAllStoredContacts,
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

  it('creates a missing live subscription without an extra probe', async () => {
    const { privateMessagesSubscriptionLiveCoverageAt, runtime, subscribeWithReqLogging } =
      createRuntime();

    const result = await runtime.refreshPrivateMessagesLiveSubscription({
      sinceOverride: 123,
      probeTimeoutMs: 10,
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
      expect.not.objectContaining({ closeOnEose: true }),
      expect.any(Object)
    );
    expect(privateMessagesSubscriptionLiveCoverageAt.value).toBeGreaterThan(0);
  });

  it('reconnects transport without probing or replacing the healthy subscription', async () => {
    const { runtime, subscribeWithReqLogging } = createRuntime();
    await runtime.subscribePrivateMessagesForLoggedInUser();
    const result = await runtime.refreshPrivateMessagesLiveSubscription({ sinceOverride: 123 });
    expect(result).toEqual({ recreatedLiveSubscription: false });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent requests and keeps healthy listeners through resume without querying contacts or probing', async () => {
    const { runtime, ndk, subscribeWithReqLogging, refreshAllStoredContacts } = createRuntime();
    vi.spyOn(ndk.pool, 'getRelay').mockReturnValue({ connected: true } as never);
    await Promise.all([
      runtime.subscribePrivateMessagesForLoggedInUser(),
      runtime.subscribePrivateMessagesForLoggedInUser(),
    ]);
    const subscription = runtime.getPrivateMessagesSubscription();
    await runtime.refreshPrivateMessagesLiveSubscription();
    await runtime.refreshPrivateMessagesLiveSubscription();
    runtime.startPrivateMessagesHistoryRestore();
    await Promise.resolve();
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
    expect(subscription?.stop).not.toHaveBeenCalled();
    expect(refreshAllStoredContacts).not.toHaveBeenCalled();
  });

  it('changes only the affected epoch recipient and routes it only to its group relay', async () => {
    const group = 'b'.repeat(64),
      epochA = 'c'.repeat(64),
      epochB = 'd'.repeat(64);
    let epoch = epochA;
    serviceMocks.contactsService.listContacts.mockResolvedValue([
      { public_key: group, relays: [{ url: 'wss://group.test/', read: true, write: true }] },
    ] as never);
    serviceMocks.chatDataService.listChats.mockImplementation(
      async () =>
        [
          {
            public_key: group,
            type: 'group',
            meta: {
              group_epoch_keys: [
                {
                  epoch_number: 1,
                  epoch_public_key: epoch,
                  epoch_private_key_encrypted: 'local cipher',
                },
              ],
            },
          },
        ] as never
    );
    const { runtime, subscribeWithReqLogging } = createRuntime({
      recipients: async () => [LOGGED_IN_PUBLIC_KEY, epoch],
    });
    await runtime.subscribePrivateMessagesForLoggedInUser();
    const userStop = subscribeWithReqLogging.mock.results[0]?.value.stop;
    epoch = epochB;
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { sinceOverride: 0 });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(3);
    expect(userStop).not.toHaveBeenCalled();
    expect(subscribeWithReqLogging.mock.calls[0]?.[3].relaySet.relayUrls).toEqual(RELAY_URLS);
    expect(subscribeWithReqLogging.mock.calls[2]?.[3].relaySet.relayUrls).toEqual([
      'wss://group.test/',
    ]);
  });
});
