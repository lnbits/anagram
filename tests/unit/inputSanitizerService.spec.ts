import { nip19 } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { describe, expect, it } from 'vitest';

describe('inputSanitizerService', () => {
  it('normalizes contact metadata by trimming fields, normalizing owner keys, and deduplicating group members', () => {
    expect(
      inputSanitizerService.normalizeContactMetadata({
        name: ' Alice ',
        about: '  Launch squad  ',
        picture: '   ',
        private_contact_list_member: true,
        muted: true,
        blocked: true,
        blocked_at: ' 2026-06-03T00:00:00.000Z ',
        owner_public_key: 'A'.repeat(64),
        group_private_key_encrypted: ' encrypted-secret ',
        group_members: [
          {
            public_key: 'B'.repeat(64),
            name: ' Bob ',
          },
          {
            public_key: 'b'.repeat(64),
            name: ' Robert ',
            given_name: ' Rob ',
            picture: ' https://example.com/rob.png ',
            avatar: ' RB ',
            about: ' Builder ',
            nprofile: ' nprofile1member ',
          },
          {
            public_key: 'not-a-pubkey',
            name: 'Ignored',
          },
        ],
      }),
    ).toEqual({
      name: 'Alice',
      about: 'Launch squad',
      private_contact_list_member: true,
      muted: true,
      blocked: true,
      blocked_at: '2026-06-03T00:00:00.000Z',
      owner_public_key: 'a'.repeat(64),
      group_private_key_encrypted: 'encrypted-secret',
      group_members: [
        {
          public_key: 'b'.repeat(64),
          name: 'Robert',
          given_name: 'Rob',
          picture: 'https://example.com/rob.png',
          avatar: 'RB',
          about: 'Builder',
          nprofile: 'nprofile1member',
        },
      ],
    });
  });

  it('preserves known recovery conflicts through storage and allows explicit resolution', () => {
    const first = 'a'.repeat(64),
      second = 'b'.repeat(64);
    const encoded = inputSanitizerService.serializeContactMetadata({
      group_recovery_conflicts: [first, second, first],
    });
    expect(
      inputSanitizerService.parseStoredContactMetadata(encoded).group_recovery_conflicts,
    ).toEqual([first, second]);
    expect(
      inputSanitizerService.normalizeContactMetadata({ group_recovery_conflicts: [] })
        .group_recovery_conflicts,
    ).toEqual([]);
    expect(
      inputSanitizerService.normalizeContactMetadata({
        group_recovery_conflicts: ['invalid', null, 42],
      }).group_recovery_conflicts,
    ).toEqual([]);
  });

  it('validates nsec and npub identifiers and rejects the wrong bech32 type', () => {
    const hexKey = '1'.repeat(64);
    const nsec = nip19.nsecEncode(Uint8Array.from(Buffer.from(hexKey, 'hex')));
    const npub = nip19.npubEncode(hexKey);

    expect(inputSanitizerService.validateNsec(nsec)).toEqual({
      isValid: true,
      hexPrivateKey: hexKey,
      format: 'nsec',
    });
    expect(inputSanitizerService.validateNpub(npub)).toEqual({
      isValid: true,
      normalizedPubkey: hexKey,
    });
    expect(inputSanitizerService.validateNsec(npub)).toEqual({
      isValid: false,
      hexPrivateKey: null,
      format: null,
    });
    expect(inputSanitizerService.validateNpub('npub1notreal')).toEqual({
      isValid: false,
      normalizedPubkey: null,
    });
  });
});
