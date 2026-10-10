import { isValidPubkey, nip19 } from '#src/lib/nostr/client.ts';
import type { MessageMentionMetadata, MessageMetadata } from '#src/types/chat.ts';
import type { ContactGroupMember, ContactMetadata } from '#src/types/contact.ts';

export interface NostrMentionProfile {
  publicKey: string;
  displayName: string;
  handle: string;
  picture?: string;
  avatar?: string;
  nprofile?: string;
  relayUrls?: string[];
}

export interface ParsedNostrMention {
  raw: string;
  start: number;
  end: number;
  publicKey: string;
  relayUrls: string[];
  nprofile?: string;
}

export interface NostrMentionTextPart {
  type: 'text' | 'mention';
  key: string;
  text: string;
  publicKey?: string;
}

interface MentionProfileInput {
  publicKey?: string | null;
  displayName?: string | null;
  picture?: string | null;
  avatar?: string | null;
  nprofile?: string | null;
  relayUrls?: string[] | null;
}

type GroupMentionMetadata = Pick<ContactMetadata, 'group_members'> | Record<string, unknown>;

const NOSTR_URI_PATTERN =
  /(?<![\p{L}\p{N}_:/?=&#.%])(?:nostr:)?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)(?![\p{L}\p{N}_])/giu;

function normalizePublicKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return isValidPubkey(normalized) ? normalized : null;
}

function normalizeRelayUrls(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const relayUrls = new Set<string>();
  for (const value of values) {
    const relayUrl = typeof value === 'string' ? value.trim() : '';
    if (relayUrl) {
      relayUrls.add(relayUrl);
    }
  }

  return Array.from(relayUrls);
}

function decodeNprofile(value: string | null | undefined): {
  publicKey: string | null;
  relayUrls: string[];
} {
  const nprofile = typeof value === 'string' ? value.trim() : '';
  if (!nprofile) {
    return {
      publicKey: null,
      relayUrls: [],
    };
  }

  try {
    const decoded = nip19.decode(nprofile);
    if (decoded.type !== 'nprofile' || typeof decoded.data !== 'object') {
      return {
        publicKey: null,
        relayUrls: [],
      };
    }

    const data = decoded.data as { pubkey?: unknown; relays?: unknown };
    return {
      publicKey: normalizePublicKey(data.pubkey),
      relayUrls: Array.isArray(data.relays)
        ? normalizeRelayUrls(
            data.relays.filter((relay): relay is string => typeof relay === 'string'),
          )
        : [],
    };
  } catch {
    return {
      publicKey: null,
      relayUrls: [],
    };
  }
}

function buildMentionHandle(
  displayName: string,
  publicKey: string,
  usedHandles: Set<string>,
): string {
  const cleanedName = displayName
    .trim()
    .replace(/^@+/u, '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '');
  const baseHandle = cleanedName || publicKey.slice(0, 12);
  let handle = baseHandle;
  let attempt = 1;

  while (usedHandles.has(handle.toLowerCase())) {
    handle = `${baseHandle}-${publicKey.slice(0, 6 + attempt)}`;
    attempt += 1;
  }

  usedHandles.add(handle.toLowerCase());
  return handle;
}

function isGroupMemberLike(value: unknown): value is ContactGroupMember {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ContactGroupMember>;
  return typeof candidate.public_key === 'string' && candidate.public_key.trim().length > 0;
}

function readGroupMentionMembers(
  meta: GroupMentionMetadata | null | undefined,
): ContactGroupMember[] {
  const groupMembers = meta?.group_members;
  return Array.isArray(groupMembers) ? groupMembers.filter(isGroupMemberLike) : [];
}

export function createNprofileMentionUri(
  publicKey: string,
  relayUrls: string[] = [],
): string | null {
  const normalizedPublicKey = normalizePublicKey(publicKey);
  if (!normalizedPublicKey) {
    return null;
  }

  return `nostr:${nip19.nprofileEncode({
    pubkey: normalizedPublicKey,
    relays: normalizeRelayUrls(relayUrls),
  })}`;
}

export function buildMentionProfiles(inputs: MentionProfileInput[]): NostrMentionProfile[] {
  const profiles: NostrMentionProfile[] = [];
  const usedPubkeys = new Set<string>();
  const usedHandles = new Set<string>();

  for (const input of inputs) {
    const decodedNprofile = decodeNprofile(input.nprofile);
    const publicKey = normalizePublicKey(input.publicKey) ?? decodedNprofile.publicKey;
    if (!publicKey || usedPubkeys.has(publicKey)) {
      continue;
    }

    const inputNprofile = input.nprofile?.trim() ?? '';
    const isDecodedNprofileForPublicKey = decodedNprofile.publicKey === publicKey;
    const safeNprofile = isDecodedNprofileForPublicKey ? inputNprofile : '';
    const displayName = input.displayName?.trim() || publicKey.slice(0, 12);
    const picture = input.picture?.trim() ?? '';
    const avatar = input.avatar?.trim() ?? '';
    const relayUrls = normalizeRelayUrls([
      ...(isDecodedNprofileForPublicKey ? decodedNprofile.relayUrls : []),
      ...(input.relayUrls ?? []),
    ]);

    profiles.push({
      publicKey,
      displayName,
      handle: buildMentionHandle(displayName, publicKey, usedHandles),
      ...(picture ? { picture } : {}),
      ...(avatar ? { avatar } : {}),
      ...(safeNprofile ? { nprofile: safeNprofile } : {}),
      ...(relayUrls.length > 0 ? { relayUrls } : {}),
    });
    usedPubkeys.add(publicKey);
  }

  return profiles;
}

export function buildGroupMemberMentionProfiles(
  meta: GroupMentionMetadata | null | undefined,
): NostrMentionProfile[] {
  return buildMentionProfiles(
    readGroupMentionMembers(meta).map((member) => ({
      publicKey: member.public_key,
      displayName: member.given_name?.trim() || member.name.trim() || member.public_key,
      picture: member.picture ?? null,
      avatar: member.avatar ?? null,
      nprofile: member.nprofile ?? null,
    })),
  );
}

export function parseNostrMentions(text: string): ParsedNostrMention[] {
  const mentions: ParsedNostrMention[] = [];

  for (const match of text.matchAll(NOSTR_URI_PATTERN)) {
    const raw = match[0] ?? '';
    const bech32Value = match[1] ?? '';
    const start = match.index ?? -1;
    if (!raw || !bech32Value || start < 0) {
      continue;
    }

    try {
      const decoded = nip19.decode(bech32Value);
      if (decoded.type === 'npub') {
        const publicKey = normalizePublicKey(decoded.data);
        if (publicKey) {
          mentions.push({
            raw,
            start,
            end: start + raw.length,
            publicKey,
            relayUrls: [],
          });
        }
        continue;
      }

      if (decoded.type !== 'nprofile' || typeof decoded.data !== 'object') {
        continue;
      }

      const data = decoded.data as { pubkey?: unknown; relays?: unknown };
      const publicKey = normalizePublicKey(data.pubkey);
      if (!publicKey) {
        continue;
      }

      mentions.push({
        raw,
        start,
        end: start + raw.length,
        publicKey,
        relayUrls: Array.isArray(data.relays)
          ? normalizeRelayUrls(
              data.relays.filter((relay): relay is string => typeof relay === 'string'),
            )
          : [],
        nprofile: bech32Value,
      });
    } catch {}
  }

  return mentions;
}

export function buildMentionMetadata(
  text: string,
  loggedInPublicKey?: string | null,
): Pick<MessageMetadata, 'mentions' | 'mentions_me'> {
  const normalizedLoggedInPublicKey = normalizePublicKey(loggedInPublicKey);
  const mentionsByPubkey = new Map<string, MessageMentionMetadata>();

  for (const mention of parseNostrMentions(text)) {
    if (mentionsByPubkey.has(mention.publicKey)) {
      continue;
    }

    mentionsByPubkey.set(mention.publicKey, {
      publicKey: mention.publicKey,
      ...(mention.relayUrls.length > 0 ? { relayUrls: mention.relayUrls } : {}),
      ...(mention.nprofile ? { nprofile: mention.nprofile } : {}),
    });
  }

  const mentions = Array.from(mentionsByPubkey.values());
  return {
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(mentions.length > 0 && normalizedLoggedInPublicKey
      ? {
          mentions_me: mentions.some(
            (mention) => mention.publicKey === normalizedLoggedInPublicKey,
          ),
        }
      : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function serializeMentionDraft(text: string, profiles: NostrMentionProfile[]): string {
  let nextText = text;
  const sortedProfiles = profiles
    .filter((profile) => profile.handle.trim())
    .slice()
    .sort((first, second) => second.handle.length - first.handle.length);

  for (const profile of sortedProfiles) {
    const mentionUri = profile.nprofile?.trim()
      ? `nostr:${profile.nprofile.trim()}`
      : createNprofileMentionUri(profile.publicKey, profile.relayUrls ?? []);
    if (!mentionUri) {
      continue;
    }

    const handlePattern = new RegExp(
      `(^|[^\\w@])@${escapeRegExp(profile.handle)}(?=$|[^\\w-])`,
      'giu',
    );
    nextText = nextText.replace(
      handlePattern,
      (_match, prefix: string) => `${prefix}${mentionUri}`,
    );
  }

  return nextText;
}

export function formatNostrMentionsForDisplay(
  text: string,
  profiles: NostrMentionProfile[] = [],
): string {
  return buildNostrMentionTextParts(text, profiles)
    .map((part) => part.text)
    .join('');
}

export function formatGroupMentionsForDisplay(
  text: string,
  meta: GroupMentionMetadata | null | undefined,
): string {
  return formatNostrMentionsForDisplay(text, buildGroupMemberMentionProfiles(meta));
}

export function buildNostrMentionTextParts(
  text: string,
  profiles: NostrMentionProfile[] = [],
): NostrMentionTextPart[] {
  const mentions = parseNostrMentions(text);
  if (mentions.length === 0) {
    return [
      {
        type: 'text',
        key: 'text-0',
        text,
      },
    ];
  }

  const profilesByPubkey = new Map(
    profiles.map((profile) => [profile.publicKey, profile] as const),
  );
  const parts: NostrMentionTextPart[] = [];
  let cursor = 0;

  mentions.forEach((mention, index) => {
    if (mention.start > cursor) {
      parts.push({
        type: 'text',
        key: `text-${index}-${cursor}`,
        text: text.slice(cursor, mention.start),
      });
    }

    const profile = profilesByPubkey.get(mention.publicKey);
    parts.push({
      type: 'mention',
      key: `mention-${index}-${mention.publicKey}-${mention.start}`,
      text: `@${profile?.displayName?.trim() || mention.publicKey.slice(0, 12)}`,
      publicKey: mention.publicKey,
    });
    cursor = mention.end;
  });

  if (cursor < text.length) {
    parts.push({
      type: 'text',
      key: `text-tail-${cursor}`,
      text: text.slice(cursor),
    });
  }

  return parts;
}
