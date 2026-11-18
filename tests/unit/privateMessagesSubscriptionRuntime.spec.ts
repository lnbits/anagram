import NostrClient, { type ClientEvent, type NostrFilter } from '#src/lib/nostr/client.ts';
import { RELAY_QUERY_TIMEOUT_MS } from '#src/stores/nostr/constants.ts';
import { createPrivateMessagesSubscriptionRuntime } from '#src/stores/nostr/privateMessagesSubscriptionRuntime.ts';
import { createStartupRuntime } from '#src/stores/nostr/startupRuntime.ts';
import {
  createInitialStartupStepSnapshots,
  type StartupDisplaySnapshot,
} from '#src/stores/nostr/startupState.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: serviceMocks.contactsService,
}));

const LOGGED_IN_PUBLIC_KEY = 'a'.repeat(64);
const RELAY_URLS = ['wss://relay.example/'];

type SubscriptionOptions = {
  onEvent?: (event: ClientEvent) => void;
  onEose?: () => void;
  onInitialSync?: (completed: string[], pending: string[]) => void;
  onClose?: () => void;
};

function createRuntime(
  overrides: {
    subscribeWithReqLogging?: ReturnType<typeof vi.fn>;
    refreshAllStoredContacts?: ReturnType<typeof vi.fn>;
    getPrivateMessagesIngestQueue?: () => Promise<void>;
    recipients?: () => Promise<string[]>;
  } = {},
) {
  let privateMessagesSubscriptionLiveCoverageAt: number | null = null;
  const subscribeWithReqLogging =
    overrides.subscribeWithReqLogging ??
    vi.fn(
      (
        _label: string,
        _requestLabel: string,
        _filters: NostrFilter,
        options: SubscriptionOptions,
      ) => {
        Promise.resolve().then(() => {
          options.onEose?.();
        });

        return {
          stop: vi.fn(),
        } as never;
      },
    );

  const ndk = new NostrClient();
  const logSubscription = vi.fn();
  const startupRuntime = createStartupRuntime({
    startupSteps: createInitialStartupStepSnapshots(),
    startupDisplay: {
      stepId: null,
      label: null,
      status: null,
      showProgress: false,
    },
    startupState: {
      startupDisplayShownAt: 0,
      startupDisplayTimer: null,
      startupDisplayToken: 0,
    },
    startupStepMinProgressMs: 0,
  });
  const refreshAllStoredContacts =
    overrides.refreshAllStoredContacts ?? vi.fn(async () => ({}));
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
    getPrivateMessagesIngestQueue:
      overrides.getPrivateMessagesIngestQueue ?? vi.fn(async () => {}),
    getPrivateMessagesRestoreThrottleMs: () => 0,
    getPrivateMessagesStartupLiveSince: () => 90,
    getRelaySnapshots: vi.fn(() => []),
    getStartupStepSnapshot: startupRuntime.getStartupStepSnapshot,
    getStoredAuthMethod: () => 'nsec',
    isRestoringStartupState: false,
    listPrivateMessageRecipientPubkeys:
      overrides.recipients ?? vi.fn(async () => [LOGGED_IN_PUBLIC_KEY]),
    logSubscription,
    ndk,
    normalizeEventId: (value) => (typeof value === 'string' ? value : null),
    normalizeRelayStatusUrls: (relayUrls) => relayUrls,
    normalizeThrottleMs: (value) => (typeof value === 'number' ? value : 0),
    privateMessagesSubscriptionLastEoseAt: null,
    privateMessagesSubscriptionLastEventCreatedAt: null,
    privateMessagesSubscriptionLastEventId: null,
    privateMessagesSubscriptionLastEventSeenAt: null,
    get privateMessagesSubscriptionLiveCoverageAt() {
      return privateMessagesSubscriptionLiveCoverageAt;
    },
    set privateMessagesSubscriptionLiveCoverageAt(value) {
      privateMessagesSubscriptionLiveCoverageAt = value;
    },
    privateMessagesSubscriptionRelayUrls: [],
    privateMessagesSubscriptionSince: null,
    privateMessagesSubscriptionStartedAt: null,
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
    get privateMessagesSubscriptionLiveCoverageAt() {
      return privateMessagesSubscriptionLiveCoverageAt;
    },
    set privateMessagesSubscriptionLiveCoverageAt(value) {
      privateMessagesSubscriptionLiveCoverageAt = value;
    },
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

  it.each(['before login', 'while healthy'])(
    'keeps the watchdog usable after a synchronous check %s',
    async (phase) => {
      vi.useFakeTimers();
      vi.stubGlobal('window', new EventTarget());
      const { runtime, ndk, subscribeWithReqLogging, queuePrivateMessageIngestion } =
        createRuntime();
      vi.spyOn(ndk.pool, 'getRelay').mockReturnValue({ connected: true } as never);
      try {
        if (phase === 'while healthy') await runtime.subscribePrivateMessagesForLoggedInUser();
        runtime.queuePrivateMessagesWatchdog(0);
        await vi.advanceTimersByTimeAsync(0);
        if (phase === 'before login') await runtime.subscribePrivateMessagesForLoggedInUser();
        expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
        const options = subscribeWithReqLogging.mock.calls[0][3] as SubscriptionOptions;
        options.onClose?.();
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribeWithReqLogging).toHaveBeenCalledTimes(2);
        const restored = subscribeWithReqLogging.mock.calls[1][3] as SubscriptionOptions;
        restored.onEvent?.({ id: 'b'.repeat(64), kind: 1059, created_at: 100 } as ClientEvent);
        expect(queuePrivateMessageIngestion).toHaveBeenCalledTimes(1);
      } finally {
        runtime.stopPrivateMessagesLiveSubscription('test');
        runtime.resetPrivateMessagesSubscriptionRuntimeState();
        vi.clearAllTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it('listens independently and starts history only when step 16 is requested', async () => {
    const {
      runtime,
      startupRuntime,
      startPrivateMessagesStartupBackfill,
      subscribeWithReqLogging,
    } = createRuntime();
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true });

    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success',
    );
    expect(startupRuntime.getStartupStepSnapshot('message-history-restore').status).toBe(
      'pending',
    );
    expect(startPrivateMessagesStartupBackfill).not.toHaveBeenCalled();

    runtime.startPrivateMessagesHistoryRestore();
    await vi.waitFor(() =>
      expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledWith(
        LOGGED_IN_PUBLIC_KEY,
        [LOGGED_IN_PUBLIC_KEY],
        RELAY_URLS,
        90,
      ),
    );
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success',
    );
    expect(startupRuntime.getStartupStepSnapshot('message-history-restore').status).toBe(
      'in_progress',
    );

    runtime.startPrivateMessagesHistoryRestore();
    await vi.waitFor(() =>
      expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(2),
    );
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
  });

  it('starts history before live EOSE and keeps receiving new messages afterward', async () => {
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
    expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(1);
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'in_progress',
    );

    liveOptions.onEose?.();
    await vi.waitFor(() =>
      expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(1),
    );
    liveOptions.onEose?.();
    liveOptions.onEvent?.({
      id: 'b'.repeat(64),
      kind: 1059,
      created_at: 100,
      pubkey: LOGGED_IN_PUBLIC_KEY,
      tags: [],
      content: '',
    } as ClientEvent);
    expect(queuePrivateMessageIngestion).toHaveBeenCalledTimes(1);
    expect(queuePrivateMessageIngestion).toHaveBeenCalledWith(
      expect.anything(),
      LOGGED_IN_PUBLIC_KEY,
      { priority: 'foreground', live: true },
    );
    expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(1);
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success',
    );
  });

  it('reports partial startup without complete coverage, continues history and accepts late recovery', async () => {
    let options!: SubscriptionOptions;
    const stop = vi.fn();
    const subscribeWithReqLogging = vi.fn((_label, _requestLabel, _filters, handlers) => {
      options = handlers;
      return { stop } as never;
    });
    const context = createRuntime({ subscribeWithReqLogging });
    const { runtime, startupRuntime, startPrivateMessagesStartupBackfill } = context;
    await runtime.subscribePrivateMessagesForLoggedInUser(false, { startupTrackStep: true });
    runtime.startPrivateMessagesHistoryRestore();
    options.onInitialSync?.(RELAY_URLS, ['wss://unavailable.example/']);
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'partial',
    );
    expect(context.privateMessagesSubscriptionLiveCoverageAt).toBeNull();
    expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();

    const event = {
      id: 'a'.repeat(64),
      relay: { url: RELAY_URLS[0] },
      created_at: 100,
    } as ClientEvent;
    options.onEvent?.(event);
    expect(context.queuePrivateMessageIngestion).toHaveBeenLastCalledWith(
      expect.objectContaining(event),
      LOGGED_IN_PUBLIC_KEY,
      { priority: 'foreground', live: true },
    );
    const late = { ...event, relay: { url: 'wss://unavailable.example/' } } as ClientEvent;
    options.onEvent?.(late);
    expect(context.queuePrivateMessageIngestion).toHaveBeenLastCalledWith(
      expect.objectContaining(late),
      LOGGED_IN_PUBLIC_KEY,
      { priority: 'foreground' },
    );

    options.onInitialSync?.([...RELAY_URLS, 'wss://unavailable.example/'], []);
    options.onEose?.();
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success',
    );
    expect(subscribeWithReqLogging).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    runtime.stopPrivateMessagesLiveSubscription();
  });

  it('reports failed startup when no relay completed and allows later recovery', async () => {
    let options!: SubscriptionOptions;
    const context = createRuntime({
      subscribeWithReqLogging: vi.fn((_label, _requestLabel, _filters, handlers) => {
        options = handlers;
        return { stop: vi.fn() } as never;
      }),
    });
    await context.runtime.subscribePrivateMessagesForLoggedInUser(false, {
      startupTrackStep: true,
    });
    options.onInitialSync?.([], RELAY_URLS);
    expect(context.startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'error',
    );
    expect(context.privateMessagesSubscriptionLiveCoverageAt).toBeNull();
    options.onEose?.();
    expect(context.startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'success',
    );
    context.runtime.stopPrivateMessagesLiveSubscription();
  });

  it('does not leave history waiting on a listener that failed to start', async () => {
    const { runtime, startupRuntime } = createRuntime({
      subscribeWithReqLogging: vi.fn(() => {
        throw new Error('Subscription failed');
      }),
    });
    await expect(
      runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true }),
    ).rejects.toThrow('Subscription failed');
    expect(startupRuntime.getStartupStepSnapshot('private-messages-subscribe').status).toBe(
      'error',
    );
    expect(() => runtime.startPrivateMessagesHistoryRestore()).toThrow(
      'Start the message listener',
    );
  });

  it('starts without draining the live queue and prevents history after logout', async () => {
    let finishRefresh = () => {};
    const refreshAllStoredContacts = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const { runtime, startPrivateMessagesStartupBackfill } = createRuntime({
      getPrivateMessagesIngestQueue: refreshAllStoredContacts,
    });
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { startupTrackStep: true });
    runtime.startPrivateMessagesHistoryRestore();
    expect(refreshAllStoredContacts).not.toHaveBeenCalled();
    expect(startPrivateMessagesStartupBackfill).toHaveBeenCalledTimes(1);
    startPrivateMessagesStartupBackfill.mockClear();
    runtime.stopPrivateMessagesLiveSubscription('logout');
    runtime.resetPrivateMessagesSubscriptionRuntimeState();
    finishRefresh();
    await Promise.resolve();
    expect(startPrivateMessagesStartupBackfill).not.toHaveBeenCalled();
    expect(() => runtime.startPrivateMessagesHistoryRestore()).toThrow(
      'Start the message listener',
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
      expect.any(Object),
    );
  });

  it('creates a missing live subscription without an extra probe', async () => {
    const harness = createRuntime();
    const { runtime, subscribeWithReqLogging } = harness;

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
      expect.any(Object),
    );
    expect(harness.privateMessagesSubscriptionLiveCoverageAt).toBeGreaterThan(0);
  });

  it('reconnects transport without probing or replacing the healthy subscription', async () => {
    const { runtime, subscribeWithReqLogging } = createRuntime();
    await runtime.subscribePrivateMessagesForLoggedInUser();
    const result = await runtime.refreshPrivateMessagesLiveSubscription({
      sinceOverride: 123,
    });
    expect(result).toEqual({ recreatedLiveSubscription: false });
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent requests and keeps healthy listeners through resume without querying contacts or probing', async () => {
    const { runtime, ndk, subscribeWithReqLogging, refreshAllStoredContacts } =
      createRuntime();
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

  it('bounds initial group live delivery even when a recovered ticket has an old timestamp', async () => {
    const epoch = 'c'.repeat(64);
    const { runtime, subscribeWithReqLogging } = createRuntime({
      recipients: async () => [LOGGED_IN_PUBLIC_KEY, epoch],
    });
    const now = Math.floor(Date.now() / 1000);
    await runtime.subscribePrivateMessagesForLoggedInUser(true, { sinceOverride: 0 });
    const calls = subscribeWithReqLogging.mock.calls;
    expect(calls.find((call) => call[2]['#p'][0] === epoch)![2]).toMatchObject({
      since: now - 2 * 86400,
      limit: 128,
    });
    expect(calls.find((call) => call[2]['#p'][0] === LOGGED_IN_PUBLIC_KEY)![2]).toMatchObject({
      since: 0,
    });
    runtime.resetPrivateMessagesSubscriptionRuntimeState();
  });

  it('changes only the affected epoch recipient and retains group and fallback relay routes', async () => {
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
        ] as never,
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
      ...RELAY_URLS,
    ]);
  });
});
