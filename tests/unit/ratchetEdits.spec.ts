import { beforeEach, expect, it, vi } from 'vitest';
import type { Rumor } from 'nostr-double-ratchet';
import { applyRatchetEdit } from '#src/stores/nostr/ratchetEdits.ts';

const state = vi.hoisted(() => ({ row: null as any, apply: vi.fn(), refresh: vi.fn() }));
vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: {
    getMessageByEventId: async () => state.row,
    applyMessageEdit: async (_id: number, input: any) => {
      state.apply(input);
      return (state.row = { ...state.row, ...input });
    },
  },
}));
vi.mock('#src/stores/messageStore.svelte.ts', () => ({
  useMessageStore: () => ({ upsertPersistedMessage: state.refresh }),
}));
const owner = 'a'.repeat(64),
  peer = 'b'.repeat(64),
  originalId = 'c'.repeat(64);
function edit(id: string, ms: number, content: string): Rumor {
  return {
    id,
    pubkey: peer,
    kind: 1009,
    content,
    created_at: Math.floor(ms / 1000),
    tags: [
      ['p', owner],
      ['e', originalId],
      ['k', '14'],
      ['ms', String(ms)],
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.row = {
    id: 1,
    event_id: originalId,
    chat_public_key: peer,
    author_public_key: peer,
    message: 'original',
    created_at: new Date(1700000000000).toISOString(),
    meta: { protocol: 'ndr' },
  };
});
it('retains the original ID and orders same-second edits by milliseconds before event ID', async () => {
  await applyRatchetEdit(edit('1'.repeat(64), 1700000010900, 'newer'), peer, owner);
  await applyRatchetEdit(edit('f'.repeat(64), 1700000010100, 'older'), peer, owner);
  expect(state.row.message).toBe('newer');
  expect(state.row.event_id).toBe(originalId);
  expect(state.row.created_at).toBe(new Date(1700000000000).toISOString());
  expect(state.apply).toHaveBeenCalledTimes(1);
});
it('accepts an edit in the same second as an original with a millisecond timestamp', async () => {
  state.row.created_at = new Date(1700000000500).toISOString();
  await applyRatchetEdit(edit('1'.repeat(64), 1700000000700, 'immediate edit'), peer, owner);
  expect(state.row.message).toBe('immediate edit');
  expect(state.row.created_at).toBe(new Date(1700000000500).toISOString());
  expect(state.apply).toHaveBeenCalledTimes(1);
});
it('defers missing originals and rejects another author or edits after deletion', async () => {
  const original = state.row;
  state.row = null;
  expect(await applyRatchetEdit(edit('1'.repeat(64), 1700000010900, 'later'), peer, owner)).toBe(
    false,
  );
  state.row = original;
  await applyRatchetEdit(edit('1'.repeat(64), 1700000010900, 'forged'), owner, owner);
  state.row.meta.deleted = { deletedAt: new Date().toISOString() };
  await applyRatchetEdit(edit('1'.repeat(64), 1700000010900, 'revive'), peer, owner);
  expect(state.apply).not.toHaveBeenCalled();
});
