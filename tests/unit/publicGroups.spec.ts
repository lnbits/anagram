import { describe, expect, it, vi } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  nip19,
} from 'nostr-tools';
import { ClientEvent } from '#src/lib/nostr/client.ts';
import {
  decodeRoomLink,
  encodeRoomLink,
  publicGroupShareLink,
  newerRoom,
  parsePublicRoom,
  publicRoomRelays,
  roomPolicy,
  roomTags,
  validRoomMessage,
  verifiedPublicEvent,
} from '#src/stores/nostr/publicGroups.ts';
const owner = generateSecretKey(),
  other = generateSecretKey();
const pubkey = getPublicKey(owner),
  outsider = getPublicKey(other);
function definition(tags: string[][] = [], key = owner) {
  return finalizeEvent(
    {
      kind: 34550,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ...roomTags({
          slug: 'lounge',
          name: 'Lounge',
          about: 'Public',
          picture: '',
          relays: ['wss://relay.example.org/'],
          trusted: [outsider],
          blocked: [],
        }),
        ...tags,
      ],
    },
    key,
  );
}
describe('public groups', () => {
  it('accepts 4,000-character posts and rejects longer incoming posts and edits', () => {
    const address = `34550:${pubkey}:lounge`;
    for (const tags of [
      [['a', address]],
      [
        ['a', address],
        ['e', 'a'.repeat(64), '', 'edit'],
      ],
    ]) {
      for (const length of [4000, 4001]) {
        const event = finalizeEvent(
          { kind: 9, created_at: Math.floor(Date.now() / 1000), tags, content: 'x'.repeat(length) },
          other,
        );
        expect(validRoomMessage(event, address)).toBe(length === 4000);
      }
    }
  });
  it('reuses public signature proofs without trusting mutated fields, IDs or signatures', () => {
    const event = definition([['name', 'Signature cache test']]);
    const verify = vi.spyOn(ClientEvent.prototype, 'verifySignature');
    try {
      expect(verifiedPublicEvent(event)).toBe(true);
      expect(verifiedPublicEvent(structuredClone(event))).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
      for (const changed of [
        { ...event, content: 'forged' },
        { ...event, pubkey: outsider },
        { ...event, kind: 9 },
        { ...event, created_at: event.created_at - 1 },
        { ...event, tags: [...event.tags, ['trusted', outsider]] },
      ]) {
        expect(verifiedPublicEvent(changed)).toBe(false);
        expect(verifiedPublicEvent({ ...changed, id: getEventHash(changed) })).toBe(false);
      }
      expect(verifiedPublicEvent({ ...event, id: '0'.repeat(64) })).toBe(false);
      expect(verifiedPublicEvent({ ...event, sig: '0'.repeat(128) })).toBe(false);
      expect(verifiedPublicEvent(event)).toBe(true);
    } finally {
      verify.mockRestore();
    }
  });

  it('still applies time and size limits to events with cached signature proofs', () => {
    const event = definition();
    expect(verifiedPublicEvent(event)).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue((event.created_at - 61) * 1000);
    try {
      expect(verifiedPublicEvent(event)).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(verifiedPublicEvent({ ...event, extra: 'x'.repeat(65536) } as typeof event)).toBe(
      false,
    );
  });

  it('bounds the public proof cache and re-verifies evicted entries', () => {
    // Mock only the expensive elliptic-curve step; real hashes distinguish all
    // entries, while the tests above exercise real signatures and tampering.
    const event = definition([['name', 'Proof eviction']]);
    const verify = vi.spyOn(ClientEvent.prototype, 'verifySignature').mockReturnValue(true);
    try {
      expect(verifiedPublicEvent(event)).toBe(true);
      for (let n = 0; n < 2048; n++) {
        const next = { ...event, content: `Cache entry ${n}` };
        next.id = getEventHash(next);
        expect(verifiedPublicEvent(next)).toBe(true);
      }
      verify.mockClear();
      expect(verifiedPublicEvent(event)).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
  });

  it('binds a signed room to the whole address, not its name or slug', () => {
    const room = parsePublicRoom(definition());
    expect(() => parsePublicRoom(definition([], other), room.address)).toThrow();
    expect(() => parsePublicRoom({ ...definition(), pubkey: outsider })).toThrow();
    expect(() => parsePublicRoom(definition([['d', 'another']]))).toThrow();
  });
  it('canonicalizes links independently of relay hints and rejects other kinds', () => {
    const room = parsePublicRoom(definition());
    expect(decodeRoomLink(encodeRoomLink(room)).address).toBe(room.address);
    expect(
      decodeRoomLink(encodeRoomLink({ ...room, relays: ['wss://another.example.org/'] })).address,
    ).toBe(room.address);
    expect(() =>
      decodeRoomLink(nip19.naddrEncode({ kind: 30078, pubkey, identifier: 'lounge' })),
    ).toThrow();
  });
  it('blocks before trust and makes the owner implicitly trusted', () => {
    const room = parsePublicRoom(definition([['blocked', outsider]]));
    expect(roomPolicy(room, outsider)).toBe('blocked');
    expect(roomPolicy(room, pubkey)).toBe('trusted');
    expect(roomPolicy(room, 'a'.repeat(64))).toBe('plain');
    expect(() => parsePublicRoom(definition([['blocked', pubkey]]))).toThrow();
  });
  it('requires a single room binding and a real signature for public messages', () => {
    const address = parsePublicRoom(definition()).address;
    const message = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        content: 'hello',
        tags: [['a', address]],
      },
      other,
    );
    expect(validRoomMessage(message, address)).toBe(true);
    expect(validRoomMessage({ ...message, content: 'forged' }, address)).toBe(false);
    expect(validRoomMessage(message, address + 'x')).toBe(false);
    expect(
      validRoomMessage(
        finalizeEvent(
          {
            ...message,
            tags: [
              ['a', address],
              ['a', address],
            ],
          },
          other,
        ),
        address,
      ),
    ).toBe(false);
    expect(validRoomMessage(finalizeEvent({ ...message, kind: 14 }, other), address)).toBe(false);
  });
  it('rejects ambiguous transfer pointers and validates the successor kind', () => {
    expect(() =>
      parsePublicRoom(
        definition([
          ['successor', `34550:${outsider}:new`],
          ['successor', `34550:${outsider}:other`],
        ]),
      ),
    ).toThrow();
    expect(() => parsePublicRoom(definition([['successor', `30078:${outsider}:new`]]))).toThrow();
  });
  it('uses NIP-01 replacement ordering', () => {
    const a = parsePublicRoom(definition());
    const b = { ...a, event: { ...a.event, created_at: a.event.created_at + 1 } };
    expect(newerRoom(b, a)).toBe(true);
    expect(newerRoom(a, b)).toBe(false);
    expect(
      newerRoom(
        { ...a, event: { ...a.event, id: '0'.repeat(64) } },
        { ...a, event: { ...a.event, id: 'f'.repeat(64) } },
      ),
    ).toBe(true);
  });
  it('does not connect to local or unsafe relay hints unless explicitly configured', () => {
    expect(
      publicRoomRelays(
        [
          'ws://127.0.0.1:7777',
          'wss://127.0.0.1',
          'wss://169.254.169.254',
          'wss://router.local',
          'wss://user:pass@relay.example.org',
          'wss://relay.example.org/',
        ],
        [],
      ),
    ).toEqual(['wss://relay.example.org/']);
    expect(publicRoomRelays(['ws://127.0.0.1:7777/'], ['ws://127.0.0.1:7777/'])).toEqual([
      'ws://127.0.0.1:7777/',
    ]);
  });
});

it('round-trips preview links and existing public links without changing the room address', () => {
  const room = {
    address: `34550:${pubkey}:lounge`,
    owner: pubkey,
    slug: 'lounge',
    relays: ['wss://relay.example.org/'],
  };
  const token = encodeRoomLink(room);
  const share = publicGroupShareLink(room);
  expect(share).toContain(`/join/chat.html#/public/${token}`);
  expect(decodeRoomLink(share)).toEqual(room);
  expect(decodeRoomLink(`https://anagram.chat/join/chat#/public/${token}`)).toEqual(room);
  expect(decodeRoomLink(`https://anagram.chat/public/${token}`)).toEqual(room);
  expect(() => decodeRoomLink('https://anagram.chat/join/chat.html#https://example.org')).toThrow();
});

it('accepts one pinned message reference and rejects malformed or duplicate pins', () => {
  const id = 'c'.repeat(64);
  const pinned = parsePublicRoom(definition([['pinned', id]]));
  expect(pinned.pinned).toBe(id);
  expect(roomTags(pinned)).toContainEqual(['pinned', id]);
  expect(() => parsePublicRoom(definition([['pinned', 'bad-id']]))).toThrow('pinned');
  expect(() =>
    parsePublicRoom(
      definition([
        ['pinned', id],
        ['pinned', id],
      ]),
    ),
  ).toThrow('pinned');
});
