import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { BotInteraction } from '#src/services/botInteractionData.ts';

vi.mock('#src/lib/nostr/inbox.ts', () => ({ messageInbox: { clearAllData: async () => {} } }));
vi.mock('#src/services/privateStorageRelayService.ts', () => ({
  privateStorageRelayService: { clearAllData: async () => {} },
}));
vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: { clearAllData: async () => {} },
}));
vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: { clearAllData: async () => {} },
}));
vi.mock('#src/services/developerTraceDataService.ts', () => ({
  developerTraceDataService: { clearAllData: async () => {} },
}));
vi.mock('#src/services/nostrEventDataService.ts', () => ({
  nostrEventDataService: { clearAllData: async () => {} },
}));
vi.mock('#src/services/imageCacheService.ts', () => ({
  imageCacheService: { clearAllData: async () => {} },
}));

function storage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
  };
}
const owner = 'a'.repeat(64),
  other = 'b'.repeat(64);
const target = { type: 'dm' as const, chat: other, bot: other, root: other, version: other };
const interaction: BotInteraction = {
  key: ['dm', other, other, other, other].join(':'),
  updated: 1,
  created: 1,
  request: { op: 'request', id: 'c'.repeat(32), target, data: 'vote', expires: 300 },
  answer: { eventId: other, text: 'A private answer', keyboard: null },
};

beforeEach(() => {
  vi.resetModules();
  const indexedDB = new IDBFactory();
  vi.stubGlobal('indexedDB', indexedDB);
  vi.stubGlobal('window', { indexedDB, localStorage: storage(), sessionStorage: storage() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bot interaction logout cleanup', () => {
  for (const enumeration of ['missing', 'throws']) {
    it(`clears multiple accounts after a reload when database enumeration ${enumeration}`, async () => {
      const { saveBotInteraction } = await import('#src/services/botInteractionData.ts');
      await saveBotInteraction(owner, interaction);
      await saveBotInteraction(other, interaction);
      const list = indexedDB.databases.bind(indexedDB);
      Object.defineProperty(indexedDB, 'databases', {
        value:
          enumeration === 'missing' ? undefined : () => Promise.reject(new Error('Unavailable')),
      });
      // Throw away the in-memory owner registry, as a browser reload would.
      vi.resetModules();
      const { clearPersistedAppState } = await import('#src/utils/logoutCleanup.ts');
      await clearPersistedAppState();
      expect(await list()).toEqual([]);
      expect(window.localStorage.length).toBe(0);
    });
  }
  it('clears an existing database from before the deletion index was introduced', async () => {
    const { saveBotInteraction } = await import('#src/services/botInteractionData.ts');
    await saveBotInteraction(owner, interaction);
    window.localStorage.clear();
    const list = indexedDB.databases.bind(indexedDB);
    Object.defineProperty(indexedDB, 'databases', { value: undefined });
    vi.resetModules();
    const { clearPersistedAppState } = await import('#src/utils/logoutCleanup.ts');
    await clearPersistedAppState({ botInteractionOwner: owner });
    expect(await list()).toEqual([]);
  });
  it('does not allow an outstanding database open to recreate private data during logout', async () => {
    const { saveBotInteraction, clearBotInteractionData } =
      await import('#src/services/botInteractionData.ts');
    const pending = saveBotInteraction(owner, interaction);
    const rejected = expect(pending).rejects.toThrow('cleared');
    await clearBotInteractionData();
    await rejected;
    expect(await indexedDB.databases()).toEqual([]);
  });
  it('retains deletion markers when deletion fails, so the next cleanup can retry', async () => {
    const { saveBotInteraction, clearBotInteractionData } =
      await import('#src/services/botInteractionData.ts');
    await saveBotInteraction(owner, interaction);
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementationOnce(() => {
      throw new Error('Unavailable');
    });
    await expect(clearBotInteractionData()).rejects.toThrow('Unavailable');
    expect(window.localStorage.getItem('anagram-bot-interactions-' + owner)).toBe('1');
    await clearBotInteractionData();
    expect(await indexedDB.databases()).toEqual([]);
  });
});
