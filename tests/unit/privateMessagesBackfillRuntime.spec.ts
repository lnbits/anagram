import NostrClient from '#src/lib/nostr/client.ts';
import {
  MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS,
  PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS,
} from '#src/stores/nostr/constants.ts';
import { createPrivateMessagesBackfillRuntime } from '#src/stores/nostr/privateMessagesBackfillRuntime.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    getChatByPublicKey: vi.fn(),
    getMessageByEventId: vi.fn(),
    getMessageByEventIdOrEditReference: vi.fn(),
    init: vi.fn(),
    listLatestMessages: vi.fn(),
    listChats: vi.fn(async () => []),
  },
  nostrEventDataService: {
    getEventById: vi.fn(),
    init: vi.fn(),
  },
}));

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: { init: vi.fn(async () => {}), listContacts: vi.fn(async () => []) },
}));

vi.mock('#src/services/nostrEventDataService.ts', () => ({
  nostrEventDataService: serviceMocks.nostrEventDataService,
}));

const LOGGED_IN_PUBLIC_KEY = 'a'.repeat(64);
const DIRECT_CHAT_PUBLIC_KEY = 'b'.repeat(64);
const GROUP_CHAT_PUBLIC_KEY = 'c'.repeat(64);
const GROUP_EPOCH_A = 'd'.repeat(64);
const GROUP_EPOCH_B = 'e'.repeat(64);
const TARGET_EVENT_ID = 'f'.repeat(64);

function createRuntime(
  overrides: {
    queuePrivateMessageIngestion?: ReturnType<typeof vi.fn>;
    ensureLiveRecipientSubscription?: () => Promise<void>;
    getPrivateMessagesIngestQueue?: () => Promise<void>;
    ndk?: NostrClient;
    readRelays?: string[];
    subscribeWithReqLogging?: ReturnType<typeof vi.fn>;
    resolveGroupChatEpochEntries?: (chat: {
      meta: Record<string, unknown>;
      type: string;
    }) => Array<{
      epoch_public_key: string;
    }>;
  } = {},
) {
  const subscribeWithReqLogging =
    overrides.subscribeWithReqLogging ??
    vi.fn((_label, _requestLabel, _filters, options) => {
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });

  const beginStartupInternalTask = vi.fn();
  const failStartupInternalTask = vi.fn();
  const completeStartupStep = vi.fn();
  const failStartupStep = vi.fn();
  const updateStartupInternalTask = vi.fn();
  const client = overrides.ndk ?? new NostrClient();
  if (!overrides.ndk)
    for (const url of overrides.readRelays ?? ['wss://relay.example'])
      vi.spyOn(client.pool.getRelay(url, false, false), 'connected', 'get').mockReturnValue(true);
  const runtime = createPrivateMessagesBackfillRuntime({
    ensureLiveRecipientSubscription: overrides.ensureLiveRecipientSubscription,
    beginStartupInternalTask,
    buildFilterSinceDetails: (since) => ({ since }),
    buildFilterUntilDetails: (until) => ({ until }),
    buildPrivateMessageSubscriptionTargetDetails: vi.fn(async () => ({})),
    buildSubscriptionRelayDetails: (relayUrls) => ({ relayUrls }),
    completeStartupInternalTask: vi.fn(),
    completeStartupStep,
    ensureRelayConnections: vi.fn(async () => {}),
    failStartupInternalTask,
    failStartupStep,
    flushPrivateMessagesUiRefreshNow: vi.fn(),
    formatSubscriptionLogValue: (value) => value ?? null,
    getLoggedInPublicKeyHex: () => LOGGED_IN_PUBLIC_KEY,
    getPrivateMessagesIngestQueue: overrides.getPrivateMessagesIngestQueue ?? vi.fn(async () => {}),
    logSubscription: vi.fn(),
    ndk: client,
    normalizeThrottleMs: (value) => value ?? 0,
    queuePrivateMessageIngestion: overrides.queuePrivateMessageIngestion ?? vi.fn(),
    relaySignature: (relayUrls) => relayUrls.join(','),
    resolveGroupChatEpochEntries:
      overrides.resolveGroupChatEpochEntries ??
      (() => [
        {
          epoch_public_key: GROUP_EPOCH_A,
        },
      ]),
    resolvePrivateMessageReadRelayUrls: vi.fn(
      async () => overrides.readRelays ?? ['wss://relay.example'],
    ),
    schedulePostPrivateMessagesEoseChecks: vi.fn(),
    subscribeWithReqLogging,
    toOptionalIsoTimestampFromUnix: (value) =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : null,
    updateStoredEventSinceFromCreatedAt: vi.fn(),
    updateStoredPrivateMessagesLastReceivedFromCreatedAt: vi.fn(),
    updateStartupInternalTask,
  });

  return {
    runtime,
    subscribeWithReqLogging,
    beginStartupInternalTask,
    completeStartupStep,
    failStartupStep,
    updateStartupInternalTask,
    failStartupInternalTask,
  };
}

describe('privateMessagesBackfillRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1800000000_000));
    serviceMocks.chatDataService.listChats.mockResolvedValue([]);
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventIdOrEditReference.mockImplementation((eventId) =>
      serviceMocks.chatDataService.getMessageByEventId(eventId),
    );
    serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
      has_more: false,
      rows: [],
    });
    serviceMocks.nostrEventDataService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.getEventById.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function relayFixture(
    events: Array<{ id: string; created_at: number; recipient?: string }>,
    cap = 128,
  ) {
    return vi.fn((_label, _requestLabel, filter, options) => {
      queueMicrotask(() => {
        for (const event of events
          .filter(
            (event) =>
              event.created_at >= filter.since &&
              event.created_at <= filter.until &&
              filter['#p'].includes(event.recipient ?? LOGGED_IN_PUBLIC_KEY),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, Math.min(cap, filter.limit))) {
          options.onEvent({
            ...event,
            kind: 1059,
            pubkey: DIRECT_CHAT_PUBLIC_KEY,
            tags: [['p', event.recipient ?? LOGGED_IN_PUBLIC_KEY]],
            content: '',
          });
        }
        options.onEose();
        options.onClose();
      });
      return { stop: vi.fn() } as never;
    });
  }

  function start(
    runtime: ReturnType<typeof createRuntime>['runtime'],
    relays = ['wss://relay.example'],
  ) {
    runtime.startPrivateMessagesStartupBackfill(
      LOGGED_IN_PUBLIC_KEY,
      [LOGGED_IN_PUBLIC_KEY],
      relays,
      1799900000,
    );
  }

  it('explicit missing-target repair bypasses processed receipts without changing ordinary history', async () => {
    const queue = vi.fn(async () => {
      serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue({ id: 1 });
      return true;
    });
    const fixture = relayFixture([{ id: TARGET_EVENT_ID, created_at: 1799999900 }]);
    const { runtime } = createRuntime({
      queuePrivateMessageIngestion: queue,
      subscribeWithReqLogging: fixture,
    });
    const repaired = runtime.repairMissingMessageDependency(
      DIRECT_CHAT_PUBLIC_KEY,
      TARGET_EVENT_ID,
      { reason: 'reply-open', immediate: true, force: true, referenceCreatedAt: 1799999900 },
    );
    await vi.runAllTimersAsync();
    expect(await repaired).toBe(true);
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ id: TARGET_EVENT_ID }),
      LOGGED_IN_PUBLIC_KEY,
      expect.objectContaining({ reprocess: true }),
    );
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('fetches selected group epochs with foreground ingestion and bounded cached reads', async () => {
    const timestamp = 1800000000 - 80 * 86400;
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({ type: 'group', meta: {} });
    serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
      rows: [{ created_at: new Date(timestamp * 1000).toISOString() }],
      has_more: false,
    });
    const queue = vi.fn(async () => true);
    const fixture = relayFixture([
      { id: '1'.repeat(64), created_at: timestamp, recipient: GROUP_EPOCH_A },
      { id: '2'.repeat(64), created_at: timestamp, recipient: GROUP_EPOCH_B },
    ]);
    const { runtime } = createRuntime({
      queuePrivateMessageIngestion: queue,
      subscribeWithReqLogging: fixture,
      resolveGroupChatEpochEntries: () =>
        [GROUP_EPOCH_A, GROUP_EPOCH_B].map((epoch_public_key) => ({ epoch_public_key })),
    });
    runtime.prioritizeThreadHistory(GROUP_CHAT_PUBLIC_KEY);
    await vi.runAllTimersAsync();
    expect(serviceMocks.chatDataService.listLatestMessages).toHaveBeenCalledWith(
      GROUP_CHAT_PUBLIC_KEY,
      100,
    );
    expect(new Set(fixture.mock.calls.flatMap((call) => call[2]['#p']))).toEqual(
      new Set([GROUP_EPOCH_A, GROUP_EPOCH_B]),
    );
    expect(queue).toHaveBeenCalled();
    for (const call of queue.mock.calls as unknown as Array<[unknown, string, object]>)
      expect(call[2]).toMatchObject({ priority: 'foreground', uiThrottleMs: 0 });
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('opens a foreground request while background history is stalled and cancels only the selected lane', async () => {
    const stops: Array<{ label: string; stop: ReturnType<typeof vi.fn> }> = [];
    const subscribe = vi.fn((_label, label) => {
      const stop = vi.fn();
      stops.push({ label, stop });
      return { stop } as never;
    });
    const { runtime } = createRuntime({ subscribeWithReqLogging: subscribe });
    start(runtime);
    await vi.advanceTimersByTimeAsync(0);
    runtime.prioritizeThreadHistory(DIRECT_CHAT_PUBLIC_KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(stops.some((entry) => entry.label === 'private-messages-backfill')).toBe(true);
    expect(stops.some((entry) => entry.label === 'selected-thread-history')).toBe(true);
    runtime.prioritizeThreadHistory(null);
    for (const entry of stops) {
      if (entry.label === 'selected-thread-history') expect(entry.stop).toHaveBeenCalled();
      else expect(entry.stop).not.toHaveBeenCalled();
    }
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('waits for this page to commit without waiting for unrelated live ingestion', async () => {
    let release!: () => void;
    const gate = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const subscribe = relayFixture([{ id: TARGET_EVENT_ID, created_at: 1799999995 }]);
    const globalQueue = vi.fn(() => new Promise<void>(() => {}));
    const { runtime, completeStartupStep } = createRuntime({
      subscribeWithReqLogging: subscribe,
      queuePrivateMessageIngestion: vi.fn(() => gate),
      getPrivateMessagesIngestQueue: globalQueue,
    });
    start(runtime);
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(completeStartupStep).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    expect(globalQueue).not.toHaveBeenCalled();
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('walks capped pages and sparse time windows beyond the old age cutoff', async () => {
    const events = [1, 2, 3, 20, 400, 1200].map((days, index) => ({
      id: String(index),
      created_at: 1800000000 - days * 86400,
    }));
    const subscribe = relayFixture(events, 2);
    const received = new Set<string>();
    const { runtime, completeStartupStep } = createRuntime({
      subscribeWithReqLogging: subscribe,
      queuePrivateMessageIngestion: vi.fn(async (event) => {
        received.add(event.id);
        return true;
      }),
    });
    start(runtime);
    await vi.advanceTimersByTimeAsync(15000);
    expect(received.size).toBe(6);
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    const filters = subscribe.mock.calls.map((call) => call[2]);
    expect(filters.some((filter) => filter.limit === 1 && filter.since === 0)).toBe(true);
    expect(
      filters.every(
        (filter) =>
          filter.limit <= 128 && (filter.limit === 1 || filter.until - filter.since < 7 * 86400),
      ),
    ).toBe(true);
    const count = subscribe.mock.calls.length;
    start(runtime);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribe).toHaveBeenCalledTimes(count + 1);
    expect(subscribe.mock.calls.at(-1)?.[2].since).toBe(1800000001); // Only new time is fetched.
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('expands crowded timestamp pages independently for each relay', async () => {
    const relays = ['wss://busy.example/', 'wss://quiet.example/'];
    const ndk = new NostrClient();
    for (const url of relays)
      vi.spyOn(ndk.pool.getRelay(url, false, false), 'connected', 'get').mockReturnValue(true);
    const events = Array.from({ length: 140 }, (_, i) => ({
      id: String(i),
      created_at: 1799999995,
    }));
    const busy = relayFixture(events, 4096),
      quiet = relayFixture(events.slice(0, 12), 4096);
    const subscribe = vi.fn((...args: Parameters<typeof busy>) =>
      (args[3].relaySet.relayUrls[0].includes('busy') ? busy : quiet)(...args),
    );
    const { runtime, completeStartupStep } = createRuntime({
      ndk,
      readRelays: relays,
      subscribeWithReqLogging: subscribe,
    });
    start(runtime, relays);
    await vi.advanceTimersByTimeAsync(5000);
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    expect(busy.mock.calls.map((call) => call[2].limit)).toContain(256);
    expect(quiet.mock.calls.every((call) => call[2].limit <= 128)).toBe(true);
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('retries rejected commits without marking history complete', async () => {
    const queue = vi.fn(async () => false);
    const { runtime, completeStartupStep, failStartupInternalTask, failStartupStep } =
      createRuntime({
        subscribeWithReqLogging: relayFixture([{ id: TARGET_EVENT_ID, created_at: 1799999995 }]),
        queuePrivateMessageIngestion: queue,
      });
    start(runtime);
    await vi.advanceTimersByTimeAsync(1000);
    expect(failStartupInternalTask).toHaveBeenCalled();
    expect(completeStartupStep).not.toHaveBeenCalled();
    expect(failStartupStep).not.toHaveBeenCalled();
    queue.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('finishes healthy history and retries an unavailable relay until it reconnects', async () => {
    const ndk = new NostrClient();
    const relays = ['wss://available.example/', 'wss://unavailable.example/'];
    vi.spyOn(ndk.pool.getRelay(relays[0]!, false, false), 'connected', 'get').mockReturnValue(true);
    const connected = vi
      .spyOn(ndk.pool.getRelay(relays[1]!, false, false), 'connected', 'get')
      .mockReturnValue(false);
    const { runtime, subscribeWithReqLogging, completeStartupStep, failStartupInternalTask } =
      createRuntime({ ndk, readRelays: relays });
    start(runtime, relays);
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(2); // Week + older-envelope probe.
    expect(failStartupInternalTask).toHaveBeenCalled();
    expect(completeStartupStep).not.toHaveBeenCalled();
    connected.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(4);
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('discovers group epochs from old invitations and fills their older messages', async () => {
    const events = [
      { id: 'ticket', created_at: 1700000000 },
      { id: 'group-message', created_at: 1600000000, recipient: GROUP_EPOCH_A },
    ];
    const received = new Set<string>();
    const { runtime, completeStartupStep } = createRuntime({
      subscribeWithReqLogging: relayFixture(events),
      queuePrivateMessageIngestion: vi.fn(async (event) => {
        received.add(event.id);
        if (event.id === 'ticket')
          serviceMocks.chatDataService.listChats.mockResolvedValue([
            { public_key: GROUP_CHAT_PUBLIC_KEY, type: 'group', meta: {} },
          ] as never);
        return true;
      }),
    });
    start(runtime);
    await vi.advanceTimersByTimeAsync(10000);
    expect(received).toEqual(new Set(['ticket', 'group-message']));
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('does not checkpoint a close without EOSE and cancels its retry on logout', async () => {
    const subscribe = vi.fn((_label, _requestLabel, _filters, options) => {
      queueMicrotask(() => options.onClose());
      return { stop: vi.fn() } as never;
    });
    const { runtime, failStartupInternalTask, completeStartupStep } = createRuntime({
      subscribeWithReqLogging: subscribe,
    });
    start(runtime);
    await vi.advanceTimersByTimeAsync(100);
    expect(failStartupInternalTask).toHaveBeenCalled();
    expect(completeStartupStep).not.toHaveBeenCalled();
    runtime.resetPrivateMessagesBackfillRuntimeState();
    await vi.advanceTimersByTimeAsync(120000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('repairs missing direct-message targets from the conversation recipients', async () => {
    let targetFound = false;
    serviceMocks.chatDataService.getMessageByEventId.mockImplementation(async () => {
      return targetFound ? ({ id: 7 } as never) : null;
    });

    const subscribeWithReqLogging = vi.fn((_label, requestLabel, filters, options) => {
      expect(requestLabel).toBe('private-messages-recipient-restore');
      expect((filters as { '#p': string[] })['#p']).toEqual([LOGGED_IN_PUBLIC_KEY]);
      Promise.resolve().then(() => {
        targetFound = true;
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
    });

    await expect(
      runtime.repairMissingMessageDependency(DIRECT_CHAT_PUBLIC_KEY, TARGET_EVENT_ID, {
        reason: 'reply-target-missing',
        immediate: true,
        referenceCreatedAt: 1700003600,
      }),
    ).resolves.toBe(true);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('starts complete group history for late tickets and adds epochs to an active scan', async () => {
    const chat = { public_key: GROUP_CHAT_PUBLIC_KEY, type: 'group', meta: {} };
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(chat);
    serviceMocks.chatDataService.listChats.mockResolvedValue([chat] as never);
    let epochs = [GROUP_EPOCH_A];
    const seen = new Set<string>();
    const ensure = vi.fn(async () => {});
    const subscribe = relayFixture([
      { id: 'old-a', created_at: 1500000000, recipient: GROUP_EPOCH_A },
      { id: 'old-b', created_at: 1400000000, recipient: GROUP_EPOCH_B },
    ]);
    const { runtime, completeStartupStep } = createRuntime({
      ensureLiveRecipientSubscription: ensure,
      subscribeWithReqLogging: subscribe,
      resolveGroupChatEpochEntries: () => epochs.map((epoch_public_key) => ({ epoch_public_key })),
      queuePrivateMessageIngestion: vi.fn(async (event) => {
        seen.add(event.id);
        return true;
      }),
    });
    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_A);
    await vi.advanceTimersByTimeAsync(100);
    epochs = [GROUP_EPOCH_A, GROUP_EPOCH_B];
    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_B);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(new Set(['old-a', 'old-b']));
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('repairs group targets across all known epoch recipients', async () => {
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      meta: {},
    });

    const subscribeWithReqLogging = vi.fn((_label, requestLabel, _filters, options, details) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      expect(details).toEqual(
        expect.objectContaining({
          groupPublicKey: GROUP_CHAT_PUBLIC_KEY,
        }),
      );
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
      resolveGroupChatEpochEntries: () => [
        {
          epoch_public_key: GROUP_EPOCH_A,
        },
        {
          epoch_public_key: GROUP_EPOCH_B,
        },
      ],
    });

    await expect(
      runtime.repairMissingMessageDependency(GROUP_CHAT_PUBLIC_KEY, TARGET_EVENT_ID, {
        reason: 'deletion-target-missing',
        immediate: true,
        referenceCreatedAt: 1700003600,
      }),
    ).resolves.toBe(false);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(2);
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      1,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_A],
      }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      2,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_B],
      }),
      expect.any(Object),
      expect.any(Object),
    );

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('promotes missing reply target repairs to the widest history window immediately', async () => {
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      meta: {},
    });

    const referenceCreatedAt = Math.floor(Date.now() / 1000);
    const subscribeWithReqLogging = vi.fn((_label, requestLabel, filters, options) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      expect(filters).toEqual(
        expect.objectContaining({
          '#p': [GROUP_EPOCH_A],
          since:
            referenceCreatedAt -
            MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS[
              MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1
            ],
          until: referenceCreatedAt,
        }),
      );
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
      resolveGroupChatEpochEntries: () => [
        {
          epoch_public_key: GROUP_EPOCH_A,
        },
      ],
    });

    await expect(
      runtime.repairMissingMessageDependency(GROUP_CHAT_PUBLIC_KEY, TARGET_EVENT_ID, {
        reason: 'reply-target-missing',
        immediate: true,
        referenceCreatedAt,
      }),
    ).resolves.toBe(false);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('promotes reply-open repairs to the widest history window immediately', async () => {
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      meta: {},
    });

    const referenceCreatedAt = Math.floor(Date.now() / 1000);
    const subscribeWithReqLogging = vi.fn((_label, requestLabel, filters, options) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      expect(filters).toEqual(
        expect.objectContaining({
          '#p': [GROUP_EPOCH_A],
          since:
            referenceCreatedAt -
            MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS[
              MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1
            ],
          until: referenceCreatedAt,
        }),
      );
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
      resolveGroupChatEpochEntries: () => [
        {
          epoch_public_key: GROUP_EPOCH_A,
        },
      ],
    });

    await expect(
      runtime.repairMissingMessageDependency(GROUP_CHAT_PUBLIC_KEY, TARGET_EVENT_ID, {
        reason: 'reply-open',
        immediate: true,
        force: true,
        referenceCreatedAt,
      }),
    ).resolves.toBe(false);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });
});
