import { describe, expect, it } from 'vitest';
import { resolvePreferredContactRelayUrls } from '#src/utils/contactRelayUrls.ts';
import {
  mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue,
  relayEntriesFromDirectMessageReceiveRelayEventValue,
} from '#src/stores/nostr/valueUtils.ts';

describe('recipient delivery relay selection', () => {
  it('keeps advertised DM inboxes when a contact also has a write-only outbox', () => {
    const relays = mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
      [{ url: 'wss://outbox.example/', read: false, write: true }],
      relayEntriesFromDirectMessageReceiveRelayEventValue({
        tags: [['relay', 'wss://inbox.example/']],
      }),
    );
    expect(resolvePreferredContactRelayUrls(relays)).toEqual(['wss://inbox.example/']);
  });
  it('uses recipient read relays and unmarked relays rather than write-only relays', () => {
    expect(
      resolvePreferredContactRelayUrls([
        { url: 'wss://outbox.example', read: false, write: true },
        { url: 'wss://inbox.example', read: true, write: false },
        { url: 'wss://both.example', read: true, write: true },
        { url: 'wss://legacy.example' },
      ]),
    ).toEqual(['wss://inbox.example', 'wss://both.example', 'wss://legacy.example']);
  });
  it('retains legacy fallback when no receiving relays are known', () => {
    expect(
      resolvePreferredContactRelayUrls([{ url: 'wss://legacy.example', read: false, write: true }]),
    ).toEqual(['wss://legacy.example']);
    expect(resolvePreferredContactRelayUrls(undefined)).toEqual([]);
  });
});
