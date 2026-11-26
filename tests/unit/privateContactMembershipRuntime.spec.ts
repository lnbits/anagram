import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateContactMembershipRuntime } from '#src/stores/nostr/privateContactMembershipRuntime.ts';

const chatData = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getChatByPublicKey: vi.fn(),
}));
vi.mock('#src/services/chatDataService.ts', () => ({ chatDataService: chatData }));

describe('contact-list chat reconciliation', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { state: 'blocked', acceptedAt: '', shouldAccept: false },
    { state: 'accepted', acceptedAt: '2026-01-01T00:00:00.000Z', shouldAccept: false },
    { state: '', acceptedAt: '', shouldAccept: true },
  ])(
    'preserves $state chat state while restoring contacts',
    async ({ state, acceptedAt, shouldAccept }) => {
      const key = 'b'.repeat(64);
      chatData.getChatByPublicKey.mockResolvedValue({
        public_key: key,
        meta: { inbox_state: state, accepted_at: acceptedAt },
      });
      const chatStore = { init: vi.fn(async () => {}), acceptChat: vi.fn(async () => {}) };
      const runtime = createPrivateContactMembershipRuntime({
        bumpContactListVersion: vi.fn(),
        chatStore,
      });
      await runtime.reconcileAcceptedChatFromPrivateContactList(key);
      expect(chatStore.acceptChat).toHaveBeenCalledTimes(shouldAccept ? 1 : 0);
    },
  );
});
