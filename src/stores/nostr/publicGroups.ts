import { ClientEvent, nip19, type NostrEvent } from '#src/lib/nostr/client.ts';
import { previewUrl } from '#src/utils/linkPreview.ts';

export const ROOM_KIND = 34550;
export const ROOM_PAGE = 50;
export const ROOM_WINDOW = 200;
export const MAX_ROOM_MEMBERS = 1024;
export interface RoomAddress {
  address: string;
  owner: string;
  slug: string;
  relays: string[];
}
export interface PublicRoom extends RoomAddress {
  event: NostrEvent;
  name: string;
  about: string;
  picture: string;
  trusted: string[];
  blocked: string[];
  pinned?: string;
  successor?: RoomAddress;
  predecessor?: RoomAddress;
}
const HEX = /^[a-f0-9]{64}$/;
export function roomAddress(value: string): RoomAddress {
  const match = /^34550:([a-f0-9]{64}):([a-zA-Z0-9_-]{1,128})$/.exec(value);
  if (!match) throw new Error('Invalid public group address.');
  return { address: value, owner: match[1], slug: match[2], relays: [] };
}
export function decodeRoomLink(value: string): RoomAddress {
  let input = value.trim();
  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    if (/^\/join\/chat(?:\.html)?\/?$/.test(url.pathname) && url.hash.startsWith('#/public/'))
      input = decodeURIComponent(url.hash.slice(9));
    else if (url.pathname.startsWith('/public/')) input = decodeURIComponent(url.pathname.slice(8));
    else throw new Error('Not a public group link.');
  }
  input = input.replace(/^nostr:/, '');
  if (input.length > 5000) throw new Error('Public group link is too long.');
  if (input.startsWith('34550:')) return roomAddress(input);
  const decoded = nip19.decode(input);
  if (decoded.type !== 'naddr' || decoded.data.kind !== ROOM_KIND)
    throw new Error('Paste a public group link or naddr.');
  return {
    ...roomAddress(`${ROOM_KIND}:${decoded.data.pubkey}:${decoded.data.identifier}`),
    relays: decoded.data.relays.slice(0, 8),
  };
}
export function encodeRoomLink(room: RoomAddress): string {
  return nip19.naddrEncode({
    kind: ROOM_KIND,
    pubkey: room.owner,
    identifier: room.slug,
    relays: room.relays.slice(0, 8),
  });
}
export function publicGroupShareLink(room: RoomAddress): string {
  const base =
    typeof location !== 'undefined' &&
    /^https?:$/.test(location.protocol) &&
    !location.hostname.endsWith('tauri.localhost')
      ? location.origin
      : 'https://anagram.chat';
  return `${base}/join/chat.html#/public/${encodeRoomLink(room)}`;
}
export function verifiedPublicEvent(event: NostrEvent): boolean {
  return (
    JSON.stringify(event).length <= 65536 &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at >= 0 &&
    event.created_at <= Math.floor(Date.now() / 1000) + 60 &&
    event.tags.length <= 2200 &&
    event.tags.every((t) => t.every((v) => typeof v === 'string' && v.length <= 4096)) &&
    new ClientEvent(undefined, event).verifySignature()
  );
}
export function parsePublicRoom(event: NostrEvent, expected?: string): PublicRoom {
  if (event.kind !== ROOM_KIND || !verifiedPublicEvent(event))
    throw new Error('Invalid signed public group.');
  const single = (name: string, required = false) => {
    const tags = event.tags.filter((t) => t[0] === name);
    if (tags.length > 1 || (required && tags.length !== 1))
      throw new Error(`Invalid group ${name}.`);
    return tags[0];
  };
  const address = roomAddress(`${ROOM_KIND}:${event.pubkey}:${single('d', true)?.[1]}`);
  if (expected && address.address !== expected)
    throw new Error('Public group address does not match.');
  if (single('anagram-room', true)?.[1] !== '1')
    throw new Error('Unsupported public group format.');
  const keys = (tag: string) => {
    const values = event.tags.filter((t) => t[0] === tag).map((t) => t[1]);
    if (values.length > MAX_ROOM_MEMBERS || values.some((k) => !HEX.test(k)))
      throw new Error('Invalid moderation list.');
    return [...new Set(values)];
  };
  const pointer = (tag: string) => {
    const t = single(tag);
    return t ? { ...roomAddress(t[1]), relays: t[2] ? [t[2]] : [] } : undefined;
  };
  const name = single('name', true)?.[1] || '';
  const about = single('description')?.[1] || '';
  if (!name.trim() || name.length > 100 || about.length > 2000)
    throw new Error('Invalid group profile.');
  const relays = [...new Set(event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]))];
  if (!relays.length || relays.length > 8) throw new Error('A public group needs 1–8 relays.');
  const pinned = single('pinned')?.[1];
  if (pinned !== undefined && !HEX.test(pinned)) throw new Error('Invalid pinned message.');
  const blocked = keys('blocked');
  if (blocked.includes(address.owner)) throw new Error('The group owner cannot be blocked.');
  return {
    ...address,
    event,
    name,
    about,
    relays,
    picture: previewUrl(single('image')?.[1] || '') || '',
    pinned,
    trusted: keys('trusted'),
    blocked,
    successor: pointer('successor'),
    predecessor: pointer('predecessor'),
  };
}
export function roomPolicy(room: PublicRoom, pubkey: string): 'blocked' | 'trusted' | 'plain' {
  if (pubkey === room.owner) return 'trusted';
  if (room.blocked.includes(pubkey)) return 'blocked';
  return room.trusted.includes(pubkey) ? 'trusted' : 'plain';
}
export function validRoomMessage(event: NostrEvent, address: string): boolean {
  const {
    activity: _,
    replyEvent: __,
    ...signed
  } = event as NostrEvent & { activity?: unknown; replyEvent?: unknown };
  const refs = event.tags.filter((t) => t[0] === 'a');
  return (
    event.kind === 9 &&
    event.content.length > 0 &&
    event.content.length <= 8000 &&
    refs.length === 1 &&
    refs[0][1] === address &&
    verifiedPublicEvent(signed)
  );
}
export function newerRoom(a: PublicRoom, b: PublicRoom): boolean {
  return (
    a.event.created_at > b.event.created_at ||
    (a.event.created_at === b.event.created_at && a.event.id! < b.event.id!)
  );
}
export function roomTags(input: {
  name: string;
  about: string;
  picture: string;
  relays: string[];
  trusted: string[];
  blocked: string[];
  pinned?: string;
  slug: string;
  predecessor?: RoomAddress;
  successor?: RoomAddress;
}): string[][] {
  return [
    ['d', input.slug],
    ['anagram-room', '1'],
    ['name', input.name.trim()],
    ['description', input.about.trim()],
    ...(input.pinned ? [['pinned', input.pinned]] : []),
    ...(input.picture ? [['image', input.picture]] : []),
    ...input.relays.map((r) => ['relay', r]),
    ...input.trusted.map((k) => ['trusted', k]),
    ...input.blocked.map((k) => ['blocked', k]),
    ...(input.predecessor ? [['predecessor', input.predecessor.address]] : []),
    ...(input.successor
      ? [['successor', input.successor.address, input.successor.relays[0] || '']]
      : []),
  ];
}
/** Hints are untrusted. Only explicitly configured relays may use local/dev endpoints. */
export function publicRoomRelays(hints: string[], configured: string[]): string[] {
  const allowed = new Set(
    configured.map((r) => {
      try {
        return new URL(r).href;
      } catch {
        return '';
      }
    }),
  );
  return [
    ...new Set(
      hints.flatMap((r) => {
        try {
          const u = new URL(r);
          if (u.username || u.password || !['ws:', 'wss:'].includes(u.protocol)) return [];
          if (
            !allowed.has(u.href) &&
            (u.protocol !== 'wss:' || !previewUrl(u.href.replace(/^wss:/, 'https:')))
          )
            return [];
          return [u.href];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(0, 8);
}
