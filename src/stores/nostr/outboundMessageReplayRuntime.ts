import { NDKKind } from '@nostr-dev-kit/ndk';
import { chatDataService } from 'src/services/chatDataService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import {
  OUTBOUND_MESSAGE_REPLAY_MAX_RETRY_TARGETS_PER_SWEEP,
  OUTBOUND_MESSAGE_REPLAY_ONLINE_DELAY_MS,
  OUTBOUND_MESSAGE_REPLAY_RELAY_RECONNECT_DELAY_MS,
  OUTBOUND_MESSAGE_REPLAY_RETRY_COOLDOWN_MS,
  OUTBOUND_MESSAGE_REPLAY_STARTUP_DELAY_MS,
  OUTBOUND_MESSAGE_REPLAY_SWEEP_INTERVAL_MS,
} from 'src/stores/nostr/constants';
import type { MessageRelayStatus } from 'src/types/chat';

interface RetryDirectMessageRelayOptions {
  trigger?: string;
}

interface OutboundMessageReplayRuntimeDeps {
  getLoggedInPublicKeyHex: () => string | null;
  logMessageRelayDiagnostics: (
    phase: string,
    details: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error'
  ) => void;
  retryDirectMessageRelay: (
    messageId: number,
    relayUrl: string,
    scope: 'recipient' | 'self',
    options?: RetryDirectMessageRelayOptions
  ) => Promise<void>;
}

type OutboundReplayReason =
  | 'startup'
  | 'browser-online'
  | 'relay-connected'
  | 'periodic-sweep'
  | 'reconnect-healing';

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function toRetryAgeMs(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Date.now() - parsed);
}

function shouldReplayRelayStatus(
  relayStatus: MessageRelayStatus,
  _options: {
    forceImmediate: boolean;
  }
): relayStatus is MessageRelayStatus & {
  direction: 'outbound';
  scope: 'recipient' | 'self';
  status: 'pending' | 'failed';
} {
  if (
    relayStatus.direction !== 'outbound' ||
    (relayStatus.scope !== 'recipient' && relayStatus.scope !== 'self') ||
    (relayStatus.status !== 'pending' && relayStatus.status !== 'failed')
  ) {
    return false;
  }

  return toRetryAgeMs(relayStatus.updated_at) >= OUTBOUND_MESSAGE_REPLAY_RETRY_COOLDOWN_MS;
}

function sortReplayRelayStatuses(
  relayStatuses: Array<
    MessageRelayStatus & {
      direction: 'outbound';
      scope: 'recipient' | 'self';
      status: 'pending' | 'failed';
    }
  >
): Array<
  MessageRelayStatus & {
    direction: 'outbound';
    scope: 'recipient' | 'self';
    status: 'pending' | 'failed';
  }
> {
  const statusPriority: Record<'pending' | 'failed', number> = {
    pending: 0,
    failed: 1,
  };

  return relayStatuses.slice().sort((first, second) => {
    const byStatus = statusPriority[first.status] - statusPriority[second.status];
    if (byStatus !== 0) {
      return byStatus;
    }

    const byUpdatedAt = Date.parse(first.updated_at) - Date.parse(second.updated_at);
    if (Number.isFinite(byUpdatedAt) && byUpdatedAt !== 0) {
      return byUpdatedAt;
    }

    const byScope = first.scope.localeCompare(second.scope);
    if (byScope !== 0) {
      return byScope;
    }

    return first.relay_url.localeCompare(second.relay_url);
  });
}

export function createOutboundMessageReplayRuntime({
  getLoggedInPublicKeyHex,
  logMessageRelayDiagnostics,
  retryDirectMessageRelay,
}: OutboundMessageReplayRuntimeDeps) {
  let outboundMessageReplayTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let outboundMessageReplayScheduledAt = 0;
  let outboundMessageReplayRunPromise: Promise<void> | null = null;
  let outboundMessageReplayQueuedReason: OutboundReplayReason | null = null;
  let outboundMessageReplayQueuedDelayMs: number | null = null;
  let hasOutboundMessageReplayOnlineListener = false;
  let started = false;
  const connectedRelayUrls = new Set<string>();
  const lastAttempts = new Map<string, number>();

  function clearReplayTimer(): void {
    if (outboundMessageReplayTimeoutId !== null) {
      globalThis.clearTimeout(outboundMessageReplayTimeoutId);
      outboundMessageReplayTimeoutId = null;
    }
    outboundMessageReplayScheduledAt = 0;
  }

  function handleOutboundMessageReplayBrowserOnline(): void {
    if (!getLoggedInPublicKeyHex()) {
      return;
    }

    queueOutboundMessageReplay('browser-online', OUTBOUND_MESSAGE_REPLAY_ONLINE_DELAY_MS);
  }

  function ensureOutboundMessageReplayWatchdog(): void {
    if (!hasWindow()) {
      return;
    }

    if (!hasOutboundMessageReplayOnlineListener) {
      window.addEventListener('online', handleOutboundMessageReplayBrowserOnline);
      hasOutboundMessageReplayOnlineListener = true;
    }
  }

  function queueReplayWhileRunning(reason: OutboundReplayReason, delayMs: number): void {
    if (
      outboundMessageReplayQueuedReason === null ||
      outboundMessageReplayQueuedDelayMs === null ||
      delayMs < outboundMessageReplayQueuedDelayMs
    ) {
      outboundMessageReplayQueuedReason = reason;
      outboundMessageReplayQueuedDelayMs = delayMs;
    }
  }

  function queueOutboundMessageReplay(
    reason: OutboundReplayReason,
    delayMs = OUTBOUND_MESSAGE_REPLAY_SWEEP_INTERVAL_MS
  ): void {
    if (!hasWindow() || !getLoggedInPublicKeyHex()) {
      return;
    }

    const normalizedDelayMs = Math.max(0, Math.floor(delayMs));

    if (outboundMessageReplayRunPromise) {
      // Equivalent lifecycle notifications join the current pass.
      if (reason === 'relay-connected') queueReplayWhileRunning(reason, normalizedDelayMs);
      return;
    }

    const nextScheduledAt = Date.now() + normalizedDelayMs;
    if (
      outboundMessageReplayTimeoutId !== null &&
      outboundMessageReplayScheduledAt > 0 &&
      outboundMessageReplayScheduledAt <= nextScheduledAt
    ) {
      return;
    }

    clearReplayTimer();
    outboundMessageReplayScheduledAt = nextScheduledAt;
    outboundMessageReplayTimeoutId = globalThis.setTimeout(() => {
      clearReplayTimer();
      void runOutboundMessageReplay(reason);
    }, normalizedDelayMs);
  }

  async function runOutboundMessageReplay(reason: OutboundReplayReason): Promise<void> {
    if (outboundMessageReplayRunPromise) {
      return outboundMessageReplayRunPromise;
    }

    outboundMessageReplayRunPromise = (async () => {
      if (!getLoggedInPublicKeyHex()) {
        return;
      }

      if (isBrowserOffline()) {
        logMessageRelayDiagnostics('outbox-replay-skip', {
          reason,
          skipReason: 'browser-offline',
        });
        return;
      }

      const relayScope = reason === 'relay-connected' ? new Set(connectedRelayUrls) : null;
      connectedRelayUrls.clear();
      let attemptedRelayCount = 0;
      let replayedEventCount = 0;
      let skippedEventCount = 0;

      await Promise.all([chatDataService.init(), nostrEventDataService.init()]);
      const outboundEvents = await nostrEventDataService.listEventsByDirection('out');

      outer: for (const outboundEvent of outboundEvents) {
        if (
          outboundEvent.direction !== 'out' ||
          outboundEvent.event.kind !== NDKKind.PrivateDirectMessage
        ) {
          continue;
        }

        const retryableRelayStatuses = sortReplayRelayStatuses(
          outboundEvent.relay_statuses
            .filter((relayStatus) =>
              shouldReplayRelayStatus(relayStatus, { forceImmediate: false })
            )
            .filter(
              (relayStatus) =>
                (!relayScope ||
                  relayScope.has(
                    inputSanitizerService.normalizeRelayWs(relayStatus.relay_url) ?? ''
                  )) &&
                Date.now() -
                  (lastAttempts.get(
                    `${outboundEvent.event.id}:${relayStatus.scope}:${relayStatus.relay_url}`
                  ) ?? 0) >=
                  OUTBOUND_MESSAGE_REPLAY_RETRY_COOLDOWN_MS
            )
        );
        if (retryableRelayStatuses.length === 0) {
          continue;
        }

        const message = await chatDataService.getMessageByEventId(outboundEvent.event.id);
        if (!message) {
          skippedEventCount += 1;
          logMessageRelayDiagnostics(
            'outbox-replay-skip',
            {
              reason,
              skipReason: 'message-not-found',
              eventId: outboundEvent.event.id,
              relayCount: retryableRelayStatuses.length,
            },
            'warn'
          );
          continue;
        }

        replayedEventCount += 1;
        for (const relayStatus of retryableRelayStatuses) {
          if (attemptedRelayCount >= OUTBOUND_MESSAGE_REPLAY_MAX_RETRY_TARGETS_PER_SWEEP) {
            break outer;
          }

          lastAttempts.set(
            `${outboundEvent.event.id}:${relayStatus.scope}:${relayStatus.relay_url}`,
            Date.now()
          );
          attemptedRelayCount += 1;
          logMessageRelayDiagnostics('outbox-retry-start', {
            reason,
            messageId: message.id,
            eventId: outboundEvent.event.id,
            relayUrl: relayStatus.relay_url,
            scope: relayStatus.scope,
            previousStatus: relayStatus.status,
          });

          try {
            await retryDirectMessageRelay(message.id, relayStatus.relay_url, relayStatus.scope, {
              trigger: `outbox:${reason}`,
            });
            logMessageRelayDiagnostics('outbox-retry-success', {
              reason,
              messageId: message.id,
              eventId: outboundEvent.event.id,
              relayUrl: relayStatus.relay_url,
              scope: relayStatus.scope,
            });
          } catch (error) {
            logMessageRelayDiagnostics(
              'outbox-retry-failed',
              {
                reason,
                messageId: message.id,
                eventId: outboundEvent.event.id,
                relayUrl: relayStatus.relay_url,
                scope: relayStatus.scope,
                error: error instanceof Error ? error.message : String(error ?? ''),
              },
              'warn'
            );
          }
        }
      }

      if (attemptedRelayCount > 0 || skippedEventCount > 0) {
        logMessageRelayDiagnostics('outbox-replay-complete', {
          reason,
          replayedEventCount,
          attemptedRelayCount,
          skippedEventCount,
          maxRetryTargetsPerSweep: OUTBOUND_MESSAGE_REPLAY_MAX_RETRY_TARGETS_PER_SWEEP,
        });
      }
    })().finally(() => {
      outboundMessageReplayRunPromise = null;

      if (
        outboundMessageReplayQueuedReason !== null &&
        outboundMessageReplayQueuedDelayMs !== null &&
        getLoggedInPublicKeyHex()
      ) {
        const nextReason = outboundMessageReplayQueuedReason;
        const nextDelayMs = outboundMessageReplayQueuedDelayMs;
        outboundMessageReplayQueuedReason = null;
        outboundMessageReplayQueuedDelayMs = null;
        queueOutboundMessageReplay(nextReason, nextDelayMs);
        return;
      }

      outboundMessageReplayQueuedReason = null;
      outboundMessageReplayQueuedDelayMs = null;

      if (hasWindow() && getLoggedInPublicKeyHex()) {
        queueOutboundMessageReplay('periodic-sweep', OUTBOUND_MESSAGE_REPLAY_SWEEP_INTERVAL_MS);
      }
    });

    return outboundMessageReplayRunPromise;
  }

  async function startOutboundMessageReplay(): Promise<void> {
    ensureOutboundMessageReplayWatchdog();
    if (started) return;
    started = true;
    queueOutboundMessageReplay('startup', OUTBOUND_MESSAGE_REPLAY_STARTUP_DELAY_MS);
  }

  function notifyRelayConnected(relayUrl: string): void {
    const normalized = inputSanitizerService.normalizeRelayWs(relayUrl);
    if (!normalized) return;
    connectedRelayUrls.add(normalized);
    queueOutboundMessageReplay('relay-connected', OUTBOUND_MESSAGE_REPLAY_RELAY_RECONNECT_DELAY_MS);
  }

  function resetOutboundMessageReplayRuntimeState(): void {
    clearReplayTimer();
    started = false;
    connectedRelayUrls.clear();
    lastAttempts.clear();
    outboundMessageReplayQueuedReason = null;
    outboundMessageReplayQueuedDelayMs = null;
    outboundMessageReplayRunPromise = null;

    if (hasWindow() && hasOutboundMessageReplayOnlineListener) {
      window.removeEventListener('online', handleOutboundMessageReplayBrowserOnline);
      hasOutboundMessageReplayOnlineListener = false;
    }
  }

  return {
    notifyRelayConnected,
    queueOutboundMessageReplay,
    resetOutboundMessageReplayRuntimeState,
    runOutboundMessageReplay,
    startOutboundMessageReplay,
  };
}
