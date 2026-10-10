import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { computed, ref } from '#src/lib/state/reactivity.ts';

export interface RelayListEntry {
  url: string;
  read: boolean;
  write: boolean;
}

interface RelayListStoreFactoryOptions {
  storageKey: string;
  defaultRelays?: string[];
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStoredRelays(storageKey: string): RelayListEntry[] | null {
  if (!hasStorage()) {
    return null;
  }

  try {
    const value = window.localStorage.getItem(storageKey);
    if (value === null || value === undefined || value.trim() === '') {
      return null;
    }

    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed
      .map((entry) => inputSanitizerService.normalizeRelayListEntry(entry))
      .filter((entry): entry is RelayListEntry => entry !== null);
  } catch (error) {
    console.warn(`Failed to read relay list from localStorage key "${storageKey}"`, error);
    return null;
  }
}

function writeStoredRelays(storageKey: string, relays: RelayListEntry[]): void {
  if (!hasStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(relays));
  } catch (error) {
    console.warn(`Failed to persist relay list to localStorage key "${storageKey}"`, error);
  }
}

export function createRelayListStoreSetup({
  storageKey,
  defaultRelays = [],
}: RelayListStoreFactoryOptions) {
  function defaultRelayEntries(): RelayListEntry[] {
    return defaultRelays
      .map((relay) => relay.trim())
      .filter((relay) => relay.length > 0)
      .map((url) => ({
        url,
        read: true,
        write: true,
      }));
  }

  return function relayListStoreSetup() {
    const relayEntries = ref<RelayListEntry[]>([]);
    const relays = computed(() => relayEntries.value.map((entry) => entry.url));
    const isInitialized = ref(false);

    function clear(): void {
      relayEntries.value = [];
      isInitialized.value = true;

      if (!hasStorage()) {
        return;
      }

      try {
        window.localStorage.removeItem(storageKey);
      } catch (error) {
        console.warn(`Failed to clear relay list from localStorage key "${storageKey}"`, error);
      }
    }

    function ensureInitialized(): void {
      if (!isInitialized.value) {
        init();
      }
    }

    function init(): void {
      if (isInitialized.value) {
        return;
      }

      const storedRelays = readStoredRelays(storageKey);
      relayEntries.value = storedRelays ? [...storedRelays] : defaultRelayEntries();
      writeStoredRelays(storageKey, relayEntries.value);
      isInitialized.value = true;
    }

    function addRelay(relay: string): void {
      const value = relay.trim();
      if (!value) {
        return;
      }

      ensureInitialized();
      relayEntries.value = [
        ...relayEntries.value,
        {
          url: value,
          read: true,
          write: true,
        },
      ];
      writeStoredRelays(storageKey, relayEntries.value);
    }

    function removeRelay(index: number): void {
      ensureInitialized();
      relayEntries.value = relayEntries.value.filter((_, relayIndex) => relayIndex !== index);
      writeStoredRelays(storageKey, relayEntries.value);
    }

    function restoreDefaults(): void {
      ensureInitialized();
      relayEntries.value = defaultRelayEntries();
      writeStoredRelays(storageKey, relayEntries.value);
    }

    function getRelayFlags(index: number): Pick<RelayListEntry, 'read' | 'write'> {
      ensureInitialized();
      const entry = relayEntries.value[index];
      return {
        read: entry?.read ?? true,
        write: entry?.write ?? true,
      };
    }

    function setRelayFlags(
      index: number,
      flags: Partial<Pick<RelayListEntry, 'read' | 'write'>>
    ): void {
      ensureInitialized();

      const current = relayEntries.value[index];
      if (!current) {
        return;
      }

      relayEntries.value = relayEntries.value.map((entry, relayIndex) => {
        if (relayIndex !== index) {
          return entry;
        }

        return {
          ...entry,
          read: typeof flags.read === 'boolean' ? flags.read : entry.read,
          write: typeof flags.write === 'boolean' ? flags.write : entry.write,
        };
      });

      writeStoredRelays(storageKey, relayEntries.value);
    }

    function replaceRelayEntries(entries: unknown[]): void {
      ensureInitialized();
      relayEntries.value = inputSanitizerService.normalizeRelayListMetadataEntries(
        entries as Array<{
          url: string;
          read?: boolean;
          write?: boolean;
        }>
      );
      writeStoredRelays(storageKey, relayEntries.value);
    }

    return {
      relayEntries,
      relays,
      init,
      addRelay,
      clear,
      removeRelay,
      replaceRelayEntries,
      restoreDefaults,
      getRelayFlags,
      setRelayFlags,
    };
  };
}
