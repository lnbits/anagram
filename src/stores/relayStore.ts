import { defineStore } from '#src/lib/state/store.ts';
import { DEFAULT_RELAYS } from '#src/constants/relays.ts';
import { createRelayListStoreSetup } from '#src/stores/relayListStoreFactory.ts';

export type { RelayListEntry } from '#src/stores/relayListStoreFactory.ts';

export const useRelayStore = defineStore(
  'relayStore',
  createRelayListStoreSetup({
    storageKey: 'relays',
    defaultRelays: DEFAULT_RELAYS,
  })
);
