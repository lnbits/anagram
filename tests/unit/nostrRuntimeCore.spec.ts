import NDK, { NDKPrivateKeySigner, NDKRelayStatus } from '@nostr-dev-kit/ndk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const developerTraceDataServiceMock = vi.hoisted(() => ({
  appendEntry: vi.fn(async () => {}),
  listEntries: vi.fn(async () => []),
  clearEntries: vi.fn(async () => {}),
}));

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listChats: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
}));

const browserNotificationsMock = vi.hoisted(() => ({
  areBrowserNotificationsEnabled: vi.fn(() => true),
}));

vi.mock('src/services/developerTraceDataService', () => ({
  developerTraceDataService: developerTraceDataServiceMock,
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('src/utils/browserNotificationPreference', () => ({
  areBrowserNotificationsEnabled: browserNotificationsMock.areBrowserNotificationsEnabled,
}));

import { createAuthIdentityRuntime } from 'src/stores/nostr/authIdentityRuntime';
import { AUTH_METHOD_STORAGE_KEY, PUBLIC_KEY_STORAGE_KEY } from 'src/stores/nostr/constants';
import { createDeveloperRelayRuntime } from 'src/stores/nostr/developerRelayRuntime';
import {
  createDeveloperTraceRuntime,
  readDeveloperDiagnosticsEnabledFromStorage,
} from 'src/stores/nostr/developerTrace';
import { createInboundPresentationRuntime } from 'src/stores/nostr/inboundPresentationRuntime';
import { hasStorage, isPlainRecord } from 'src/stores/nostr/shared';
import { createStartupRuntime } from 'src/stores/nostr/startupRuntime';
import { createInitialStartupStepSnapshots } from 'src/stores/nostr/startupState';
import { createSubscriptionRefreshRuntime } from 'src/stores/nostr/subscriptionRefreshRuntime';
import { createTrackedContactStateRuntime } from 'src/stores/nostr/trackedContactStateRuntime';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const EVENT_ID_A = 'c'.repeat(64);

function createMockStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));

  return {
    store,
    api: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  };
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('nostr runtime core logic', () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalNotification = (globalThis as Record<string, unknown>).Notification;
  const originalRouterBase = process.env.VUE_ROUTER_BASE;
  const originalRouterMode = process.env.VUE_ROUTER_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    developerTraceDataServiceMock.listEntries.mockResolvedValue([]);
    browserNotificationsMock.areBrowserNotificationsEnabled.mockReturnValue(true);
    chatDataServiceMock.listMessages.mockResolvedValue([]);
    chatDataServiceMock.listChats.mockResolvedValue([]);
    (globalThis as Record<string, unknown>).window = undefined;
    (globalThis as Record<string, unknown>).document = undefined;
    (globalThis as Record<string, unknown>).Notification = undefined;
    delete process.env.VUE_ROUTER_BASE;
    delete process.env.VUE_ROUTER_MODE;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
    if (originalNotification === undefined) {
      delete (globalThis as Record<string, unknown>).Notification;
    } else {
      (globalThis as Record<string, unknown>).Notification = originalNotification;
    }
    if (originalRouterBase === undefined) {
      delete process.env.VUE_ROUTER_BASE;
    } else {
      process.env.VUE_ROUTER_BASE = originalRouterBase;
    }
    if (originalRouterMode === undefined) {
      delete process.env.VUE_ROUTER_MODE;
    } else {
      process.env.VUE_ROUTER_MODE = originalRouterMode;
    }
  });

  it('detects browser storage availability and plain records', () => {
    expect(hasStorage()).toBe(false);
    expect(isPlainRecord({ ok: true })).toBe(true);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);

    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    expect(hasStorage()).toBe(true);
  });

  it('tracks contact event ordering and resets stale state', () => {
    const runtime = createTrackedContactStateRuntime();

    expect(
      runtime.shouldApplyPrivateContactListEvent({
        created_at: 10,
        id: EVENT_ID_A,
      } as never)
    ).toBe(true);
    runtime.markPrivateContactListEventApplied({
      created_at: 10,
      id: EVENT_ID_A,
    } as never);
    expect(
      runtime.shouldApplyPrivateContactListEvent({
        created_at: 9,
        id: 'd'.repeat(64),
      } as never)
    ).toBe(false);
    expect(
      runtime.shouldApplyPrivateContactListEvent({
        created_at: 10,
        id: EVENT_ID_A,
      } as never)
    ).toBe(false);

    const relayState = runtime.buildContactRelayListEventState({
      created_at: 20,
      id: 'e'.repeat(64),
    } as never);
    runtime.markContactRelayListEventApplied(PUBKEY_A, relayState);
    expect(
      runtime.shouldApplyContactRelayListEvent({
        pubkey: PUBKEY_A.toUpperCase(),
        created_at: 19,
        id: 'f'.repeat(64),
      } as never)
    ).toBe(false);
    expect(
      runtime.shouldApplyContactRelayListEvent({
        pubkey: PUBKEY_A,
        created_at: 20,
        id: 'f'.repeat(64),
      } as never)
    ).toBe(true);

    const profileState = runtime.buildContactProfileEventState({
      created_at: 30,
      id: '1'.repeat(64),
    } as never);
    runtime.markContactProfileEventApplied(PUBKEY_B, profileState);
    expect(
      runtime.shouldApplyContactProfileEvent({
        pubkey: PUBKEY_B,
        created_at: 29,
        id: '2'.repeat(64),
      } as never)
    ).toBe(false);

    runtime.pruneTrackedContactRelayListEventState([PUBKEY_B]);
    runtime.pruneTrackedContactProfileEventState([PUBKEY_A]);
    runtime.resetTrackedContactEventState();

    expect(
      runtime.shouldApplyContactRelayListEvent({
        pubkey: PUBKEY_A,
        created_at: 1,
        id: '3'.repeat(64),
      } as never)
    ).toBe(true);
    expect(
      runtime.shouldApplyContactProfileEvent({
        pubkey: PUBKEY_B,
        created_at: 1,
        id: '4'.repeat(64),
      } as never)
    ).toBe(true);
    expect(
      runtime.shouldApplyContactProfileEvent({
        pubkey: 'not-a-pubkey',
        created_at: 1,
        id: '5'.repeat(64),
      } as never)
    ).toBe(false);
  });

  it('merges and debounces private message subscription refresh requests', async () => {
    vi.useFakeTimers();

    let pendingOptions: Record<string, unknown> | null = null;
    let timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let queue = Promise.resolve();

    const subscribeContactProfileUpdates = vi.fn(async () => {});
    const subscribeContactRelayListUpdates = vi.fn(async () => {});
    const subscribeGroupMembershipRosterUpdates = vi.fn(async () => {});
    const subscribePrivateMessagesForLoggedInUser = vi.fn(async () => {});

    const runtime = createSubscriptionRefreshRuntime({
      getPendingPrivateMessagesEpochSubscriptionRefreshOptions: () => pendingOptions as never,
      getPrivateMessagesEpochSubscriptionRefreshQueue: () => queue,
      getPrivateMessagesEpochSubscriptionRefreshTimerId: () => timerId,
      normalizeRelayStatusUrls: (relayUrls) =>
        Array.from(
          new Set(
            relayUrls
              .map((value) => value.trim())
              .filter(Boolean)
              .map((value) => (value.endsWith('/') ? value : `${value}/`))
          )
        ),
      normalizeThrottleMs: (value) =>
        Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0,
      privateMessagesEpochSubscriptionRefreshDebounceMs: 25,
      setPendingPrivateMessagesEpochSubscriptionRefreshOptions: (options) => {
        pendingOptions = options as Record<string, unknown> | null;
      },
      setPrivateMessagesEpochSubscriptionRefreshQueue: (nextQueue) => {
        queue = nextQueue;
      },
      setPrivateMessagesEpochSubscriptionRefreshTimerId: (nextTimerId) => {
        timerId = nextTimerId;
      },
      subscribeContactProfileUpdates,
      subscribeContactRelayListUpdates,
      subscribeGroupMembershipRosterUpdates,
      subscribePrivateMessagesForLoggedInUser,
    });

    expect(
      runtime.mergeSubscribePrivateMessagesOptions(
        {
          seedRelayUrls: ['wss://one.example', 'wss://two.example'],
          sinceOverride: 20,
          restoreThrottleMs: 5,
        },
        {
          seedRelayUrls: ['wss://two.example/', 'wss://three.example'],
          sinceOverride: 10,
          restoreThrottleMs: 15,
          startupTrackStep: true,
        }
      )
    ).toEqual({
      restoreThrottleMs: 15,
      seedRelayUrls: ['wss://one.example/', 'wss://two.example/', 'wss://three.example/'],
      sinceOverride: 10,
      startupTrackStep: true,
    });

    runtime.queueTrackedContactSubscriptionsRefresh(['wss://seed.example'], true);
    await flushPromises();
    expect(subscribeContactProfileUpdates).toHaveBeenCalledWith(['wss://seed.example'], true);
    expect(subscribeContactRelayListUpdates).not.toHaveBeenCalled();
    expect(subscribePrivateMessagesForLoggedInUser).toHaveBeenCalledWith(true, {
      seedRelayUrls: ['wss://seed.example'],
    });

    subscribePrivateMessagesForLoggedInUser.mockClear();
    runtime.queueEpochDrivenPrivateMessagesSubscriptionRefresh({
      seedRelayUrls: ['wss://one.example'],
      sinceOverride: 50,
      restoreThrottleMs: 5,
    });
    runtime.queueEpochDrivenPrivateMessagesSubscriptionRefresh({
      seedRelayUrls: ['wss://two.example'],
      sinceOverride: 10,
      startupTrackStep: true,
    });

    expect(subscribePrivateMessagesForLoggedInUser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    await flushPromises();

    expect(subscribePrivateMessagesForLoggedInUser).toHaveBeenCalledTimes(1);
    expect(subscribePrivateMessagesForLoggedInUser).toHaveBeenCalledWith(false, {
      restoreThrottleMs: 5,
      seedRelayUrls: ['wss://one.example/', 'wss://two.example/'],
      sinceOverride: 10,
      startupTrackStep: true,
    });
  });

  it('tracks startup progress and batches step completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));

    const startupDisplay = ref({
      stepId: null,
      label: null,
      status: null,
      showProgress: false,
    });
    const startupSteps = ref(createInitialStartupStepSnapshots());
    const startupState = {
      startupDisplayShownAt: 0,
      startupDisplayTimer: null as ReturnType<typeof globalThis.setTimeout> | null,
      startupDisplayToken: 0,
    };

    const runtime = createStartupRuntime({
      startupDisplay,
      startupState,
      startupSteps,
      startupStepMinProgressMs: 100,
    });

    runtime.beginStartupStep('my-relays-restore');
    expect(startupDisplay.value).toMatchObject({
      stepId: 'my-relays-restore',
      status: 'in_progress',
      showProgress: true,
    });

    runtime.updateStartupStep('my-relays-restore', { eventCount: 2 });
    expect(runtime.getStartupStepSnapshot('my-relays-restore')).toMatchObject({
      eventCount: 2,
    });

    runtime.completeStartupStep('my-relays-restore');
    expect(startupDisplay.value.status).toBe('in_progress');
    await vi.advanceTimersByTimeAsync(100);
    expect(startupDisplay.value.status).toBe('success');

    const batchTracker = runtime.createStartupBatchTracker('private-contact-relays');
    batchTracker.beginItem();
    batchTracker.beginItem();
    batchTracker.seal();
    batchTracker.finishItem();
    expect(
      runtime
        .getStartupStepSnapshot('private-contact-relays')
        .internalTasks.find((task) => task.id === 'private-contact-relays')
    ).toMatchObject({ status: 'in_progress' });
    batchTracker.finishItem();
    await vi.advanceTimersByTimeAsync(100);
    expect(
      runtime
        .getStartupStepSnapshot('private-contact-relays')
        .internalTasks.find((task) => task.id === 'private-contact-relays')
    ).toMatchObject({ status: 'success' });

    const failingTracker = runtime.createStartupBatchTracker('private-message-events');
    failingTracker.beginItem();
    failingTracker.finishItem(new Error('boom'));
    await vi.advanceTimersByTimeAsync(100);
    expect(
      runtime
        .getStartupStepSnapshot('private-message-events')
        .internalTasks.find((task) => task.id === 'private-message-events')
    ).toMatchObject({
      status: 'error',
      errorMessage: 'boom',
    });

    runtime.resetStartupStep('private-messages-subscribe');
    expect(runtime.getStartupStepSnapshot('private-messages-subscribe')).toMatchObject({
      status: 'pending',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      errorMessage: null,
      internalTasks: [],
    });

    runtime.resetStartupStepTracking();
    expect(startupDisplay.value).toEqual({
      stepId: null,
      label: null,
      status: null,
      showProgress: false,
    });
  });

  it('resolves auth identity from storage, NIP-07 presence, and signer state', async () => {
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;
    const localStorage = createMockStorage({
      [AUTH_METHOD_STORAGE_KEY]: 'unexpected',
      [PUBLIC_KEY_STORAGE_KEY]: expectedPubkey.toUpperCase(),
    });
    const signerUser = { pubkey: expectedPubkey } as never;
    const signer = {
      user: vi.fn(async () => signerUser),
    } as never;
    const ndk = new NDK();

    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
      nostr: {
        getPublicKey: vi.fn(),
        signEvent: vi.fn(),
      },
    };

    const runtime = createAuthIdentityRuntime({
      getOrCreateSigner: async () => signer,
      getPrivateKeyHex: () => privateKey,
      ndk,
    });

    expect(runtime.getStoredAuthMethod()).toBe('nsec');
    expect(runtime.getLoggedInPublicKeyHex()).toBe(expectedPubkey);
    expect(runtime.hasNip07Extension()).toBe(true);
    expect(runtime.encodeNpub(expectedPubkey)).toMatch(/^npub1/);
    expect(runtime.encodeNprofile(expectedPubkey)).toMatch(/^nprofile1/);
    expect(runtime.derivePublicKeyFromPrivateKey(privateKey)).toBe(expectedPubkey);
    expect(runtime.derivePublicKeyFromPrivateKey('invalid')).toBeNull();

    const user = await runtime.getLoggedInSignerUser();
    expect(user).toBe(signerUser);
    expect((user as { ndk?: unknown }).ndk).toBe(ndk);
  });

  it('serializes and persists developer traces with storage-backed toggles', async () => {
    const localStorage = createMockStorage({
      'developer-diagnostics-enabled': '0',
    });
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    expect(readDeveloperDiagnosticsEnabledFromStorage('developer-diagnostics-enabled')).toBe(false);

    const developerDiagnosticsEnabled = ref(true);
    const developerDiagnosticsVersion = ref(0);
    const developerTraceVersion = ref(0);
    const runtime = createDeveloperTraceRuntime({
      developerDiagnosticsEnabled,
      developerDiagnosticsVersion,
      developerTraceState: {
        developerTraceCounter: 0,
      },
      developerTraceVersion,
      developerDiagnosticsStorageKey: 'developer-diagnostics-enabled',
      getLoggedInPublicKeyHex: () => PUBKEY_A,
    });

    expect(runtime.toOptionalIsoTimestampFromUnix(1)).toBe('1970-01-01T00:00:01.000Z');
    expect(
      runtime.serializeDeveloperTraceValue({
        now: new Date('2026-01-01T00:00:00.000Z'),
        error: new Error('trace failed'),
        list: Array.from({ length: 35 }, (_, index) => index),
      })
    ).toMatchObject({
      now: '2026-01-01T00:00:00.000Z',
      error: {
        message: 'trace failed',
      },
    });
    expect(
      runtime.shouldEchoDeveloperTraceToConsole('subscription:private-messages', 'start')
    ).toBe(true);

    runtime.logDeveloperTrace('info', 'subscription:private-messages', 'start', {
      wrappedEvent: {
        id: EVENT_ID_A,
      },
    });
    runtime.logDeveloperTrace('info', 'subscription:private-messages', 'req', {
      relayUrls: ['wss://relay.one', 'wss://relay.two'],
      reqStatement: ['REQ', 'private-messages-1', '{"kinds":[4],"limit":100}'],
      subId: 'private-messages-1',
    });
    await flushPromises();

    expect(
      runtime.buildConsoleTracePrefixArgs('subscription:private-messages', 'req', {
        relayUrls: ['wss://relay.one', 'wss://relay.two'],
        reqStatement: ['REQ', 'private-messages-1', '{"kinds":[4],"limit":100}'],
      })
    ).toEqual([
      'relays=wss://relay.one, wss://relay.two',
      'reqStatement=["REQ","private-messages-1","{\\"kinds\\":[4],\\"limit\\":100}"]',
    ]);
    expect(developerTraceDataServiceMock.appendEntry).toHaveBeenCalledTimes(2);
    expect(developerTraceVersion.value).toBe(2);
    expect(console.info).toHaveBeenCalledWith(
      '[subscription:private-messages] req',
      'relays=wss://relay.one, wss://relay.two',
      'reqStatement=["REQ","private-messages-1","{\\"kinds\\":[4],\\"limit\\":100}"]',
      expect.objectContaining({
        relayUrls: ['wss://relay.one', 'wss://relay.two'],
        reqStatement: ['REQ', 'private-messages-1', '{"kinds":[4],"limit":100}'],
        subId: 'private-messages-1',
      })
    );

    runtime.setDeveloperDiagnosticsEnabled(false);
    await flushPromises();
    expect(localStorage.api.setItem).toHaveBeenCalledWith('developer-diagnostics-enabled', '0');
    expect(developerTraceDataServiceMock.clearEntries).toHaveBeenCalledTimes(1);
    expect(developerDiagnosticsVersion.value).toBe(1);
    expect(developerDiagnosticsEnabled.value).toBe(false);
  });

  it('builds relay diagnostics snapshots and forwards relay lifecycle logs', () => {
    const logDeveloperTrace = vi.fn();
    const relay = {
      url: 'wss://relay.example/',
      connected: true,
      status: NDKRelayStatus.CONNECTED,
      connectionStats: {
        attempts: 2,
        success: 1,
        connectedAt: 123,
        nextReconnectAt: 456,
        validationRatio: 0.5,
        durations: [11, 22],
      },
    };
    const ndk = {
      pool: {
        getRelay: vi.fn(() => relay),
        stats: vi.fn(() => ({
          total: 1,
        })),
      },
    } as never;

    const runtime = createDeveloperRelayRuntime({
      logDeveloperTrace,
      ndk,
    });

    expect(runtime.buildRelaySnapshot(null)).toMatchObject({
      present: false,
      url: null,
      statusName: null,
    });
    expect(runtime.getRelaySnapshots(['wss://relay.example'])).toEqual([
      expect.objectContaining({
        present: true,
        url: 'wss://relay.example/',
        lastDurationMs: 22,
      }),
    ]);

    runtime.logRelayLifecycle('connected', relay as never);
    runtime.logMessageRelayDiagnostics(
      'appended',
      {
        relayCount: 1,
      },
      'warn'
    );

    expect(logDeveloperTrace).toHaveBeenNthCalledWith(
      1,
      'info',
      'relay',
      'connected',
      expect.objectContaining({
        url: 'wss://relay.example/',
        pool: {
          total: 1,
        },
      })
    );
    expect(logDeveloperTrace).toHaveBeenNthCalledWith(2, 'warn', 'message-relays', 'appended', {
      relayCount: 1,
    });
  });

  it('builds inbound message presentation details and browser notifications', async () => {
    const localStorage = createMockStorage();
    const assign = vi.fn();
    const desktopNotification = vi.fn();
    const focus = vi.fn();
    const notifications: Array<{
      title: string;
      options: NotificationOptions;
      close: ReturnType<typeof vi.fn>;
      onclick: (() => void) | null;
    }> = [];

    class FakeNotification {
      onclick: (() => void) | null = null;
      close = vi.fn();

      constructor(
        public title: string,
        public options: NotificationOptions
      ) {
        notifications.push(this);
      }
    }

    (globalThis as Record<string, unknown>).window = {
      Notification: FakeNotification,
      desktopRuntime: {
        isElectron: true,
        platform: 'darwin',
        setUnreadChatBadge: vi.fn(),
        showIncomingMessageNotification: desktopNotification,
        onOpenChatFromNotification: vi.fn(() => () => {}),
      },
      focus,
      localStorage: localStorage.api,
      location: {
        origin: 'https://chat.example',
        assign,
      },
    };
    (globalThis as Record<string, unknown>).document = {
      visibilityState: 'visible',
      hasFocus: vi.fn(() => true),
    };
    process.env.VUE_ROUTER_BASE = '/app';
    process.env.VUE_ROUTER_MODE = 'hash';
    const isAppForeground = ref(true);

    const runtime = createInboundPresentationRuntime({
      formatSubscriptionLogValue: (value) =>
        value && value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : (value ?? null),
      getLoggedInPublicKeyHex: () => PUBKEY_A,
      getVisibleChatId: () => PUBKEY_A,
      isAppForeground,
      isRestoringStartupState: ref(false),
      logDeveloperTrace: vi.fn(),
      normalizeEventId: (value) =>
        typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null,
    });

    expect(
      runtime.buildInboundTraceDetails({
        wrappedEvent: {
          id: EVENT_ID_A.toUpperCase(),
          kind: 1059,
          created_at: 1700000000,
        },
        senderPubkeyHex: PUBKEY_B,
        relayUrls: ['wss://relay.example', ''],
        recipients: [PUBKEY_A, ''],
      })
    ).toMatchObject({
      wrappedKind: 1059,
      relayCount: 1,
      recipientCount: 1,
    });
    expect(
      runtime.deriveChatName(
        {
          name: 'Fallback Name',
          meta: {
            display_name: 'Display Name',
            name: 'Profile Name',
          },
        } as never,
        PUBKEY_A
      )
    ).toBe('Display Name');

    expect(
      await runtime.shouldNotifyForAcceptedChatOnly(PUBKEY_A, { inbox_state: 'blocked' })
    ).toBe(false);
    expect(
      await runtime.shouldNotifyForAcceptedChatOnly(PUBKEY_A, {
        inbox_state: 'accepted',
        muted: true,
      })
    ).toBe(false);
    expect(await runtime.shouldNotifyForAcceptedChatOnly(PUBKEY_A, { accepted_at: 'now' })).toBe(
      true
    );
    chatDataServiceMock.listMessages.mockResolvedValue([
      {
        author_public_key: PUBKEY_B,
      },
      {
        author_public_key: PUBKEY_A,
      },
    ] as never);
    expect(await runtime.shouldNotifyForAcceptedChatOnly(PUBKEY_A, {})).toBe(true);

    runtime.showIncomingMessageBrowserNotification({
      chatPubkey: PUBKEY_A,
      title: 'Suppressed',
      messageText: 'This should not be shown',
    });
    expect(notifications).toHaveLength(0);

    isAppForeground.value = false;
    runtime.showIncomingMessageBrowserNotification({
      chatPubkey: PUBKEY_B,
      title: 'New message',
      messageText: 'x'.repeat(200),
      iconUrl: 'https://example.com/icon.png',
    });
    expect(desktopNotification).toHaveBeenCalledWith({
      chatPubkey: PUBKEY_B,
      title: 'New message',
      body: `${'x'.repeat(137)}...`,
    });
    expect(notifications).toHaveLength(0);

    delete (window as typeof window & { desktopRuntime?: unknown }).desktopRuntime;
    runtime.showIncomingMessageBrowserNotification({
      chatPubkey: PUBKEY_B,
      title: 'Browser fallback',
      messageText: 'fallback message',
      iconUrl: 'https://example.com/icon.png',
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe('Browser fallback');
    expect(notifications[0]?.options.body).toBe('fallback message');
    notifications[0]?.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      `https://chat.example/app/#/chats/${encodeURIComponent(PUBKEY_B)}`
    );
  });
});
