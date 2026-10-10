import { Capacitor } from '#src/lib/platform/legacyNative.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  type CallRoomLink,
  type CallRoomMember,
  type CallRoomSignal,
  ROOM_LIFETIME_MS,
  ROOM_MAX_MEMBERS,
  ROOM_PROTOCOL,
} from '#src/types/callRoom.ts';
import { parseCallSignal } from './callSignal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function roomRelays(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 8 ||
    value.some((url) => typeof url !== 'string' || url.length > 512)
  )
    return null;
  try {
    if (
      value.some((entry) => {
        const url = new URL(entry);
        return (
          !['ws:', 'wss:'].includes(url.protocol) ||
          Boolean(url.username || url.password || url.hash)
        );
      })
    )
      return null;
  } catch {
    return null;
  }
  const relays = inputSanitizerService
    .normalizeRelayEntriesFromUrls(value)
    .map((entry) => entry.url);
  return relays.length === value.length ? relays : null;
}
function member(value: unknown): CallRoomMember | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as CallRoomMember;
  const pubkey = inputSanitizerService.normalizeHexKey(v.pubkey);
  const relays = roomRelays(v.relays);
  if (
    !pubkey ||
    !UUID.test(v.sessionId) ||
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    v.name.length > 80 ||
    !relays
  )
    return null;
  return { pubkey, sessionId: v.sessionId, name: v.name.trim(), relays };
}
export function parseRoomLink(input: string, now = Date.now()): CallRoomLink | null {
  try {
    if (input.length > 8192) return null;
    const token = input.includes('/call/') ? input.slice(input.lastIndexOf('/call/') + 6) : input;
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const v = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
    const host = inputSanitizerService.normalizeHexKey(v.host);
    const relays = roomRelays(v.relays);
    const expires = Date.parse(v.expiresAt);
    if (
      !UUID.test(v.id) ||
      !host ||
      typeof v.secret !== 'string' ||
      !/^[0-9a-f]{64}$/.test(v.secret) ||
      !relays ||
      !Number.isFinite(expires) ||
      expires <= now ||
      expires > now + ROOM_LIFETIME_MS + 60_000
    )
      return null;
    return { id: v.id, host, secret: v.secret, expiresAt: new Date(expires).toISOString(), relays };
  } catch {
    return null;
  }
}
export function roomLinkToken(link: CallRoomLink): string {
  return btoa(JSON.stringify(link)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function formatRoomLink(
  link: CallRoomLink,
  base = document.baseURI,
  native = Capacitor.isNativePlatform(),
): string {
  const url = new URL(base);
  const origin =
    !native &&
    ['http:', 'https:'].includes(url.protocol) &&
    !url.hostname.endsWith('tauri.localhost')
      ? url.origin
      : 'https://anagram.chat';
  // A public entry page gives crawlers a call card; the capability stays client-side.
  return `${origin}/join/call.html#/call/${roomLinkToken(link)}`;
}
export function parseRoomSignal(
  content: string,
  createdAt?: number,
  now = Date.now(),
): CallRoomSignal | null {
  if (
    content.length > 20_000 ||
    !createdAt ||
    !Number.isSafeInteger(createdAt) ||
    now - createdAt * 1000 > 60_000 ||
    createdAt * 1000 - now > 10_000
  )
    return null;
  try {
    const v = JSON.parse(content);
    const expires = Date.parse(v.expiresAt);
    if (
      v.protocol !== ROOM_PROTOCOL ||
      !UUID.test(v.roomId) ||
      !UUID.test(v.senderSession) ||
      !Number.isFinite(expires) ||
      expires <= now ||
      expires > createdAt * 1000 + 61_000
    )
      return null;
    const base = {
      protocol: ROOM_PROTOCOL as typeof ROOM_PROTOCOL,
      roomId: v.roomId,
      senderSession: v.senderSession,
      expiresAt: new Date(expires).toISOString(),
    };
    switch (v.action) {
      case 'join': {
        const parsed = member(v.member);
        if (
          !parsed ||
          parsed.sessionId !== v.senderSession ||
          typeof v.secret !== 'string' ||
          !/^[0-9a-f]{64}$/.test(v.secret)
        )
          return null;
        return { ...base, action: 'join', secret: v.secret, member: parsed };
      }
      case 'roster': {
        if (
          !Number.isSafeInteger(v.revision) ||
          v.revision < 1 ||
          !Array.isArray(v.members) ||
          !v.members.length ||
          v.members.length > ROOM_MAX_MEMBERS
        )
          return null;
        const members = v.members.map(member);
        if (
          members.some((item: CallRoomMember | null) => !item) ||
          new Set(members.map((item: CallRoomMember) => item.pubkey)).size !== members.length
        )
          return null;
        return { ...base, action: 'roster', members, revision: v.revision };
      }
      case 'signal': {
        const signal = parseCallSignal(JSON.stringify(v.signal), createdAt, now);
        return signal?.mediaVersion === 2 && UUID.test(v.recipientSession)
          ? { ...base, action: 'signal', signal, recipientSession: v.recipientSession }
          : null;
      }
      case 'leave':
      case 'closed':
        return { ...base, action: v.action };
      case 'rejected':
        return ['full', 'ended', 'failed'].includes(v.reason)
          ? { ...base, action: v.action, reason: v.reason }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
