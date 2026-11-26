import { resetStores } from '#src/lib/state/store.svelte.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { useMessageStore } from '#src/stores/messageStore.svelte.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHAT_ID = 'c'.repeat(64);

vi.mock('#src/stores/chatStore.svelte.ts', () => ({
  useChatStore: () => ({ selectedChatId: 'c'.repeat(64) }),
}));
vi.mock('#src/services/nostrEventDataService.ts', () => ({
  nostrEventDataService: {
    init: vi.fn().mockResolvedValue(undefined),
    getEventsByIds: vi.fn().mockResolvedValue(new Map()),
  },
}));

beforeEach(() => {
  resetStores();
  vi.stubGlobal('window', { indexedDB, localStorage: { getItem: () => null } });
});

afterEach(async () => {
  resetStores();
  await chatDataService.clearAllData();
  vi.unstubAllGlobals();
});

describe('bounded private message history', () => {
  it.each(['group', 'user'] as const)(
    'restores every newer message after paging backwards beyond the %s window',
    async (type) => {
      await chatDataService.createChat({ public_key: CHAT_ID, name: 'History', type });
      const expectedIds: string[] = [];
      for (let index = 0; index < 650; index++) {
        const row = await chatDataService.createMessage({
          chat_public_key: CHAT_ID,
          author_public_key: (index % 2 ? 'a' : 'b').repeat(64),
          message: `History ${index}`,
          created_at: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
        });
        expect(row).not.toBeNull();
        expectedIds.push(String(row!.id));
      }

      const store = useMessageStore();
      await store.loadMessages(CHAT_ID);
      const backwards = new Set(store.getMessages(CHAT_ID).map((message) => message.id));
      for (let page = 0; store.getPaginationState(CHAT_ID).hasOlder && page < 20; page++) {
        await store.loadOlderMessages(CHAT_ID);
        expect(store.getMessages(CHAT_ID).length).toBeLessThanOrEqual(500);
        for (const message of store.getMessages(CHAT_ID)) backwards.add(message.id);
      }
      expect(backwards).toEqual(new Set(expectedIds));
      expect(store.getMessages(CHAT_ID).map((message) => message.id)).toEqual(
        expectedIds.slice(0, 500),
      );
      expect(store.getPaginationState(CHAT_ID)).toMatchObject({ hasOlder: false, hasNewer: true });

      // A background refresh must preserve the reader's window and its forward cursor.
      await store.loadMessages(CHAT_ID, true);
      expect(store.getMessages(CHAT_ID).map((message) => message.id)).toEqual(
        expectedIds.slice(0, 500),
      );
      const forwards = new Set(store.getMessages(CHAT_ID).map((message) => message.id));
      for (let page = 0; store.getPaginationState(CHAT_ID).hasNewer && page < 20; page++) {
        await store.loadNewerMessages(CHAT_ID);
        expect(store.getMessages(CHAT_ID).length).toBeLessThanOrEqual(500);
        for (const message of store.getMessages(CHAT_ID)) forwards.add(message.id);
      }
      expect(forwards).toEqual(new Set(expectedIds));
      expect(store.getMessages(CHAT_ID).map((message) => message.id)).toEqual(
        expectedIds.slice(-500),
      );
      expect(store.getPaginationState(CHAT_ID)).toMatchObject({ hasOlder: true, hasNewer: false });
    },
  );
});
