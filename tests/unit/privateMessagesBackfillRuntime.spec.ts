import NDK from '@nostr-dev-kit/ndk';
import {
  MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS,
  PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS,
} from 'src/stores/nostr/constants';
import { createPrivateMessagesBackfillRuntime } from 'src/stores/nostr/privateMessagesBackfillRuntime';
import type { PrivateMessagesBackfillState } from 'src/stores/nostr/types';
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

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: { init: vi.fn(async () => {}), listContacts: vi.fn(async () => []) },
}));

vi.mock('src/services/nostrEventDataService', () => ({
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
    getLiveRecipientSince?: (publicKey: string) => number | null;
    ensureLiveRecipientSubscription?: () => Promise<void>;
    getPrivateMessagesStartupFloorSince?: ReturnType<typeof vi.fn>;
    getPrivateMessagesBackfillResumeState?: () => PrivateMessagesBackfillState | null;
    getPrivateMessagesIngestQueue?: () => Promise<void>;
    subscribeWithReqLogging?: ReturnType<typeof vi.fn>;
    resolveGroupChatEpochEntries?: (chat: {
      meta: Record<string, unknown>;
      type: string;
    }) => Array<{
      epoch_public_key: string;
    }>;
  } = {}
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
  const completeStartupStep = vi.fn();
  const failStartupStep = vi.fn();
  const updateStartupInternalTask = vi.fn();
  const runtime = createPrivateMessagesBackfillRuntime({
    getLiveRecipientSince: overrides.getLiveRecipientSince,
    ensureLiveRecipientSubscription: overrides.ensureLiveRecipientSubscription,
    beginStartupInternalTask,
    buildFilterSinceDetails: (since) => ({ since }),
    buildFilterUntilDetails: (until) => ({ until }),
    buildPrivateMessageSubscriptionTargetDetails: vi.fn(async () => ({})),
    buildSubscriptionRelayDetails: (relayUrls) => ({ relayUrls }),
    completeStartupInternalTask: vi.fn(),
    completeStartupStep,
    ensureRelayConnections: vi.fn(async () => {}),
    failStartupInternalTask: vi.fn(),
    failStartupStep,
    flushPrivateMessagesUiRefreshNow: vi.fn(),
    formatSubscriptionLogValue: (value) => value ?? null,
    getLoggedInPublicKeyHex: () => LOGGED_IN_PUBLIC_KEY,
    getPrivateMessagesBackfillResumeState:
      overrides.getPrivateMessagesBackfillResumeState ?? vi.fn(() => null),
    getPrivateMessagesIngestQueue: overrides.getPrivateMessagesIngestQueue ?? vi.fn(async () => {}),
    getPrivateMessagesStartupFloorSince:
      overrides.getPrivateMessagesStartupFloorSince ?? vi.fn(() => 1700000000),
    logSubscription: vi.fn(),
    ndk: new NDK(),
    normalizeThrottleMs: (value) => value ?? 0,
    queuePrivateMessageIngestion: vi.fn(),
    relaySignature: (relayUrls) => relayUrls.join(','),
    resolveGroupChatEpochEntries:
      overrides.resolveGroupChatEpochEntries ??
      (() => [
        {
          epoch_public_key: GROUP_EPOCH_A,
        },
      ]),
    resolvePrivateMessageReadRelayUrls: vi.fn(async () => ['wss://relay.example']),
    schedulePostPrivateMessagesEoseChecks: vi.fn(),
    subscribeWithReqLogging,
    toOptionalIsoTimestampFromUnix: (value) =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : null,
    updateStoredEventSinceFromCreatedAt: vi.fn(),
    updateStoredPrivateMessagesLastReceivedFromCreatedAt: vi.fn(),
    updateStartupInternalTask,
    writePrivateMessagesBackfillState: vi.fn(),
  });

  return {
    runtime,
    subscribeWithReqLogging,
    beginStartupInternalTask,
    completeStartupStep,
    failStartupStep,
    updateStartupInternalTask,
  };
}

describe('privateMessagesBackfillRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventIdOrEditReference.mockImplementation((eventId) =>
      serviceMocks.chatDataService.getMessageByEventId(eventId)
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

  it('tracks history separately and completes only after downloaded messages are ingested', async () => {
    let finishIngestion = () => {};
    const ingestQueue = new Promise<void>((resolve) => {
      finishIngestion = resolve;
    });
    const subscribeWithReqLogging = vi.fn((_label, _requestLabel, _filters, options) => {
      Promise.resolve().then(() => {
        options.onEvent({
          id: TARGET_EVENT_ID,
          kind: 1059,
          created_at: 95,
          pubkey: DIRECT_CHAT_PUBLIC_KEY,
          tags: [],
          content: '',
        });
        options.onEose();
        options.onClose();
      });
      return { stop: vi.fn() } as never;
    });
    const { runtime, beginStartupInternalTask, completeStartupStep, updateStartupInternalTask } =
      createRuntime({
        subscribeWithReqLogging,
        getPrivateMessagesIngestQueue: () => ingestQueue,
        getPrivateMessagesBackfillResumeState: () => ({
          pubkey: LOGGED_IN_PUBLIC_KEY,
          nextSince: 90,
          nextUntil: 100,
          floorSince: 90,
          delayMs: 0,
          completed: false,
        }),
      });
    runtime.startPrivateMessagesStartupBackfill(
      LOGGED_IN_PUBLIC_KEY,
      [LOGGED_IN_PUBLIC_KEY],
      ['wss://relay.example'],
      100
    );
    await vi.waitFor(() =>
      expect(updateStartupInternalTask).toHaveBeenCalledWith(
        'message-history-restore',
        expect.any(String),
        { eventCount: 1 }
      )
    );
    expect(beginStartupInternalTask).toHaveBeenCalledWith(
      'message-history-restore',
      expect.any(String),
      expect.any(String),
      { eventCount: 0 }
    );
    expect(completeStartupStep).not.toHaveBeenCalled();
    finishIngestion();
    await vi.waitFor(() =>
      expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore')
    );
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('completes only history when there are no older windows to restore', () => {
    const { runtime, completeStartupStep, subscribeWithReqLogging } = createRuntime();
    runtime.startPrivateMessagesStartupBackfill(
      LOGGED_IN_PUBLIC_KEY,
      [LOGGED_IN_PUBLIC_KEY],
      ['wss://relay.example'],
      100
    );
    expect(completeStartupStep).toHaveBeenCalledExactlyOnceWith('message-history-restore');
    expect(subscribeWithReqLogging).not.toHaveBeenCalled();
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('reports history failure without changing the live listener step', async () => {
    const { runtime, failStartupStep, completeStartupStep } = createRuntime({
      getPrivateMessagesBackfillResumeState: () => ({
        pubkey: LOGGED_IN_PUBLIC_KEY,
        nextSince: 90,
        nextUntil: 100,
        floorSince: 90,
        delayMs: 0,
        completed: false,
      }),
      subscribeWithReqLogging: vi.fn((_label, _requestLabel, _filters, options) => {
        Promise.resolve().then(() => options.onClose());
        return { stop: vi.fn() } as never;
      }),
    });
    runtime.startPrivateMessagesStartupBackfill(
      LOGGED_IN_PUBLIC_KEY,
      [LOGGED_IN_PUBLIC_KEY],
      ['wss://relay.example'],
      100
    );
    await vi.waitFor(() =>
      expect(failStartupStep).toHaveBeenCalledExactlyOnceWith(
        'message-history-restore',
        expect.any(Error)
      )
    );
    expect(completeStartupStep).not.toHaveBeenCalled();
    runtime.resetPrivateMessagesBackfillRuntimeState();
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
      })
    ).resolves.toBe(true);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('does not query epoch history already covered by an active global window', async () => {
    vi.setSystemTime(new Date(100_000));
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      meta: {},
    });
    const subscribe = vi.fn(() => ({ stop: vi.fn() }) as never);
    const { runtime } = createRuntime({
      subscribeWithReqLogging: subscribe,
      getPrivateMessagesStartupFloorSince: vi.fn(() => 90),
      getPrivateMessagesBackfillResumeState: () => ({
        pubkey: LOGGED_IN_PUBLIC_KEY,
        nextSince: 90,
        nextUntil: 100,
        floorSince: 90,
        delayMs: 0,
        completed: false,
      }),
    });
    runtime.startPrivateMessagesStartupBackfill(
      LOGGED_IN_PUBLIC_KEY,
      [GROUP_EPOCH_A],
      ['wss://relay.example'],
      100
    );
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_A);
    expect(subscribe).toHaveBeenCalledTimes(1);
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('joins the live epoch listener before requesting only an uncovered history gap', async () => {
    vi.setSystemTime(new Date(100_000));
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      meta: {},
    });
    const ensure = vi.fn(async () => {});
    const { runtime, subscribeWithReqLogging } = createRuntime({
      ensureLiveRecipientSubscription: ensure,
      getLiveRecipientSince: () => 95,
      getPrivateMessagesStartupFloorSince: vi.fn(() => 90),
    });
    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_A);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(subscribeWithReqLogging.mock.calls[0]?.[2]).toMatchObject({ since: 90, until: 94 });
    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('restores group epoch history from the latest stored group message with a bounded window', async () => {
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    const nowUnix = Math.floor(Date.now() / 1000);
    const latestMessageCreatedAt = '2026-04-22T12:00:00.000Z';
    const latestMessageUnix = Math.floor(Date.parse(latestMessageCreatedAt) / 1000);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      last_message_at: '2026-04-20T12:00:00.000Z',
      meta: {},
    });
    serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
      has_more: false,
      rows: [
        {
          created_at: latestMessageCreatedAt,
        },
      ],
    });

    const subscribeWithReqLogging = vi.fn((_label, requestLabel, filters, options) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      expect(filters).toEqual({
        kinds: [1059],
        '#p': [GROUP_EPOCH_A],
        since: latestMessageUnix - PRIVATE_MESSAGES_RECONNECT_LOOKBACK_SECONDS,
        until: nowUnix,
      });
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
    });

    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_A);

    expect(serviceMocks.chatDataService.listLatestMessages).toHaveBeenCalledWith(
      GROUP_CHAT_PUBLIC_KEY,
      1
    );
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('restores every known group epoch when refreshing group epoch history', async () => {
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    const nowUnix = Math.floor(Date.now() / 1000);
    const latestMessageCreatedAt = '2026-04-22T12:00:00.000Z';
    const widestRepairWindowSeconds =
      MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS[
        MISSING_MESSAGE_DEPENDENCY_REPAIR_WINDOW_SECONDS.length - 1
      ] ?? 0;
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      last_message_at: '2026-04-20T12:00:00.000Z',
      meta: {},
    });
    serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
      has_more: false,
      rows: [
        {
          created_at: latestMessageCreatedAt,
        },
      ],
    });

    const subscribeWithReqLogging = vi.fn((_label, requestLabel, filters, options) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      expect(filters).toEqual(
        expect.objectContaining({
          kinds: [1059],
          since: nowUnix - widestRepairWindowSeconds,
          until: nowUnix,
        })
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

    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_B, { force: true });

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(2);
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      1,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_A],
      }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      2,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_B],
      }),
      expect.any(Object),
      expect.any(Object)
    );

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('restores group epochs discovered during an active history restore', async () => {
    serviceMocks.chatDataService.getChatByPublicKey
      .mockResolvedValueOnce({
        public_key: GROUP_CHAT_PUBLIC_KEY,
        type: 'group',
        meta: {},
      })
      .mockResolvedValue({
        public_key: GROUP_CHAT_PUBLIC_KEY,
        type: 'group',
        meta: {},
      });
    serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
      has_more: false,
      rows: [],
    });

    const subscribeWithReqLogging = vi.fn((_label, requestLabel, _filters, options) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      subscribeWithReqLogging,
      resolveGroupChatEpochEntries: vi
        .fn()
        .mockReturnValueOnce([
          {
            epoch_public_key: GROUP_EPOCH_A,
          },
        ])
        .mockReturnValue([
          {
            epoch_public_key: GROUP_EPOCH_A,
          },
          {
            epoch_public_key: GROUP_EPOCH_B,
          },
        ]),
    });

    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_A);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(2);
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      1,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_A],
      }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      2,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_B],
      }),
      expect.any(Object),
      expect.any(Object)
    );

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });

  it('falls back to the startup floor for group epoch history when there is no known message time', async () => {
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'));
    const nowUnix = Math.floor(Date.now() / 1000);
    const getPrivateMessagesStartupFloorSince = vi.fn(() => 1600000000);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      public_key: GROUP_CHAT_PUBLIC_KEY,
      type: 'group',
      last_message_at: null,
      meta: {},
    });

    const subscribeWithReqLogging = vi.fn((_label, requestLabel, filters, options) => {
      expect(requestLabel).toBe('private-messages-epoch-history');
      expect(filters).toEqual(
        expect.objectContaining({
          '#p': [GROUP_EPOCH_A],
          since: 1600000000,
          until: nowUnix,
        })
      );
      Promise.resolve().then(() => {
        options.onEose?.();
      });

      return {
        stop: vi.fn(),
      } as never;
    });
    const { runtime } = createRuntime({
      getPrivateMessagesStartupFloorSince,
      subscribeWithReqLogging,
    });

    await runtime.restoreGroupEpochHistory(GROUP_CHAT_PUBLIC_KEY, GROUP_EPOCH_A);

    expect(getPrivateMessagesStartupFloorSince).toHaveBeenCalledTimes(1);

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
        })
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
      })
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
      expect.any(Object)
    );
    expect(subscribeWithReqLogging).toHaveBeenNthCalledWith(
      2,
      'private-messages',
      'private-messages-epoch-history',
      expect.objectContaining({
        '#p': [GROUP_EPOCH_B],
      }),
      expect.any(Object),
      expect.any(Object)
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
        })
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
      })
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
        })
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
      })
    ).resolves.toBe(false);

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);

    runtime.resetPrivateMessagesBackfillRuntimeState();
  });
});
