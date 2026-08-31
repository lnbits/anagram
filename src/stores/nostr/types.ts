import type {
  NDKRelayConnectionStats,
  NDKRelayInformation,
  NDKUserProfile,
  NostrEvent,
} from '@nostr-dev-kit/ndk';
import type { chatDataService } from 'src/services/chatDataService';
import type {
  DeveloperTraceEntry,
  DeveloperTraceLevel,
} from 'src/services/developerTraceDataService';
import type { ChatGroupEpochKey, MessageReaction, MessageRelayStatus } from 'src/types/chat';
import type { ContactRelay } from 'src/types/contact';

export interface NostrIdentifierResolutionResult {
  isValid: boolean;
  normalizedPubkey: string | null;
  resolvedName: string | null;
  relays: string[];
  identifierType: 'pubkey' | 'nip05' | null;
  error: 'invalid' | 'nip05_unresolved' | null;
}

export interface NostrNip05DataResult {
  isValid: boolean;
  normalizedPubkey: string | null;
  name: string | null;
  relays: string[];
  error: 'invalid' | 'nip05_unresolved' | null;
}

export type RelayConnectionState = 'connected' | 'issue';

export interface PublishUserMetadataInput {
  [key: string]: unknown;
  name?: string;
  about?: string;
  picture?: string;
  display_name?: string;
  website?: string;
  banner?: string;
  bot?: boolean;
  group?: boolean;
  birthday?: {
    year?: number;
    month?: number;
    day?: number;
  };
}

export interface UserProfileLookupResult {
  publicKey: string;
  name: string;
  displayName: string;
  about: string;
  picture: string;
  nip05: string;
  relayUrls: string[];
  eventCreatedAt: number | null;
  eventId: string | null;
}

export interface RelayListMetadataEntry {
  url: string;
  read?: boolean;
  write?: boolean;
}

export type AuthMethod = 'nsec' | 'nip07' | 'nip46';

export interface Nip46LoginResult {
  pubkey: string;
  signerPubkey: string | null;
  relayUrls: string[];
}

export interface Nip46NostrConnectLogin {
  clientPubkey: string;
  login: Promise<Nip46LoginResult>;
  relayUrl: string;
  uri: string;
  cancel: () => void;
}

export interface Nip46SessionSnapshot {
  signerPubkey: string | null;
  relayUrls: string[];
}

export interface SendGiftWrappedRumorOptions {
  localMessageId?: number;
  createdAt?: string;
  publishSelfCopy?: boolean;
}

export interface SendDirectMessageOptions extends SendGiftWrappedRumorOptions {
  replyToEventId?: string | null;
  additionalTags?: string[][];
}

export interface SendDirectMessageReactionOptions {
  createdAt?: string;
  targetKind?: number;
  publishSelfCopy?: boolean;
}

export interface SendDirectMessageDeletionOptions {
  createdAt?: string;
  publishSelfCopy?: boolean;
}

export interface RelayPublishStatusesResult {
  relayStatuses: MessageRelayStatus[];
  error: Error | null;
}

export interface RelaySaveStatus {
  relayUrls: string[];
  publishedRelayUrls: string[];
  failedRelayUrls: string[];
  errorMessage: string | null;
}

export interface CreateGroupChatResult {
  groupPublicKey: string;
  encryptedPrivateKey: string;
  groupSecretSave: RelaySaveStatus;
  memberListSyncError: string | null;
  contactListSyncError: string | null;
}

export interface PublishGroupMemberChangesResult {
  epochNumber: number;
  createdNewEpoch: boolean;
  attemptedMemberCount: number;
  deliveredMemberCount: number;
  failedMemberPubkeys: string[];
  publishedRelayUrls: string[];
}

export type RotateGroupEpochResult = PublishGroupMemberChangesResult;

export interface CreateGroupChatInput {
  name?: string;
  about?: string;
  relayUrls?: string[];
}

export interface GiftWrappedRumorPublishResult {
  giftWrapEvent: NostrEvent;
  rumorEvent: NostrEvent | null;
  rumorEventId: string | null;
  relayStatuses: MessageRelayStatus[];
}

export interface SubscribePrivateMessagesOptions {
  restoreThrottleMs?: number;
  seedRelayUrls?: string[];
  sinceOverride?: number;
  startupTrackStep?: boolean;
}

export interface RefreshPrivateMessagesLiveSubscriptionOptions
  extends SubscribePrivateMessagesOptions {
  forceRecreate?: boolean;
  probeTimeoutMs?: number;
}

export interface RefreshPrivateMessagesLiveSubscriptionResult {
  recreatedLiveSubscription: boolean;
}

export interface PrivateMessagesBackfillState {
  pubkey: string;
  nextSince: number;
  nextUntil: number;
  floorSince: number;
  delayMs: number;
  completed: boolean;
}

export interface QueuePrivateMessageUiRefreshOptions {
  throttleMs?: number;
  reloadChats?: boolean;
  reloadMessages?: boolean;
}

export type MissingMessageDependencyRepairReason =
  | 'reply-target-missing'
  | 'reaction-target-missing'
  | 'deletion-target-missing'
  | 'reply-open';

export interface RepairMissingMessageDependencyOptions {
  reason: MissingMessageDependencyRepairReason;
  immediate?: boolean;
  force?: boolean;
  referenceCreatedAt?: number | null;
  seedRelayUrls?: string[];
}

export interface PendingIncomingReaction {
  chatPublicKey: string;
  targetAuthorPublicKey: string | null;
  reaction: MessageReaction;
}

export interface PendingIncomingDeletion {
  deletionAuthorPublicKey: string;
  deleteEventId: string | null;
  deletedAt: string;
  targetKind: number | null;
}

export type SubscriptionLogName =
  | 'contact-profile'
  | 'contact-relay-list'
  | 'group-roster'
  | 'my-relay-list'
  | 'private-contact-list'
  | 'private-messages';

export interface PrivatePreferences {
  contactSecret: string;
  blossomServerUrl?: string;
  [key: string]: unknown;
}

export interface ContactCursorContent {
  version: string;
  last_seen_incoming_activity_at: string;
  last_seen_incoming_activity_event_id: string | null;
}

export interface ContactCursorState {
  at: string;
  eventId: string | null;
}

export interface GroupIdentitySecretContent {
  version: number;
  group_pubkey: string;
  group_privkey: string;
  epoch_number?: number;
  epoch_privkey?: string;
  name?: string;
  about?: string;
}

export interface ContactRelayListFetchResult {
  createdAt: number;
  eventId: string;
  relayEntries: ContactRelay[];
}

export interface ContactRelayListEventState {
  createdAt: number;
  eventId: string;
}

export interface ContactProfileEventState {
  createdAt: number;
  eventId: string;
}

export interface DeveloperRelaySnapshot {
  present: boolean;
  url: string | null;
  connected: boolean;
  status: number | null;
  statusName: string | null;
  attempts: number | null;
  success: number | null;
  connectedAt: number | null;
  nextReconnectAt: number | null;
  validationRatio: number | null;
  lastDurationMs: number | null;
}

export interface DeveloperRelayRow extends DeveloperRelaySnapshot {
  inReadSet: boolean;
  inPublishSet: boolean;
  inPrivateMessagesSubscription: boolean;
  isConfigured: boolean;
}

export interface DeveloperPendingReactionSnapshot {
  targetEventId: string;
  count: number;
  entries: Array<{
    chatPublicKey: string;
    targetAuthorPublicKey: string | null;
    emoji: string;
    reactorPublicKey: string;
    createdAt: string;
    eventId: string | null;
  }>;
}

export interface DeveloperPendingDeletionSnapshot {
  targetEventId: string;
  count: number;
  entries: Array<{
    deletionAuthorPublicKey: string;
    deleteEventId: string | null;
    deletedAt: string;
    targetKind: number | null;
  }>;
}

export interface DeveloperPrivateMessagesSubscriptionSnapshot {
  active: boolean;
  signature: string | null;
  relayUrls: string[];
  relaySnapshots: DeveloperRelaySnapshot[];
  since: number | null;
  sinceIso: string | null;
  restoreThrottleMs: number;
  startedAt: string | null;
  lastEventSeenAt: string | null;
  lastEventId: string | null;
  lastEventCreatedAt: number | null;
  lastEventCreatedAtIso: string | null;
  lastEoseAt: string | null;
  liveCoverageAt: number | null;
  liveCoverageAtIso: string | null;
}

export interface DeveloperGroupMessageSubscriptionSnapshot {
  name: string;
  pubkey: string;
  epochPubkey: string;
  epochNumber: number | null;
  details: Record<string, unknown>;
}

export interface DeveloperSessionSnapshot {
  loggedInPubkey: string | null;
  authMethod: AuthMethod | null;
  nip46SignerPubkey: string | null;
  nip46RelayUrls: string[];
  eventSince: number;
  eventSinceIso: string | null;
  filterSince: number;
  filterSinceIso: string | null;
  isRestoringStartupState: boolean;
  hasNip07Extension: boolean;
  appRelayUrls: string[];
  myRelayEntries: ContactRelay[];
  effectiveReadRelayUrls: string[];
  effectivePublishRelayUrls: string[];
  configuredRelayUrls: string[];
}

export interface DeveloperDiagnosticsSnapshot {
  session: DeveloperSessionSnapshot;
  privateMessagesSubscription: DeveloperPrivateMessagesSubscriptionSnapshot;
  groupMessagesSubscription: DeveloperGroupMessageSubscriptionSnapshot[];
  relayRows: DeveloperRelayRow[];
  pendingReactions: DeveloperPendingReactionSnapshot[];
  pendingDeletions: DeveloperPendingDeletionSnapshot[];
}

export interface DeveloperPendingQueueRefreshSummary {
  initialTargetCount: number;
  initialEntryCount: number;
  remainingTargetCount: number;
  remainingEntryCount: number;
}

export interface ContactRefreshLifecycle {
  refreshRelayList?: boolean;
  relayListSeedRelayUrls?: string[];
  onProfileFetchStart?: () => void;
  onProfileFetchEnd?: (error: unknown | null) => void;
  onRelayFetchStart?: () => void;
  onRelayFetchEnd?: (error: unknown | null) => void;
}

export type MessageRow = Awaited<ReturnType<typeof chatDataService.listMessages>>[number];

export type {
  ChatGroupEpochKey,
  DeveloperTraceEntry,
  DeveloperTraceLevel,
  NDKRelayConnectionStats,
  NDKRelayInformation,
  NDKUserProfile,
};
