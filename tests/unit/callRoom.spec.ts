import { type CallRoomLink, ROOM_PROTOCOL } from '#src/types/callRoom.ts';
import {
  formatRoomLink,
  parseRoomLink,
  parseRoomSignal,
  roomLinkToken,
  roomLinkStatus,
} from '#src/utils/callRoom.ts';
import { describe, expect, it } from 'vitest';

const link: CallRoomLink = {
  id: crypto.randomUUID(),
  host: 'a'.repeat(64),
  secret: 'b'.repeat(64),
  relays: ['wss://relay.example'],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const member = { pubkey: link.host, sessionId: link.id, name: 'Alice', relays: link.relays };
const join = {
  protocol: ROOM_PROTOCOL,
  roomId: link.id,
  senderSession: link.id,
  action: 'join',
  expiresAt: link.expiresAt,
  secret: link.secret,
  member,
};
const parse = (value: unknown) =>
  parseRoomSignal(JSON.stringify(value), Math.floor(Date.now() / 1000));
describe('group call links and authenticated control payloads', () => {
  it('keeps the room capability in the URL fragment and supports pasted installed-app links', () => {
    const web = formatRoomLink(link, 'https://chat.example/app/?tracking=1');
    expect(new URL(web).pathname).toBe('/join/call.html');
    expect(new URL(web).search).toBe('');
    expect(parseRoomLink(web)).toEqual(link);
    expect(parseRoomLink(formatRoomLink(link, 'file:///app/index.html'))).toEqual(link);
    expect(parseRoomLink(roomLinkToken(link))).toEqual(link);
    expect(formatRoomLink(link, 'https://localhost/', true)).toBe(
      `https://anagram.chat/join/call.html#/call/${roomLinkToken(link)}`,
    );
    expect(formatRoomLink(link, 'http://tauri.localhost/')).toContain(
      'https://anagram.chat/join/call.html#',
    );
    expect(parseRoomLink(`anagram://room/call/${roomLinkToken(link)}`)).toEqual(link);
    // HTTP requests and crawler metadata never contain the room capability.
    const requestUrl = new URL(web);
    requestUrl.hash = '';
    expect(requestUrl.href).toBe('https://chat.example/join/call.html');
  });
  it('rejects expired, malformed, oversized and unsafe relay links', () => {
    expect(parseRoomLink(roomLinkToken({ ...link, secret: 'short' }))).toBeNull();
    expect(
      parseRoomLink(roomLinkToken({ ...link, expiresAt: new Date(0).toISOString() })),
    ).toBeNull();
    expect(parseRoomLink(roomLinkToken({ ...link, relays: ['file:///secret'] }))).toBeNull();
    expect(parseRoomLink('a'.repeat(8193))).toBeNull();
  });
  it('recognizes expired invitations for display while still rejecting them for joining', () => {
    const expires = Date.parse(link.expiresAt);
    const token = roomLinkToken(link);
    expect(roomLinkStatus(token, expires - 1)).toBe('active');
    expect(roomLinkStatus(token, expires)).toBe('expired');
    expect(roomLinkStatus(token, expires + 86400000)).toBe('expired');
    expect(parseRoomLink(token, expires)).toBeNull();
    expect(roomLinkStatus(token, expires - 86400000)).toBeNull();
    for (const invalid of [
      { ...link, secret: 'short' },
      { ...link, expiresAt: 'invalid' },
      { ...link, relays: ['file:///secret'] },
    ]) expect(roomLinkStatus(roomLinkToken(invalid), expires)).toBeNull();
  });
  it('validates optional name revisions and strips unrecognized styling fields', () => {
    const renamed = {
      ...join,
      member: { ...member, name: 'New name', nameRevision: 2, css: 'body{}' },
    };
    expect(parse(renamed)?.member).toEqual({ ...member, name: 'New name', nameRevision: 2 });
    for (const revision of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])
      expect(
        parse({ ...renamed, member: { ...renamed.member, nameRevision: revision } }),
      ).toBeNull();
    expect(parse(join)?.member).toEqual(member);
  });
  it('validates joining identity/session binding and bounds group membership', () => {
    expect(parse(join)).toEqual(join);
    expect(parse({ ...join, member: { ...member, sessionId: crypto.randomUUID() } })).toBeNull();
    expect(parse({ ...join, action: 'roster', revision: 1, members: [member, member] })).toBeNull();
    expect(
      parse({ ...join, action: 'roster', revision: 1, members: Array(7).fill(member) }),
    ).toBeNull();
    expect(parseRoomSignal(JSON.stringify(join), Math.floor(Date.now() / 1000) - 61)).toBeNull();
  });
});
