import { normalizeChatGroupEpochKeysValue } from '#src/utils/groupEpochMetadata.ts';
export { normalizeChatGroupEpochKeysValue } from '#src/utils/groupEpochMetadata.ts';
import {
  type NostrRelayList,
  type NostrUserProfile,
  nip19,
  normalizeRelayUrl,
} from '#src/lib/nostr/client.ts';
import type { ChatRow } from '#src/services/chatDataService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type {
  ContactProfileEventState,
  ContactRelayListEventState,
} from '#src/stores/nostr/types.ts';
import type { ChatGroupEpochKey } from '#src/types/chat.ts';
import type { ContactMetadata, ContactRecord, ContactRelay } from '#src/types/contact.ts';

const GROUP_EPOCH_KEYS_CHAT_META_KEY = 'group_epoch_keys';
const GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY = 'current_epoch_public_key';
const GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY =
  'current_epoch_private_key_encrypted';
const CHAT_REQUEST_TYPE_META_KEY = 'request_type';
const CHAT_REQUEST_MESSAGE_META_KEY = 'request_message';
const CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY = 'last_incoming_message_at';
const GROUP_INVITE_REQUEST_TYPE = 'group_invite';
const GROUP_INVITE_REQUEST_MESSAGE = 'This is an invitation to a group.';
const PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY = 'private_contact_list_member';

function parseOptionalUnixTimestampValue(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

function toComparableIsoTimestampValue(value: string | null | undefined): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function resolveLatestReadBoundaryAtValue(
  ...candidates: Array<string | null | undefined>
): string {
  return candidates.reduce((latest, candidate) => {
    return toComparableIsoTimestampValue(candidate) > toComparableIsoTimestampValue(latest)
      ? candidate?.trim() || latest
      : latest;
  }, '');
}

function normalizeOptionalUnixSecondsValue(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalizedValue = Math.floor(Number(value));
  return normalizedValue >= 0 ? normalizedValue : null;
}

export function resolvePrivateMessagesLiveReconnectSinceValue(input: {
  liveCoverageAt: number | null | undefined;
  lastEventTime: number | null | undefined;
  initialLiveSince: number;
  lookbackSeconds: number;
}): number {
  const normalizedLookbackSeconds =
    Number.isFinite(input.lookbackSeconds) && input.lookbackSeconds > 0
      ? Math.floor(input.lookbackSeconds)
      : 0;
  const liveCoverageAt = normalizeOptionalUnixSecondsValue(input.liveCoverageAt);
  if (liveCoverageAt !== null) {
    return Math.max(0, liveCoverageAt - normalizedLookbackSeconds);
  }

  const lastEventTime = normalizeOptionalUnixSecondsValue(input.lastEventTime);
  if (lastEventTime !== null) {
    return Math.max(0, lastEventTime - normalizedLookbackSeconds);
  }

  return normalizeOptionalUnixSecondsValue(input.initialLiveSince) ?? 0;
}

export function resolveGroupChatEpochEntriesValue(
  chat: Pick<ChatRow, 'meta' | 'type'>,
): ChatGroupEpochKey[] {
  if (chat.type !== 'group') {
    return [];
  }

  const entriesByEpoch = new Map<string, ChatGroupEpochKey>(
    normalizeChatGroupEpochKeysValue(chat.meta?.[GROUP_EPOCH_KEYS_CHAT_META_KEY]).map((entry) => [
      `${entry.epoch_number}:${entry.epoch_public_key}`,
      entry,
    ]),
  );
  const currentEpochPublicKey = inputSanitizerService.normalizeHexKey(
    typeof chat.meta?.[GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY] === 'string'
      ? String(chat.meta[GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY])
      : '',
  );
  const currentEpochPrivateKeyEncrypted =
    typeof chat.meta?.[GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY] === 'string'
      ? String(chat.meta[GROUP_CURRENT_EPOCH_PRIVATE_KEY_ENCRYPTED_CHAT_META_KEY]).trim()
      : '';

  if (
    currentEpochPublicKey &&
    currentEpochPrivateKeyEncrypted &&
    !Array.from(entriesByEpoch.values()).some(
      (entry) => entry.epoch_public_key === currentEpochPublicKey,
    )
  ) {
    const fallbackEpochNumber = Math.max(
      0,
      ...Array.from(entriesByEpoch.values(), (entry) => entry.epoch_number),
    );
    entriesByEpoch.set(`${fallbackEpochNumber}:${currentEpochPublicKey}`, {
      epoch_number: fallbackEpochNumber,
      epoch_public_key: currentEpochPublicKey,
      epoch_private_key_encrypted: currentEpochPrivateKeyEncrypted,
    });
  }

  return Array.from(entriesByEpoch.values()).sort(
    (first, second) => second.epoch_number - first.epoch_number,
  );
}

export function resolveCurrentGroupChatEpochEntryValue(
  chat: Pick<ChatRow, 'meta' | 'type'>,
): ChatGroupEpochKey | null {
  const epochEntries = resolveGroupChatEpochEntriesValue(chat);
  if (epochEntries.length === 0 || Number(chat.meta?.group_conflicting_epoch ?? -1) >= epochEntries[0].epoch_number ||
      epochEntries.filter((e) => e.epoch_number === epochEntries[0].epoch_number).length > 1) {
    return null;
  }

  const currentEpochPublicKey = inputSanitizerService.normalizeHexKey(
    typeof chat.meta?.[GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY] === 'string'
      ? String(chat.meta[GROUP_CURRENT_EPOCH_PUBLIC_KEY_CHAT_META_KEY])
      : '',
  );
  if (!currentEpochPublicKey) {
    return epochEntries[0] ?? null;
  }

  return (
    epochEntries.find((entry) => entry.epoch_public_key === currentEpochPublicKey) ??
    epochEntries[0] ??
    null
  );
}

export function findHigherKnownGroupEpochConflictValue(
  chat: Pick<ChatRow, 'meta' | 'type'> | null | undefined,
  incomingEpochNumber: number,
  incomingCreatedAt: string | null = null,
): {
  higherEpochEntry: ChatGroupEpochKey;
  olderHigherEpochEntry: ChatGroupEpochKey | null;
} | null {
  if (!chat || chat.type !== 'group') {
    return null;
  }

  const higherEpochEntries = resolveGroupChatEpochEntriesValue(chat)
    .filter((entry) => entry.epoch_number > incomingEpochNumber)
    .sort((first, second) => second.epoch_number - first.epoch_number);
  if (higherEpochEntries.length === 0) {
    return null;
  }

  const incomingCreatedAtUnix = parseOptionalUnixTimestampValue(incomingCreatedAt);
  const olderHigherEpochEntry =
    incomingCreatedAtUnix === null
      ? (higherEpochEntries.find(
          (entry) => parseOptionalUnixTimestampValue(entry.invitation_created_at) !== null,
        ) ?? null)
      : (higherEpochEntries.find((entry) => {
          const higherEpochCreatedAtUnix = parseOptionalUnixTimestampValue(
            entry.invitation_created_at,
          );
          return (
            // Nostr timestamps have whole-second precision. A message and a
            // rotation in the same second cannot be ordered by created_at.
            higherEpochCreatedAtUnix !== null && higherEpochCreatedAtUnix < incomingCreatedAtUnix
          );
        }) ?? null);

  return {
    higherEpochEntry: higherEpochEntries[0],
    olderHigherEpochEntry,
  };
}

export function findConflictingKnownGroupEpochNumberValue(
  chat: Pick<ChatRow, 'meta' | 'type'> | null | undefined,
  incomingEpochNumber: number,
  incomingEpochPublicKey: string | null | undefined,
): ChatGroupEpochKey | null {
  if (!chat || chat.type !== 'group') {
    return null;
  }

  const normalizedIncomingEpochPublicKey = inputSanitizerService.normalizeHexKey(
    incomingEpochPublicKey ?? '',
  );
  if (!normalizedIncomingEpochPublicKey) {
    return null;
  }

  return (
    resolveGroupChatEpochEntriesValue(chat).find(
      (entry) =>
        entry.epoch_number === incomingEpochNumber &&
        entry.epoch_public_key !== normalizedIncomingEpochPublicKey,
    ) ?? null
  );
}

export function resolveIncomingChatInboxStateValue(options: {
  chat: Pick<ChatRow, 'meta'> | null | undefined;
  isAcceptedContact?: boolean;
}): 'accepted' | 'blocked' | 'request' {
  const inboxState =
    options.chat?.meta && typeof options.chat.meta.inbox_state === 'string'
      ? options.chat.meta.inbox_state.trim()
      : '';
  const acceptedAt =
    options.chat?.meta && typeof options.chat.meta.accepted_at === 'string'
      ? options.chat.meta.accepted_at.trim()
      : '';
  const lastOutgoingMessageAt =
    options.chat?.meta && typeof options.chat.meta.last_outgoing_message_at === 'string'
      ? options.chat.meta.last_outgoing_message_at.trim()
      : '';

  if (
    options.isAcceptedContact === true ||
    inboxState === 'accepted' ||
    acceptedAt ||
    lastOutgoingMessageAt
  ) {
    return 'accepted';
  }

  if (inboxState === 'blocked') {
    return 'blocked';
  }

  return 'request';
}

export function isContactListedInPrivateContactListValue(
  contact: Pick<ContactRecord, 'meta'> | null | undefined,
): boolean {
  return contact?.meta?.[PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY] === true;
}

export function buildAvatarFallbackValue(value: string): string {
  const compactValue = value.replace(/\s+/g, ' ').trim();
  if (!compactValue) {
    return 'NA';
  }

  const parts = compactValue.split(' ');
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  return compactValue.slice(0, 2).toUpperCase();
}

export function resolveGroupDisplayNameValue(groupPublicKey: string): string {
  return `Group ${groupPublicKey.slice(0, 8)}`;
}

function normalizeRelayStatusUrlValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  try {
    return normalizeRelayUrl(normalized);
  } catch {
    return null;
  }
}

export function normalizeRelayStatusUrlsValue(relayUrls: string[]): string[] {
  const uniqueRelayUrls = new Set<string>();
  for (const relayUrl of relayUrls) {
    const normalizedRelayUrl = normalizeRelayStatusUrlValue(relayUrl);
    if (normalizedRelayUrl) {
      uniqueRelayUrls.add(normalizedRelayUrl);
    }
  }

  return Array.from(uniqueRelayUrls);
}

export function normalizeWritableRelayUrlsValue(relays: ContactRelay[] | undefined): string[] {
  if (!Array.isArray(relays)) {
    return [];
  }

  const uniqueRelays = new Set<string>();
  for (const relay of relays) {
    if (!relay || relay.write === false) {
      continue;
    }

    const relayUrl = typeof relay.url === 'string' ? relay.url.trim() : '';
    if (!relayUrl) {
      continue;
    }

    try {
      uniqueRelays.add(normalizeRelayUrl(relayUrl));
    } catch {}
  }

  return Array.from(uniqueRelays);
}

// Group rosters can be stored on either the public outbox or the advertised
// receive relay. NIP-10050 entries are read-only in our contact model.
export function resolveGroupReadRelayUrlsValue(
  relays: ContactRelay[] | undefined,
  seedRelayUrls: string[] = [],
): string[] {
  return normalizeRelayStatusUrlsValue([
    ...inputSanitizerService.normalizeReadableRelayUrls(relays),
    ...normalizeWritableRelayUrlsValue(relays),
    ...seedRelayUrls,
  ]);
}

export function resolveGroupPublishRelayUrlsValue(
  relays: ContactRelay[] | undefined,
  seedRelayUrls: string[] = [],
): string[] {
  return normalizeRelayStatusUrlsValue([
    ...inputSanitizerService.normalizeStringArray(seedRelayUrls),
    ...normalizeWritableRelayUrlsValue(relays),
  ]);
}

export function buildGroupInviteRequestPlanValue(options: {
  groupPublicKey: string;
  createdAt: string;
  existingChat: Pick<ChatRow, 'meta' | 'name' | 'unread_count'> | null | undefined;
  preview?: Pick<ContactRecord, 'name' | 'meta'> | null;
}): {
  shouldCreate: boolean;
  nextName: string;
  nextMeta: Record<string, unknown>;
  nextUnreadCount: number;
} | null {
  const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(options.groupPublicKey);
  const createdAt = options.createdAt.trim();
  if (!normalizedGroupPublicKey || !createdAt) {
    return null;
  }

  if (
    resolveIncomingChatInboxStateValue({
      chat: options.existingChat,
      isAcceptedContact: false,
    }) !== 'request'
  ) {
    return null;
  }

  const previewName =
    options.preview?.meta?.display_name?.trim() ||
    options.preview?.meta?.name?.trim() ||
    options.preview?.name?.trim() ||
    resolveGroupDisplayNameValue(normalizedGroupPublicKey);
  const previewPicture = options.preview?.meta?.picture?.trim() ?? '';
  const nextMeta: Record<string, unknown> = {
    ...(options.existingChat?.meta ?? {}),
    avatar: buildAvatarFallbackValue(previewName),
    contact_name: previewName,
    [CHAT_REQUEST_TYPE_META_KEY]: GROUP_INVITE_REQUEST_TYPE,
    [CHAT_REQUEST_MESSAGE_META_KEY]: GROUP_INVITE_REQUEST_MESSAGE,
    [CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY]: createdAt,
  };
  if (previewPicture) {
    nextMeta.picture = previewPicture;
  }

  return {
    shouldCreate: !options.existingChat,
    nextName: previewName,
    nextMeta,
    nextUnreadCount: options.existingChat ? Number(options.existingChat.unread_count ?? 0) + 1 : 1,
  };
}

export function buildAcceptedGroupInviteChatPlanValue(options: {
  groupPublicKey: string;
  fallbackName?: string;
  existingChat: Pick<ChatRow, 'meta' | 'name'> | null | undefined;
  acceptedAt?: string;
}): {
  nextName: string;
  nextMeta: Record<string, unknown>;
} | null {
  const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(options.groupPublicKey);
  const existingChat = options.existingChat;
  if (!normalizedGroupPublicKey || !existingChat) {
    return null;
  }

  const nextName =
    options.fallbackName?.trim() || resolveGroupDisplayNameValue(normalizedGroupPublicKey);
  const acceptedAt =
    (typeof existingChat.meta?.accepted_at === 'string'
      ? existingChat.meta.accepted_at.trim()
      : '') ||
    options.acceptedAt?.trim() ||
    new Date().toISOString();
  const nextMeta: Record<string, unknown> = {
    ...(existingChat.meta ?? {}),
    contact_name: nextName,
    inbox_state: 'accepted',
    accepted_at: acceptedAt,
  };
  delete nextMeta[CHAT_REQUEST_TYPE_META_KEY];
  delete nextMeta[CHAT_REQUEST_MESSAGE_META_KEY];

  return {
    nextName,
    nextMeta,
  };
}

function readProfileFieldValue(
  profile: NostrUserProfile | null,
  keys: string[],
  fallback = '',
): string | undefined {
  for (const key of keys) {
    const rawValue = profile?.[key];
    if (typeof rawValue !== 'string') {
      continue;
    }

    const normalized = rawValue.trim();
    if (normalized) {
      return normalized;
    }
  }

  const normalizedFallback = fallback.trim();
  return normalizedFallback || undefined;
}

export function buildUpdatedContactMetaValue(
  existingMeta: ContactMetadata | undefined,
  profile: NostrUserProfile | null,
  resolvedNpub: string | null,
  resolvedNprofile: string | null,
): ContactMetadata {
  const meta: ContactMetadata = {
    ...(existingMeta ?? {}),
  };

  const nextName = readProfileFieldValue(profile, ['name'], meta.name ?? '');
  const nextAbout = readProfileFieldValue(profile, ['about', 'bio'], meta.about ?? '');
  const nextPicture = readProfileFieldValue(profile, ['picture', 'image'], meta.picture ?? '');
  const nextNip05 = readProfileFieldValue(profile, ['nip05'], meta.nip05 ?? '');
  const nextLud06 = readProfileFieldValue(profile, ['lud06'], meta.lud06 ?? '');
  const nextLud16 = readProfileFieldValue(profile, ['lud16'], meta.lud16 ?? '');
  const nextDisplayName = readProfileFieldValue(
    profile,
    ['displayName', 'display_name'],
    meta.display_name ?? '',
  );
  const nextWebsite = readProfileFieldValue(profile, ['website'], meta.website ?? '');
  const nextBanner = readProfileFieldValue(profile, ['banner'], meta.banner ?? '');

  if (nextName) {
    meta.name = nextName;
  }

  if (nextAbout) {
    meta.about = nextAbout;
  }

  if (nextPicture) {
    meta.picture = nextPicture;
  }

  if (nextNip05) {
    meta.nip05 = nextNip05;
  }

  if (nextLud06) {
    meta.lud06 = nextLud06;
  }

  if (nextLud16) {
    meta.lud16 = nextLud16;
  }

  if (nextDisplayName) {
    meta.display_name = nextDisplayName;
  }

  if (nextWebsite) {
    meta.website = nextWebsite;
  }

  if (nextBanner) {
    meta.banner = nextBanner;
  }

  if (typeof profile?.bot === 'boolean') {
    meta.bot = profile.bot;
  }

  if (typeof profile?.group === 'boolean') {
    meta.group = profile.group;
  }

  if (profile) {
    const pin = inputSanitizerService.normalizeContactMetadata(profile);
    if (pin.pinned) meta.pinned = pin.pinned;
    else delete meta.pinned;
    if (pin.pinned_created_at) meta.pinned_created_at = pin.pinned_created_at;
    else delete meta.pinned_created_at;
  }

  const birthday = inputSanitizerService.normalizeContactBirthday(profile?.birthday);
  if (birthday) meta.birthday = birthday;

  if (resolvedNpub?.trim()) {
    meta.npub = resolvedNpub.trim();
  }

  if (resolvedNprofile?.trim()) {
    meta.nprofile = resolvedNprofile.trim();
  }

  return meta;
}

function normalizeStoredContactEventCreatedAtValue(value: unknown): number | null {
  const createdAt = Number(value);
  if (!Number.isInteger(createdAt) || createdAt <= 0) {
    return null;
  }

  return Math.floor(createdAt);
}

export function readContactProfileEventSinceValue(
  meta: ContactMetadata | undefined,
): number | null {
  return normalizeStoredContactEventCreatedAtValue(meta?.profile_event_created_at);
}

export function readContactRelayListEventSinceValue(
  meta: ContactMetadata | undefined,
): number | null {
  return normalizeStoredContactEventCreatedAtValue(meta?.relay_list_event_created_at);
}

export function applyContactProfileEventStateToMetaValue(
  meta: ContactMetadata | undefined,
  eventState: ContactProfileEventState | null | undefined,
): ContactMetadata {
  const nextMeta: ContactMetadata = {
    ...(meta ?? {}),
  };
  const createdAt = normalizeStoredContactEventCreatedAtValue(eventState?.createdAt);
  if (createdAt !== null) {
    nextMeta.profile_event_created_at = createdAt;
  }

  return nextMeta;
}

export function applyContactRelayListEventStateToMetaValue(
  meta: ContactMetadata | undefined,
  eventState: ContactRelayListEventState | null | undefined,
): ContactMetadata {
  const nextMeta: ContactMetadata = {
    ...(meta ?? {}),
  };
  const createdAt = normalizeStoredContactEventCreatedAtValue(eventState?.createdAt);
  if (createdAt !== null) {
    nextMeta.relay_list_event_created_at = createdAt;
  }

  return nextMeta;
}

function encodeNpubValue(pubkeyHex: string): string | null {
  try {
    return nip19.npubEncode(pubkeyHex);
  } catch {
    return null;
  }
}

function encodeNprofileValue(pubkeyHex: string): string | null {
  try {
    return nip19.nprofileEncode({
      pubkey: pubkeyHex,
    });
  } catch {
    return null;
  }
}

export function buildIdentifierFallbacksValue(
  pubkeyHex: string,
  existingMeta?: ContactMetadata,
): string[] {
  const nip05Identifier = existingMeta?.nip05?.trim() ?? '';
  const nprofileIdentifier = existingMeta?.nprofile?.trim() || encodeNprofileValue(pubkeyHex) || '';
  const npubIdentifier = existingMeta?.npub?.trim() || encodeNpubValue(pubkeyHex) || '';
  const hexIdentifier = pubkeyHex;

  return [nip05Identifier, npubIdentifier, hexIdentifier, nprofileIdentifier]
    .map((identifier) => identifier.trim())
    .filter(
      (identifier, index, list) => identifier.length > 0 && list.indexOf(identifier) === index,
    );
}

export function relayEntriesFromRelayListValue(
  relayList:
    Pick<NostrRelayList, 'readRelayUrls' | 'writeRelayUrls' | 'bothRelayUrls'> | null | undefined,
): ContactRelay[] {
  if (!relayList) {
    return [];
  }

  return inputSanitizerService.normalizeRelayListMetadataEntries([
    ...Array.from(relayList.readRelayUrls ?? [], (relay) => ({
      url: String(relay),
      read: true,
      write: false,
    })),
    ...Array.from(relayList.writeRelayUrls ?? [], (relay) => ({
      url: String(relay),
      read: false,
      write: true,
    })),
    ...Array.from(relayList.bothRelayUrls ?? [], (relay) => ({
      url: String(relay),
      read: true,
      write: true,
    })),
  ]);
}

export function relayEntriesFromDirectMessageReceiveRelayEventValue(
  event: { tags?: string[][] } | null | undefined,
): ContactRelay[] {
  if (!Array.isArray(event?.tags)) {
    return [];
  }

  return inputSanitizerService.normalizeRelayListMetadataEntries(
    event.tags
      .filter((tag) => tag[0] === 'relay' || tag[0] === 'r')
      .map((tag) => ({
        url: String(tag[1] ?? ''),
        read: true,
        write: false,
      })),
  );
}

export function mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
  relayEntries: ContactRelay[] | undefined,
  directMessageReceiveRelayEntries: ContactRelay[] | undefined,
): ContactRelay[] {
  return inputSanitizerService.normalizeRelayListMetadataEntries([
    ...(relayEntries ?? []),
    ...(directMessageReceiveRelayEntries ?? []).map((relay) => ({
      url: relay.url,
      read: true,
      write: false,
    })),
  ]);
}

export function contactRelayListsEqualValue(
  first: ContactRelay[] | undefined,
  second: ContactRelay[] | undefined,
): boolean {
  return (
    JSON.stringify(inputSanitizerService.normalizeRelayListMetadataEntries(first ?? [])) ===
    JSON.stringify(inputSanitizerService.normalizeRelayListMetadataEntries(second ?? []))
  );
}

export function contactMetadataEqualValue(
  first: ContactMetadata | undefined,
  second: ContactMetadata | undefined,
): boolean {
  return (
    JSON.stringify(inputSanitizerService.normalizeContactMetadata(first ?? {})) ===
    JSON.stringify(inputSanitizerService.normalizeContactMetadata(second ?? {}))
  );
}

export function shouldPreserveExistingGroupRelaysValue(
  contact: Pick<ContactRecord, 'type' | 'public_key' | 'relays'> | null | undefined,
  nextRelayEntries: ContactRelay[] | undefined,
): boolean {
  return (
    contact?.type === 'group' &&
    Array.isArray(contact.relays) &&
    contact.relays.length > 0 &&
    (!Array.isArray(nextRelayEntries) || nextRelayEntries.length === 0)
  );
}
