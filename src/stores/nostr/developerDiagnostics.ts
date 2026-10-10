import type NostrClient from '#src/lib/nostr/client.ts';
import { NostrKind, normalizeRelayUrl } from '#src/lib/nostr/client.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { useNip65RelayStore } from '#src/stores/nip65RelayStore.ts';
import {
  GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY,
  GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY,
  GROUP_EPOCH_KEYS_CHAT_META_KEY,
  PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
} from '#src/stores/nostr/constants.ts';
import type {
  AuthMethod,
  DeveloperDiagnosticsSnapshot,
  DeveloperGroupMessageSubscriptionSnapshot,
  DeveloperPendingDeletionSnapshot,
  DeveloperPendingQueueRefreshSummary,
  DeveloperPendingReactionSnapshot,
  DeveloperRelayRow,
  DeveloperRelaySnapshot,
  Nip46SessionSnapshot,
  PendingIncomingDeletion,
  PendingIncomingReaction,
  RelayConnectionState,
} from '#src/stores/nostr/types.ts';
import { useRelayStore } from '#src/stores/relayStore.ts';
import type { ContactMetadata } from '#src/types/contact.ts';
import type { Ref } from '#src/lib/state/reactivity.ts';

interface DeveloperDiagnosticsDeps {
  applyPendingIncomingDeletionsForMessage: (
    message: Awaited<ReturnType<typeof chatDataService.getMessageByEventId>>,
    options?: { uiThrottleMs?: number },
  ) => Promise<Awaited<ReturnType<typeof chatDataService.getMessageByEventId>>>;
  applyPendingIncomingReactionsForMessage: (
    message: Awaited<ReturnType<typeof chatDataService.getMessageByEventId>>,
    options?: { uiThrottleMs?: number },
  ) => Promise<Awaited<ReturnType<typeof chatDataService.getMessageByEventId>>>;
  buildRelaySnapshot: (relay: unknown) => DeveloperRelaySnapshot;
  bumpDeveloperDiagnosticsVersion: () => void;
  configuredRelayUrls: Set<string>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  ensureStoredEventSince: () => number;
  flushPrivateMessagesUiRefreshNow: () => void;
  getAppRelayUrls: () => string[];
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getNip46SignerSessionSnapshot: () => Nip46SessionSnapshot;
  getPrivateMessagesRestoreThrottleMs: () => number;
  getPrivateMessagesSubscription: () => unknown;
  getPrivateMessagesSubscriptionSignature: () => string | null;
  getRelayConnectionState: (relayUrl: string) => RelayConnectionState;
  getRelaySnapshots: (relayUrls: string[]) => DeveloperRelaySnapshot[];
  getStoredAuthMethod: () => AuthMethod | null;
  hasNip07Extension: () => boolean;
  isRestoringStartupState: Ref<boolean>;
  listPrivateMessageRecipientPubkeys: () => Promise<string[]>;
  ndk: NostrClient;
  normalizeChatGroupEpochKeys: (value: unknown) => Array<{
    epoch_number: number;
    epoch_public_key: string;
    epoch_private_key_encrypted: string;
    invitation_created_at?: string;
  }>;
  normalizeEventId: (value: unknown) => string | null;
  normalizeRelayStatusUrl: (value: string) => string | null;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  pendingIncomingDeletions: Map<string, PendingIncomingDeletion[]>;
  pendingIncomingReactions: Map<string, PendingIncomingReaction[]>;
  privateMessagesSubscriptionLastEoseAt: Ref<string | null>;
  privateMessagesSubscriptionLastEventCreatedAt: Ref<number | null>;
  privateMessagesSubscriptionLastEventId: Ref<string | null>;
  privateMessagesSubscriptionLastEventSeenAt: Ref<string | null>;
  privateMessagesSubscriptionLiveCoverageAt: Ref<number | null>;
  privateMessagesSubscriptionRelayUrls: Ref<string[]>;
  privateMessagesSubscriptionSince: Ref<number | null>;
  privateMessagesSubscriptionStartedAt: Ref<string | null>;
  processIncomingReactionDeletion: (
    reactionEventId: string,
    deletionAuthorPublicKey: string,
    options?: { uiThrottleMs?: number },
  ) => Promise<boolean>;
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  startPrivateMessagesHistoryRestore: () => void;
  subscribePrivateMessagesForLoggedInUser: (
    force?: boolean,
    options?: {
      restoreThrottleMs?: number;
      seedRelayUrls?: string[];
      sinceOverride?: number;
      startupTrackStep?: boolean;
    },
  ) => Promise<void>;
  toOptionalIsoTimestampFromUnix: (value: number | null | undefined) => string | null;
}

export function createDeveloperDiagnosticsRuntime({
  applyPendingIncomingDeletionsForMessage,
  applyPendingIncomingReactionsForMessage,
  buildRelaySnapshot,
  bumpDeveloperDiagnosticsVersion,
  configuredRelayUrls,
  ensureRelayConnections,
  ensureStoredEventSince,
  flushPrivateMessagesUiRefreshNow,
  getAppRelayUrls,
  getFilterSince,
  getLoggedInPublicKeyHex,
  getNip46SignerSessionSnapshot,
  getPrivateMessagesRestoreThrottleMs,
  getPrivateMessagesSubscription,
  getPrivateMessagesSubscriptionSignature,
  getRelaySnapshots,
  getStoredAuthMethod,
  hasNip07Extension,
  isRestoringStartupState,
  listPrivateMessageRecipientPubkeys,
  ndk,
  normalizeChatGroupEpochKeys,
  normalizeEventId,
  normalizeRelayStatusUrl,
  normalizeRelayStatusUrls,
  pendingIncomingDeletions,
  pendingIncomingReactions,
  privateMessagesSubscriptionLastEoseAt,
  privateMessagesSubscriptionLastEventCreatedAt,
  privateMessagesSubscriptionLastEventId,
  privateMessagesSubscriptionLastEventSeenAt,
  privateMessagesSubscriptionLiveCoverageAt,
  privateMessagesSubscriptionRelayUrls,
  privateMessagesSubscriptionSince,
  privateMessagesSubscriptionStartedAt,
  processIncomingReactionDeletion,
  resolveLoggedInPublishRelayUrls,
  resolveLoggedInReadRelayUrls,
  startPrivateMessagesHistoryRestore,
  subscribePrivateMessagesForLoggedInUser,
  toOptionalIsoTimestampFromUnix,
}: DeveloperDiagnosticsDeps) {
  function buildPendingReactionDiagnostics(): DeveloperPendingReactionSnapshot[] {
    return Array.from(pendingIncomingReactions.entries())
      .map(([targetEventId, entries]) => ({
        targetEventId,
        count: entries.length,
        entries: entries.map((entry) => ({
          chatPublicKey: entry.chatPublicKey,
          targetAuthorPublicKey: entry.targetAuthorPublicKey,
          emoji: entry.reaction.emoji,
          reactorPublicKey: entry.reaction.reactorPublicKey,
          createdAt: entry.reaction.createdAt,
          eventId: normalizeEventId(entry.reaction.eventId) ?? null,
        })),
      }))
      .sort((first, second) => second.count - first.count);
  }

  function buildPendingDeletionDiagnostics(): DeveloperPendingDeletionSnapshot[] {
    return Array.from(pendingIncomingDeletions.entries())
      .map(([targetEventId, entries]) => ({
        targetEventId,
        count: entries.length,
        entries: entries.map((entry) => ({
          deletionAuthorPublicKey: entry.deletionAuthorPublicKey,
          deleteEventId: normalizeEventId(entry.deleteEventId) ?? null,
          deletedAt: entry.deletedAt,
          targetKind: entry.targetKind,
        })),
      }))
      .sort((first, second) => second.count - first.count);
  }

  function buildDeveloperGroupSubscriptionContactMeta(
    meta: ContactMetadata | undefined,
  ): Record<string, unknown> {
    if (!meta || typeof meta !== 'object') {
      return {};
    }

    return {
      ...meta,
      ...(meta.group_private_key_encrypted ? { group_private_key_encrypted: '[redacted]' } : {}),
      ...(Array.isArray(meta.group_members)
        ? {
            group_members: meta.group_members.map((member) => ({ ...member })),
          }
        : {}),
    };
  }

  function buildDeveloperGroupSubscriptionChatMeta(
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const normalizedEpochKeys = normalizeChatGroupEpochKeys(meta?.[GROUP_EPOCH_KEYS_CHAT_META_KEY]);

    return {
      ...(meta && typeof meta === 'object' ? { ...meta } : {}),
      ...(normalizedEpochKeys.length > 0
        ? {
            [GROUP_EPOCH_KEYS_CHAT_META_KEY]: normalizedEpochKeys.map((entry) => ({
              epoch_number: entry.epoch_number,
              epoch_public_key: entry.epoch_public_key,
              epoch_private_key_encrypted: '[redacted]',
              ...(entry.invitation_created_at
                ? { invitation_created_at: entry.invitation_created_at }
                : {}),
            })),
          }
        : {}),
      ...(typeof meta?.[GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY] === 'string' &&
      String(meta[GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY]).trim()
        ? {
            [GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY]: '[redacted]',
          }
        : {}),
    };
  }

  async function buildDeveloperGroupMessageSubscriptionSnapshot(): Promise<
    DeveloperGroupMessageSubscriptionSnapshot[]
  > {
    await Promise.all([contactsService.init(), chatDataService.init()]);

    const recipientPubkeys = new Set(await listPrivateMessageRecipientPubkeys());
    const groupContacts = (await contactsService.listContacts()).filter(
      (contact) => contact.type === 'group',
    );
    if (groupContacts.length === 0) {
      return [];
    }

    const chatsByPubkey = new Map(
      (await chatDataService.listChats()).map((chat) => [chat.public_key, chat] as const),
    );

    const snapshots: Array<DeveloperGroupMessageSubscriptionSnapshot | null> = groupContacts.map(
      (contact) => {
        const normalizedGroupPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
        if (!normalizedGroupPubkey) {
          return null;
        }

        const groupChat = chatsByPubkey.get(normalizedGroupPubkey) ?? null;
        const epochKeys = normalizeChatGroupEpochKeys(
          groupChat?.meta?.[GROUP_EPOCH_KEYS_CHAT_META_KEY],
        );
        const currentEpochPubkey = inputSanitizerService.normalizeHexKey(
          typeof groupChat?.meta?.[GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY] === 'string'
            ? String(groupChat.meta[GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY])
            : (epochKeys[0]?.epoch_public_key ?? ''),
        );
        if (!currentEpochPubkey || !recipientPubkeys.has(currentEpochPubkey)) {
          return null;
        }

        const currentEpochEntry =
          epochKeys.find((entry) => entry.epoch_public_key === currentEpochPubkey) ??
          epochKeys[0] ??
          null;
        const name = contact.name.trim() || groupChat?.name?.trim() || normalizedGroupPubkey;

        return {
          name,
          pubkey: normalizedGroupPubkey,
          epochPubkey: currentEpochPubkey,
          epochNumber: currentEpochEntry?.epoch_number ?? null,
          details: {
            contactId: contact.id,
            contactType: contact.type,
            contactRelays: Array.isArray(contact.relays)
              ? contact.relays.map((relay) => ({ ...relay }))
              : [],
            contactMeta: buildDeveloperGroupSubscriptionContactMeta(contact.meta),
            chatId: groupChat?.id ?? null,
            chatType: groupChat?.type ?? null,
            unreadCount: groupChat?.unread_count ?? null,
            lastMessageAt: groupChat?.last_message_at ?? null,
            lastMessage: groupChat?.last_message ?? null,
            epochCount: epochKeys.length,
            chatMeta: buildDeveloperGroupSubscriptionChatMeta(groupChat?.meta),
          } as Record<string, unknown>,
        };
      },
    );

    return snapshots
      .filter((entry): entry is DeveloperGroupMessageSubscriptionSnapshot => entry !== null)
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  function getPendingDeveloperQueueTargetEventIds(): string[] {
    return Array.from(
      new Set([...pendingIncomingReactions.keys(), ...pendingIncomingDeletions.keys()]),
    );
  }

  function getPendingDeveloperQueueEntryCount(): number {
    let total = 0;

    for (const entries of pendingIncomingReactions.values()) {
      total += entries.length;
    }

    for (const entries of pendingIncomingDeletions.values()) {
      total += entries.length;
    }

    return total;
  }

  async function applyPendingReactionDeletionTarget(
    targetEventId: string,
    options: {
      uiThrottleMs?: number;
    } = {},
  ): Promise<boolean> {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      return false;
    }

    const pendingEntries = pendingIncomingDeletions.get(normalizedTargetEventId) ?? [];
    if (pendingEntries.length === 0) {
      return false;
    }

    const remainingEntries: PendingIncomingDeletion[] = [];
    let didApply = false;

    for (const pendingDeletion of pendingEntries) {
      const shouldTryReactionDeletion =
        pendingDeletion.targetKind === null || pendingDeletion.targetKind === NostrKind.Reaction;
      if (!shouldTryReactionDeletion) {
        remainingEntries.push(pendingDeletion);
        continue;
      }

      const handled = await processIncomingReactionDeletion(
        normalizedTargetEventId,
        pendingDeletion.deletionAuthorPublicKey,
        options,
      );
      if (!handled) {
        remainingEntries.push(pendingDeletion);
        continue;
      }

      didApply = true;
    }

    if (!didApply) {
      return false;
    }

    if (remainingEntries.length > 0) {
      pendingIncomingDeletions.set(normalizedTargetEventId, remainingEntries);
    } else {
      pendingIncomingDeletions.delete(normalizedTargetEventId);
    }

    return true;
  }

  async function applyPendingQueuesForStoredTargets(
    targetEventIds: string[],
    options: {
      uiThrottleMs?: number;
    } = {},
  ): Promise<boolean> {
    let didChange = false;

    for (const targetEventId of targetEventIds) {
      const normalizedTargetEventId = normalizeEventId(targetEventId);
      if (!normalizedTargetEventId) {
        continue;
      }

      const targetMessage = await chatDataService.getMessageByEventId(normalizedTargetEventId);
      if (targetMessage) {
        const previousReactionCount =
          pendingIncomingReactions.get(normalizedTargetEventId)?.length ?? 0;
        const previousDeletionCount =
          pendingIncomingDeletions.get(normalizedTargetEventId)?.length ?? 0;

        let nextMessage = await applyPendingIncomingReactionsForMessage(targetMessage, options);
        nextMessage = await applyPendingIncomingDeletionsForMessage(nextMessage, options);

        const nextReactionCount =
          pendingIncomingReactions.get(normalizedTargetEventId)?.length ?? 0;
        const nextDeletionCount =
          pendingIncomingDeletions.get(normalizedTargetEventId)?.length ?? 0;

        if (
          nextReactionCount !== previousReactionCount ||
          nextDeletionCount !== previousDeletionCount
        ) {
          didChange = true;
        }
        continue;
      }

      if (await applyPendingReactionDeletionTarget(normalizedTargetEventId, options)) {
        didChange = true;
      }
    }

    return didChange;
  }

  async function refreshDeveloperPendingQueues(): Promise<DeveloperPendingQueueRefreshSummary> {
    await Promise.all([chatDataService.init(), contactsService.init()]);

    const initialTargetCount = getPendingDeveloperQueueTargetEventIds().length;
    const initialEntryCount = getPendingDeveloperQueueEntryCount();
    if (initialEntryCount === 0) {
      return {
        initialTargetCount,
        initialEntryCount,
        remainingTargetCount: 0,
        remainingEntryCount: 0,
      };
    }

    const didChange = await applyPendingQueuesForStoredTargets(
      getPendingDeveloperQueueTargetEventIds(),
      {
        uiThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
      },
    );

    if (didChange) {
      flushPrivateMessagesUiRefreshNow();
      bumpDeveloperDiagnosticsVersion();
    }

    return {
      initialTargetCount,
      initialEntryCount,
      remainingTargetCount: getPendingDeveloperQueueTargetEventIds().length,
      remainingEntryCount: getPendingDeveloperQueueEntryCount(),
    };
  }

  async function getDeveloperDiagnosticsSnapshot(): Promise<DeveloperDiagnosticsSnapshot> {
    const relayStore = useRelayStore();
    const nip65RelayStore = useNip65RelayStore();
    relayStore.init();
    nip65RelayStore.init();

    const loggedInPubkey = getLoggedInPublicKeyHex();
    const authMethod = getStoredAuthMethod();
    const nip46Session = getNip46SignerSessionSnapshot();
    const storedEventSince = ensureStoredEventSince();
    const filterSince = getFilterSince();
    const appRelayUrls = getAppRelayUrls();
    const effectiveReadRelayUrls = await resolveLoggedInReadRelayUrls();
    const effectivePublishRelayUrls = await resolveLoggedInPublishRelayUrls();
    const configuredRelayList = Array.from(configuredRelayUrls);
    const privateMessagesRelayUrls = normalizeRelayStatusUrls(
      privateMessagesSubscriptionRelayUrls.value,
    );
    const groupMessagesSubscription = await buildDeveloperGroupMessageSubscriptionSnapshot();
    const relayRows: DeveloperRelayRow[] = normalizeRelayStatusUrls([
      ...appRelayUrls,
      ...effectiveReadRelayUrls,
      ...effectivePublishRelayUrls,
      ...privateMessagesRelayUrls,
      ...configuredRelayList,
    ]).map((relayUrl) => {
      const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
      const snapshot = buildRelaySnapshot(ndk.pool.getRelay(normalizedRelayUrl, false));

      return {
        ...snapshot,
        url: normalizedRelayUrl,
        inReadSet: effectiveReadRelayUrls.includes(normalizedRelayUrl),
        inPublishSet: effectivePublishRelayUrls.includes(normalizedRelayUrl),
        inPrivateMessagesSubscription: privateMessagesRelayUrls.includes(normalizedRelayUrl),
        isConfigured: configuredRelayUrls.has(normalizedRelayUrl),
      };
    });

    return {
      session: {
        loggedInPubkey,
        authMethod,
        nip46SignerPubkey: nip46Session.signerPubkey,
        nip46RelayUrls: nip46Session.relayUrls,
        eventSince: storedEventSince,
        eventSinceIso: toOptionalIsoTimestampFromUnix(storedEventSince),
        filterSince,
        filterSinceIso: toOptionalIsoTimestampFromUnix(filterSince),
        isRestoringStartupState: isRestoringStartupState.value,
        hasNip07Extension: hasNip07Extension(),
        appRelayUrls,
        myRelayEntries: nip65RelayStore.relayEntries.map((entry) => ({ ...entry })),
        effectiveReadRelayUrls,
        effectivePublishRelayUrls,
        configuredRelayUrls: configuredRelayList,
      },
      privateMessagesSubscription: {
        active: Boolean(getPrivateMessagesSubscription()),
        signature: getPrivateMessagesSubscriptionSignature() || null,
        relayUrls: privateMessagesRelayUrls,
        relaySnapshots: getRelaySnapshots(privateMessagesRelayUrls),
        since: privateMessagesSubscriptionSince.value,
        sinceIso: toOptionalIsoTimestampFromUnix(privateMessagesSubscriptionSince.value),
        restoreThrottleMs: getPrivateMessagesRestoreThrottleMs(),
        startedAt: privateMessagesSubscriptionStartedAt.value,
        lastEventSeenAt: privateMessagesSubscriptionLastEventSeenAt.value,
        lastEventId: privateMessagesSubscriptionLastEventId.value,
        lastEventCreatedAt: privateMessagesSubscriptionLastEventCreatedAt.value,
        lastEventCreatedAtIso: toOptionalIsoTimestampFromUnix(
          privateMessagesSubscriptionLastEventCreatedAt.value,
        ),
        lastEoseAt: privateMessagesSubscriptionLastEoseAt.value,
        liveCoverageAt: privateMessagesSubscriptionLiveCoverageAt.value,
        liveCoverageAtIso: toOptionalIsoTimestampFromUnix(
          privateMessagesSubscriptionLiveCoverageAt.value,
        ),
      },
      groupMessagesSubscription,
      relayRows,
      pendingReactions: buildPendingReactionDiagnostics(),
      pendingDeletions: buildPendingDeletionDiagnostics(),
    };
  }

  async function reconnectDeveloperRelay(relayUrl: string): Promise<void> {
    const normalizedRelayUrl = normalizeRelayStatusUrl(relayUrl);
    if (!normalizedRelayUrl) {
      throw new Error('Relay URL is required.');
    }

    await ensureRelayConnections([normalizedRelayUrl]);
    bumpDeveloperDiagnosticsVersion();
  }

  async function reconnectAllDeveloperRelays(): Promise<void> {
    const snapshot = await getDeveloperDiagnosticsSnapshot();
    const relayUrls = snapshot.relayRows
      .map((entry) => entry.url)
      .filter((value): value is string => Boolean(value));
    if (relayUrls.length === 0) {
      return;
    }

    await ensureRelayConnections(relayUrls);
    bumpDeveloperDiagnosticsVersion();
  }

  async function refreshPrivateMessages(): Promise<void> {
    await subscribePrivateMessagesForLoggedInUser(true, {
      restoreThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
    });
    startPrivateMessagesHistoryRestore();
    bumpDeveloperDiagnosticsVersion();
  }

  async function restartPrivateMessagesDiagnosticsSubscription(): Promise<void> {
    await refreshPrivateMessages();
  }

  return {
    getDeveloperDiagnosticsSnapshot,
    reconnectAllDeveloperRelays,
    reconnectDeveloperRelay,
    refreshDeveloperPendingQueues,
    refreshPrivateMessages,
    restartPrivateMessagesDiagnosticsSubscription,
  };
}
