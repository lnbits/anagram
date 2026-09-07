import { NDKKind } from '@nostr-dev-kit/ndk';
import { createOutboundMessageReplayRuntime } from 'src/stores/nostr/outboundMessageReplayRuntime';
import type { MessageRelayStatus } from 'src/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    getMessageByEventId: vi.fn(),
    init: vi.fn(),
  },
  nostrEventDataService: {
    init: vi.fn(),
    listEventsByDirection: vi.fn(),
  },
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/nostrEventDataService', () => ({
  nostrEventDataService: serviceMocks.nostrEventDataService,
}));

function makeRelayStatus(
  overrides: Partial<MessageRelayStatus> & Pick<MessageRelayStatus, 'relay_url'>
): MessageRelayStatus {
  return {
    relay_url: overrides.relay_url,
    direction: overrides.direction ?? 'outbound',
    scope: overrides.scope ?? 'recipient',
    status: overrides.status ?? 'failed',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    ...(overrides.detail ? { detail: overrides.detail } : {}),
  };
}

describe('outboundMessageReplayRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      onLine: true,
    });
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue({
      id: 7,
    });
    serviceMocks.nostrEventDataService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.listEventsByDirection.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries persisted pending and failed DM relay targets', async () => {
    const retryDirectMessageRelay = vi.fn().mockResolvedValue(undefined);
    const logMessageRelayDiagnostics = vi.fn();
    serviceMocks.nostrEventDataService.listEventsByDirection.mockResolvedValue([
      {
        direction: 'out',
        event: {
          id: 'event-1',
          kind: NDKKind.PrivateDirectMessage,
        },
        relay_statuses: [
          makeRelayStatus({
            relay_url: 'wss://relay-pending',
            status: 'pending',
            scope: 'recipient',
          }),
          makeRelayStatus({
            relay_url: 'wss://relay-failed',
            status: 'failed',
            scope: 'self',
          }),
          makeRelayStatus({
            relay_url: 'wss://relay-published',
            status: 'published',
            scope: 'recipient',
          }),
        ],
      },
      {
        direction: 'out',
        event: {
          id: 'event-2',
          kind: NDKKind.Reaction,
        },
        relay_statuses: [
          makeRelayStatus({
            relay_url: 'wss://relay-reaction',
            status: 'failed',
            scope: 'recipient',
          }),
        ],
      },
    ]);

    const runtime = createOutboundMessageReplayRuntime({
      getLoggedInPublicKeyHex: () => 'f'.repeat(64),
      logMessageRelayDiagnostics,
      retryDirectMessageRelay,
    });

    await runtime.runOutboundMessageReplay('startup');
    runtime.resetOutboundMessageReplayRuntimeState();

    expect(serviceMocks.nostrEventDataService.listEventsByDirection).toHaveBeenCalledWith('out');
    expect(retryDirectMessageRelay).toHaveBeenNthCalledWith(
      1,
      7,
      'wss://relay-pending',
      'recipient',
      { trigger: 'outbox:startup' }
    );
    expect(retryDirectMessageRelay).toHaveBeenNthCalledWith(2, 7, 'wss://relay-failed', 'self', {
      trigger: 'outbox:startup',
    });
    expect(retryDirectMessageRelay).toHaveBeenCalledTimes(2);
    expect(logMessageRelayDiagnostics).toHaveBeenCalledWith(
      'outbox-retry-start',
      expect.objectContaining({
        reason: 'startup',
        messageId: 7,
        eventId: 'event-1',
      })
    );
    expect(logMessageRelayDiagnostics).toHaveBeenCalledWith(
      'outbox-replay-complete',
      expect.objectContaining({
        reason: 'startup',
        attemptedRelayCount: 2,
        replayedEventCount: 1,
      })
    );
  });

  it('respects cooldown for periodic, startup and browser-online triggers', async () => {
    const retryDirectMessageRelay = vi.fn().mockResolvedValue(undefined);
    const logMessageRelayDiagnostics = vi.fn();
    const relayStatus = makeRelayStatus({
      relay_url: 'wss://relay-failed',
      status: 'failed',
      scope: 'recipient',
      updated_at: new Date().toISOString(),
    });
    serviceMocks.nostrEventDataService.listEventsByDirection.mockResolvedValue([
      {
        direction: 'out',
        event: {
          id: 'event-1',
          kind: NDKKind.PrivateDirectMessage,
        },
        relay_statuses: [relayStatus],
      },
    ]);

    const runtime = createOutboundMessageReplayRuntime({
      getLoggedInPublicKeyHex: () => 'f'.repeat(64),
      logMessageRelayDiagnostics,
      retryDirectMessageRelay,
    });

    await runtime.runOutboundMessageReplay('periodic-sweep');
    expect(retryDirectMessageRelay).not.toHaveBeenCalled();

    await runtime.startOutboundMessageReplay();
    const addEventListenerMock = vi.mocked(window.addEventListener);
    const onlineHandler = addEventListenerMock.mock.calls.find(
      ([eventName]) => eventName === 'online'
    )?.[1] as (() => void) | undefined;
    expect(onlineHandler).toBeTypeOf('function');

    onlineHandler?.();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTicks();
    runtime.resetOutboundMessageReplayRuntimeState();

    expect(retryDirectMessageRelay).not.toHaveBeenCalled();
    expect(window.removeEventListener).toHaveBeenCalledWith('online', onlineHandler);
  });
});
