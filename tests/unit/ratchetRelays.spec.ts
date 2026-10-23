import { expect, it } from 'vitest';
import { ratchetRelayUrls } from '#src/stores/nostr/ratchetRelays.ts';

it('shares Iris discovery for NDR while preserving configured and contact relay lists', () => {
  const legacyRelays = ['wss://relay.example', 'wss://contact.example'];
  expect(ratchetRelayUrls(legacyRelays)).toEqual([...legacyRelays, 'wss://relay.snort.social']);
  expect(legacyRelays).toEqual(['wss://relay.example', 'wss://contact.example']);
  expect(ratchetRelayUrls(['wss://relay.snort.social'])).toEqual(['wss://relay.snort.social']);
});
