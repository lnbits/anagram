import type { NostrEvent } from '#src/lib/nostr/client.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
import type {
  PendingIncomingDeletion,
  PendingIncomingReaction,
  QueuePrivateMessageUiRefreshOptions,
} from '#src/stores/nostr/types.ts';
import type { MessageRelayStatus, NostrEventDirection } from '#src/types/chat.ts';

interface MessageRelayRuntimeDeps {
  bumpDeveloperDiagnosticsVersion: () => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  logMessageRelayDiagnostics: (
    phase: string,
    details: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error'
  ) => void;
  normalizeEventId: (value: unknown) => string | null;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  normalizeThrottleMs: (value: number | undefined) => number;
  pendingIncomingDeletions: Map<string, PendingIncomingDeletion[]>;
  pendingIncomingReactions: Map<string, PendingIncomingReaction[]>;
  queuePrivateMessagesUiRefresh: (options?: QueuePrivateMessageUiRefreshOptions) => void;
  refreshPendingIncomingQueues: () => Promise<void>;
}

export function createMessageRelayRuntime({
  bumpDeveloperDiagnosticsVersion,
  formatSubscriptionLogValue,
  logMessageRelayDiagnostics,
  normalizeEventId,
  normalizeRelayStatusUrls,
  normalizeThrottleMs,
  pendingIncomingDeletions,
  pendingIncomingReactions,
  queuePrivateMessagesUiRefresh,
  refreshPendingIncomingQueues,
}: MessageRelayRuntimeDeps) {
  async function refreshMessageInLiveState(messageId: number): Promise<void> {
    try {
      const { useMessageStore } = await import('#src/stores/messageStore.ts');
      await useMessageStore().refreshPersistedMessage(messageId);
    } catch (error) {
      console.error('Failed to sync persisted message into live state', error);
    }
  }

  async function appendRelayStatusesToMessageEvent(
    messageId: number,
    relayStatuses: MessageRelayStatus[],
    options: {
      event?: NostrEvent;
      direction?: NostrEventDirection;
      eventId?: string;
      uiThrottleMs?: number;
    } = {}
  ): Promise<void> {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      logMessageRelayDiagnostics('skip', {
        reason: 'invalid-message-id',
        messageId,
        relayStatusCount: relayStatuses.length,
        eventId: formatSubscriptionLogValue(options.eventId ?? options.event?.id ?? null),
      });
      return;
    }

    if (relayStatuses.length === 0) {
      return;
    }

    const currentMessage = await chatDataService.getMessageById(messageId);
    if (!currentMessage) {
      logMessageRelayDiagnostics('skip', {
        reason: 'message-not-found',
        messageId,
        relayStatusCount: relayStatuses.length,
        eventId: formatSubscriptionLogValue(options.eventId ?? options.event?.id ?? null),
      });
      return;
    }

    const normalizedStoredEventId = normalizeEventId(
      options.eventId ?? options.event?.id ?? currentMessage.event_id
    );
    if (!normalizedStoredEventId) {
      logMessageRelayDiagnostics('skip', {
        reason: 'missing-event-id',
        messageId: currentMessage.id,
        relayStatusCount: relayStatuses.length,
        currentMessageEventId: formatSubscriptionLogValue(currentMessage.event_id),
        optionEventId: formatSubscriptionLogValue(options.eventId ?? options.event?.id ?? null),
      });
      return;
    }

    const didBindPersistedEventId = currentMessage.event_id !== normalizedStoredEventId;
    if (didBindPersistedEventId) {
      await chatDataService.updateMessageEventId(currentMessage.id, normalizedStoredEventId);
    }

    if (
      didBindPersistedEventId &&
      (pendingIncomingReactions.has(normalizedStoredEventId) ||
        pendingIncomingDeletions.has(normalizedStoredEventId))
    ) {
      await refreshPendingIncomingQueues();
    }

    await nostrEventDataService.appendRelayStatuses(normalizedStoredEventId, relayStatuses, {
      event: options.event
        ? {
            ...options.event,
            id: normalizedStoredEventId,
          }
        : undefined,
      direction: options.direction,
    });

    const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);
    logMessageRelayDiagnostics('appended', {
      messageId: currentMessage.id,
      eventId: formatSubscriptionLogValue(normalizedStoredEventId),
      relayStatusCount: relayStatuses.length,
      direction: options.direction ?? null,
      uiThrottleMs,
      refreshMode: uiThrottleMs > 0 ? 'queued-ui-refresh' : 'live-state-refresh',
    });
    if (uiThrottleMs > 0) {
      queuePrivateMessagesUiRefresh({
        throttleMs: uiThrottleMs,
        reloadMessages: true,
      });
      return;
    }

    await refreshMessageInLiveState(currentMessage.id);
  }

  function buildInboundRelayStatuses(relayUrls: string[]): MessageRelayStatus[] {
    const updatedAt = new Date().toISOString();

    return normalizeRelayStatusUrls(relayUrls).map((relayUrl) => ({
      relay_url: relayUrl,
      direction: 'inbound',
      status: 'received',
      scope: 'subscription',
      updated_at: updatedAt,
    }));
  }

  function queuePendingIncomingReaction(
    targetEventId: string,
    pendingReaction: PendingIncomingReaction
  ): void {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      return;
    }

    const existingEntries = pendingIncomingReactions.get(normalizedTargetEventId) ?? [];
    const alreadyQueued = existingEntries.some((entry) => {
      return (
        entry.chatPublicKey === pendingReaction.chatPublicKey &&
        entry.targetAuthorPublicKey === pendingReaction.targetAuthorPublicKey &&
        entry.reaction.emoji === pendingReaction.reaction.emoji &&
        entry.reaction.reactorPublicKey === pendingReaction.reaction.reactorPublicKey
      );
    });
    if (alreadyQueued) {
      return;
    }

    pendingIncomingReactions.set(normalizedTargetEventId, [...existingEntries, pendingReaction]);
    bumpDeveloperDiagnosticsVersion();
  }

  function removePendingIncomingReaction(
    targetEventId: string,
    reactionEventId: string,
    reactorPublicKey: string
  ): void {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    const normalizedReactionEventId = normalizeEventId(reactionEventId);
    const normalizedReactorPublicKey = inputSanitizerService.normalizeHexKey(reactorPublicKey);
    if (!normalizedTargetEventId || !normalizedReactionEventId || !normalizedReactorPublicKey) {
      return;
    }

    const existingEntries = pendingIncomingReactions.get(normalizedTargetEventId) ?? [];
    if (existingEntries.length === 0) {
      return;
    }

    const remainingEntries = existingEntries.filter((entry) => {
      return !(
        normalizeEventId(entry.reaction.eventId) === normalizedReactionEventId &&
        entry.reaction.reactorPublicKey === normalizedReactorPublicKey
      );
    });

    if (remainingEntries.length > 0) {
      pendingIncomingReactions.set(normalizedTargetEventId, remainingEntries);
    } else {
      pendingIncomingReactions.delete(normalizedTargetEventId);
    }

    bumpDeveloperDiagnosticsVersion();
  }

  function queuePendingIncomingDeletion(
    targetEventId: string,
    pendingDeletion: PendingIncomingDeletion
  ): void {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      return;
    }

    const existingEntries = pendingIncomingDeletions.get(normalizedTargetEventId) ?? [];
    const alreadyQueued = existingEntries.some((entry) => {
      return (
        entry.deletionAuthorPublicKey === pendingDeletion.deletionAuthorPublicKey &&
        entry.targetKind === pendingDeletion.targetKind
      );
    });
    if (alreadyQueued) {
      return;
    }

    pendingIncomingDeletions.set(normalizedTargetEventId, [...existingEntries, pendingDeletion]);
    bumpDeveloperDiagnosticsVersion();
  }

  function consumePendingIncomingReactions(targetEventId: string): PendingIncomingReaction[] {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      return [];
    }

    const entries = pendingIncomingReactions.get(normalizedTargetEventId) ?? [];
    pendingIncomingReactions.delete(normalizedTargetEventId);
    if (entries.length > 0) {
      bumpDeveloperDiagnosticsVersion();
    }
    return entries;
  }

  function consumePendingIncomingDeletions(targetEventId: string): PendingIncomingDeletion[] {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      return [];
    }

    const entries = pendingIncomingDeletions.get(normalizedTargetEventId) ?? [];
    pendingIncomingDeletions.delete(normalizedTargetEventId);
    if (entries.length > 0) {
      bumpDeveloperDiagnosticsVersion();
    }
    return entries;
  }

  return {
    appendRelayStatusesToMessageEvent,
    buildInboundRelayStatuses,
    consumePendingIncomingDeletions,
    consumePendingIncomingReactions,
    queuePendingIncomingDeletion,
    queuePendingIncomingReaction,
    refreshMessageInLiveState,
    removePendingIncomingReaction,
  };
}
