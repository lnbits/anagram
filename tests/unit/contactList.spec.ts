import type { ContactRecord } from '#src/types/contact.ts';
import {
  buildContactSearchFields,
  searchContactsForList,
  sortContactsForList,
} from '#src/utils/contactList.ts';
import { describe, expect, it } from 'vitest';

const SELF_PUBKEY = 'a'.repeat(64);
const ALICE_PUBKEY = 'b'.repeat(64);
const HEX_NAME_PUBKEY = 'c'.repeat(64);
const NPUB_NAME_PUBKEY = 'd'.repeat(64);

function buildContact(
  overrides: Partial<ContactRecord> & Pick<ContactRecord, 'id' | 'public_key'>
): ContactRecord {
  return {
    id: overrides.id,
    public_key: overrides.public_key,
    type: overrides.type ?? 'user',
    name: overrides.name ?? overrides.public_key,
    given_name: overrides.given_name ?? null,
    meta: overrides.meta ?? {},
    relays: overrides.relays ?? [],
    sendMessagesToAppRelays: overrides.sendMessagesToAppRelays ?? false,
  };
}

describe('contactList utilities', () => {
  it('pins My Self to the top and sinks hex and npub names to the bottom', () => {
    const contacts = sortContactsForList(
      [
        buildContact({
          id: 1,
          public_key: HEX_NAME_PUBKEY,
          meta: { name: '0'.repeat(64) },
        }),
        buildContact({
          id: 2,
          public_key: NPUB_NAME_PUBKEY,
          meta: { name: 'npub1mysterycontact' },
        }),
        buildContact({
          id: 3,
          public_key: ALICE_PUBKEY,
          meta: { name: 'Alice' },
        }),
        buildContact({
          id: 4,
          public_key: SELF_PUBKEY,
          meta: { name: 'Zed' },
        }),
      ],
      { loggedInPubkey: SELF_PUBKEY }
    );

    expect(contacts.map((contact) => contact.id)).toEqual([4, 3, 1, 2]);
  });

  it('searches contact fields in the requested priority order', () => {
    const results = searchContactsForList(
      [
        buildContact({
          id: 1,
          public_key: '1'.repeat(64),
          given_name: 'moon-given',
          meta: { name: 'alpha' },
        }),
        buildContact({
          id: 2,
          public_key: '2'.repeat(64),
          meta: { name: 'moon-name' },
        }),
        buildContact({
          id: 3,
          public_key: '3'.repeat(64),
          meta: { about: 'moon-about' },
        }),
        buildContact({
          id: 4,
          public_key: '4'.repeat(64),
          meta: { name: 'delta', nip05: 'moon@example.com' },
        }),
        buildContact({
          id: 5,
          public_key: '5'.repeat(64),
          meta: { name: 'echo', lud16: 'moon@lightning.test' },
        }),
        buildContact({
          id: 6,
          public_key: '6'.repeat(64),
          meta: { name: 'foxtrot', display_name: 'moon-display' },
        }),
        buildContact({
          id: 7,
          public_key: '7'.repeat(64),
          meta: { name: 'golf', website: 'https://moon.test' },
        }),
      ],
      'moon'
    );

    expect(results.map((contact) => contact.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps identifier-based search as a fallback after the requested profile fields', () => {
    const contact = buildContact({
      id: 1,
      public_key: '8'.repeat(64),
      meta: {},
    });

    expect(
      buildContactSearchFields(contact, {
        resolveNpub: () => 'npub1searchablecontact',
      })
    ).toEqual([
      'npub1searchablecontact',
      '8888888888888888888888888888888888888888888888888888888888888888',
    ]);

    expect(
      searchContactsForList([contact], 'searchable', {
        resolveNpub: () => 'npub1searchablecontact',
      }).map((entry) => entry.id)
    ).toEqual([1]);
  });
});
