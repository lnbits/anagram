import { defineStore } from '#src/lib/state/store.ts';
import { createRelayListStoreSetup } from '#src/stores/relayListStoreFactory.ts';

export type { RelayListEntry } from '#src/stores/relayListStoreFactory.ts';

export const useNip65RelayStore = defineStore(
  'nip65RelayStore',
  createRelayListStoreSetup({
    storageKey: 'nip65_relays',
  })
);
