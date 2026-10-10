import type { NostrEvent } from '#src/lib/nostr/client.ts';

// Owner-signed snapshot of the supplied starter group. This lets the initial
// sidebar render offline; opening the room refreshes its policy through relays.
export const STARTER_PUBLIC_GROUP: NostrEvent = {
  content: '',
  created_at: 1791472906,
  id: '56964b136b3ff2b5d8c4927ca81099d7c2ccfd8382c57fb0523c0a254588d3a5',
  kind: 34550,
  pubkey: 'c1fc7771f5fa418fd3ac49221a18f19b42ccb7a663da8f04cbbf6c08c80d20b1',
  sig: '274bf172b03de87b6467ff0d69f83e76f7923465d3ccc74c451162593906c03e65d890b87f82ebaa8c8c0abe86f9db3e111a1c3e5681f61f718cd17a2f805cc4',
  tags: [
    ['d', 'c609a674-94c2-4af3-a810-ffbbdd7ac4cb'],
    ['anagram-room', '1'],
    ['name', 'Anagram rants'],
    ['description', ''],
    ['pinned', '01d30742542c215d8e01d17fe4ae1123d63d0e8c83b778230e82aac18f8c627e'],
    [
      'image',
      'https://npub1c878wu04lfqcl5avfy3p5x83ndpvedaxv0dg7pxthakq3jqdyzcs2n8avm.blossom.band/721d7e8ec095b4b132b8d1ed86d4a1987070e96b2c00af329979d02b6c5942c2.png',
    ],
    ['relay', 'wss://relay.nostr.com/'],
    ['relay', 'wss://relay.damus.io/'],
    ['relay', 'wss://nostr.mom/'],
    ['relay', 'wss://nostr.bitcoiner.social/'],
    ['relay', 'wss://nos.lol/'],
  ],
};
