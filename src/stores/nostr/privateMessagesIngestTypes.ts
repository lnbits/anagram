import type { NDKEvent, NDKSigner, NostrEvent } from '@nostr-dev-kit/ndk';
import type { ChatRow } from 'src/services/chatDataService';
import type { MessageRow } from 'src/stores/nostr/types';
import type { MessageRelayStatus, MessageReplyPreview, NostrEventDirection } from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';

export interface GroupEpochEntryLike {
  epoch_number: number;
  epoch_public_key: string;
  invitation_created_at?: string | null;
}

export interface GroupEpochContext {
  chat: ChatRow;
  epochEntry: GroupEpochEntryLike;
}

export interface HigherKnownGroupEpochConflict {
  higherEpochEntry: GroupEpochEntryLike;
  olderHigherEpochEntry?: GroupEpochEntryLike | null;
}

export interface ChatStoreRuntime {
  visibleChatId: string | null;
  acceptChat: (publicKey: string, options: { acceptedAt: string }) => Promise<void>;
  applyIncomingMessage: (options: {
    publicKey: string;
    authorPublicKey: string;
    fallbackName: string;
    messageText: string;
    at: string;
    unreadCount: number;
    meta: Record<string, unknown>;
    messageMeta?: Record<string, unknown>;
  }) => void;
  recordIncomingActivity: (publicKey: string, at: string) => Promise<void>;
  setUnreadCount: (publicKey: string, unreadCount: number) => Promise<void>;
}

export interface InboundTraceOptions {
  wrappedEvent?: { id?: string | null; kind?: number | null; created_at?: number | null } | null;
  rumorEvent?: { id?: string | null; kind?: number | null; created_at?: number | null } | null;
  loggedInPubkeyHex?: string | null;
  senderPubkeyHex?: string | null;
  chatPubkey?: string | null;
  targetEventId?: string | null;
  relayUrls?: string[];
  recipients?: string[];
}

export interface PrivateMessagesIngestRuntimeDeps {
  appendRelayStatusesToMessageEvent: (
    messageId: number,
    relayStatuses: MessageRelayStatus[],
    options?: {
      event?: NostrEvent;
      direction?: NostrEventDirection;
      eventId?: string;
      uiThrottleMs?: number;
    }
  ) => Promise<void>;
  applyPendingIncomingDeletionsForMessage: (
    messageRow: MessageRow,
    options?: {
      uiThrottleMs?: number;
    }
  ) => Promise<MessageRow>;
  applyPendingIncomingReactionsForMessage: (
    messageRow: MessageRow,
    options?: {
      uiThrottleMs?: number;
    }
  ) => Promise<MessageRow>;
  buildInboundRelayStatuses: (relayUrls: string[]) => MessageRelayStatus[];
  buildInboundTraceDetails: (options?: InboundTraceOptions) => Record<string, unknown>;
  buildLoggedNostrEvent: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey' | 'content' | 'tags'>,
    storedEvent?: NostrEvent | null
  ) => Record<string, unknown>;
  buildReplyPreviewFromTargetEvent: (
    targetEventId: string,
    chatPubkey: string,
    loggedInPubkeyHex: string,
    contact?: ContactRecord | null,
    options?: {
      referenceCreatedAt?: number | null;
      seedRelayUrls?: string[];
    }
  ) => Promise<MessageReplyPreview>;
  buildSubscriptionEventDetails: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ) => Record<string, unknown>;
  chatStore: ChatStoreRuntime;
  deriveChatName: (contact: ContactRecord | null, publicKey: string) => string;
  derivePublicKeyFromPrivateKey: (privateKey: string) => string | null;
  extractRelayUrlsFromEvent: (event: NDKEvent) => string[];
  findConflictingKnownGroupEpochNumber: (
    existingChat: ChatRow | null | undefined,
    epochNumber: number,
    epochPublicKey: string
  ) => GroupEpochEntryLike | null;
  findGroupChatEpochContextByRecipientPubkey: (
    epochPublicKey: string
  ) => Promise<GroupEpochContext | null>;
  findHigherKnownGroupEpochConflict: (
    existingChat: ChatRow | null | undefined,
    epochNumber: number,
    incomingEpochCreatedAt: string | null
  ) => HigherKnownGroupEpochConflict | null;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getPrivateMessagesRestoreThrottleMs: () => number;
  isContactListedInPrivateContactList: (
    contact: Pick<ContactRecord, 'meta'> | null | undefined
  ) => boolean;
  isPubkeyBlocked: (pubkeyHex: string) => boolean;
  lastSeenReceivedActivityAtMetaKey: string;
  logConflictingIncomingEpochNumber: (
    groupPublicKey: string,
    epochNumber: number,
    epochPublicKey: string,
    invitationCreatedAt: string | null,
    conflictingEpochNumber: GroupEpochEntryLike
  ) => void;
  logDeveloperTrace: (
    level: string,
    scope: string,
    phase: string,
    details?: Record<string, unknown>
  ) => void;
  logInboundEvent: (stage: string, details?: Record<string, unknown>) => void;
  logInvalidIncomingEpochNumber: (
    groupPublicKey: string,
    epochNumber: number,
    epochPublicKey: string,
    invitationCreatedAt: string | null,
    higherEpochConflict: HigherKnownGroupEpochConflict
  ) => void;
  logSubscription: (
    label: 'private-messages',
    stage: string,
    details?: Record<string, unknown>
  ) => void;
  normalizeEventId: (value: unknown) => string | null;
  normalizeThrottleMs: (value: number | undefined) => number;
  normalizeTimestamp: (value: unknown) => string | null;
  persistIncomingGroupEpochTicket: (
    groupPublicKey: string,
    epochNumber: number,
    epochPrivateKey: string,
    options?: {
      fallbackName?: string;
      accepted?: boolean;
      invitationCreatedAt?: string;
      seedRelayUrls?: string[];
    }
  ) => Promise<void>;
  processIncomingDeletionRumorEvent: (
    rumorEvent: NDKEvent,
    chatPubkey: string,
    senderPubkeyHex: string,
    options?: {
      uiThrottleMs?: number;
      seedRelayUrls?: string[];
    }
  ) => Promise<void>;
  processIncomingReactionRumorEvent: (
    rumorEvent: NDKEvent,
    chatPubkey: string,
    senderPubkeyHex: string,
    options: {
      uiThrottleMs?: number;
      direction: NostrEventDirection;
      rumorNostrEvent: NostrEvent | null;
      relayStatuses: MessageRelayStatus[];
    }
  ) => Promise<void>;
  refreshReplyPreviewsForTargetMessage: (
    messageRow: MessageRow,
    options?: {
      uiThrottleMs?: number;
    }
  ) => Promise<number>;
  queueBackgroundGroupContactRefresh: (
    groupPublicKey: string,
    fallbackName: string,
    seedRelayUrls?: string[]
  ) => void;
  queuePrivateMessagesUiRefresh: (options: {
    throttleMs?: number;
    reloadChats?: boolean;
    reloadMessages?: boolean;
  }) => void;
  readReplyTargetEventId: (event: NDKEvent) => string | null;
  resolveCurrentGroupChatEpochEntry: (
    chat: Pick<ChatRow, 'meta' | 'type'>
  ) => GroupEpochEntryLike | null;
  resolveGroupDisplayName: (groupPublicKey: string) => string;
  resolveIncomingChatInboxStateValue: (options: {
    chat: ChatRow | null | undefined;
    isAcceptedContact: boolean;
  }) => string;
  resolveIncomingPrivateMessageRecipientContext: (
    wrappedEvent: NDKEvent,
    loggedInPubkeyHex: string
  ) => Promise<{
    recipientPubkey: string;
    unwrapSigner: NDKSigner;
    groupChatPublicKey: string | null;
  } | null>;
  shouldNotifyForAcceptedChatOnly: (
    chatPubkey: string,
    chatMeta: Record<string, unknown> | null | undefined
  ) => Promise<boolean>;
  showIncomingMessageBrowserNotification: (options: {
    chatPubkey: string;
    title: string;
    messageText: string;
    iconUrl?: string;
  }) => void;
  toComparableTimestamp: (value: string | null | undefined) => number;
  toIsoTimestampFromUnix: (value: number | undefined) => string;
  toStoredNostrEvent: (event: NDKEvent) => Promise<NostrEvent | null>;
  unwrapGiftWrapSealEvent: (wrappedEvent: NDKEvent) => Promise<NostrEvent | null>;
  upsertIncomingGroupInviteRequestChat: (
    groupPublicKey: string,
    createdAt: string,
    preview?: Pick<ContactRecord, 'name' | 'meta'> | null
  ) => Promise<void>;
  verifyIncomingGroupEpochTicket: (
    rumorEvent: NDKEvent,
    sealEvent: NostrEvent | null
  ) => Promise<{
    isValid: boolean;
    signedEvent: NostrEvent | null;
    epochNumber: number | null;
    epochPrivateKey: string | null;
  }>;
}
