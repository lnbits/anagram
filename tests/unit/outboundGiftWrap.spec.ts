import { type NDKEvent, NDKKind, type NostrEvent } from '@nostr-dev-kit/ndk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ getEventById: vi.fn(), upsertEvent: vi.fn() }));
vi.mock('src/services/nostrEventDataService', () => ({ nostrEventDataService: data }));

import { getOrCreateOutboundGiftWrap } from 'src/stores/nostr/outboundGiftWrap';

describe('persisted outbound gift wraps', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reuses ciphertext across concurrent targets, retries and subsequent runtime calls, keeping self separate', async () => {
    const rumor: NostrEvent = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      kind: 14,
      created_at: 1,
      content: '',
      tags: [],
    };
    let saved: {
      event: NostrEvent;
      gift_wraps?: Partial<Record<'recipient' | 'self', NostrEvent>>;
    } = { event: rumor };
    data.getEventById.mockImplementation(async () => saved);
    data.upsertEvent.mockImplementation(async (input) => {
      saved = { ...saved, gift_wraps: { ...saved.gift_wraps, ...input.gift_wraps } };
      return saved;
    });
    let count = 0;
    const create = vi.fn(
      async () =>
        ({
          toNostrEvent: async () => ({
            ...rumor,
            kind: NDKKind.GiftWrap,
            id: String(++count).repeat(64),
            sig: 'd'.repeat(128),
          }),
        }) as NDKEvent
    );
    const [first, second] = await Promise.all([
      getOrCreateOutboundGiftWrap(rumor, 'recipient', create),
      getOrCreateOutboundGiftWrap(rumor, 'recipient', create),
    ]);
    const retry = await getOrCreateOutboundGiftWrap(rumor, 'recipient', create);
    const self = await getOrCreateOutboundGiftWrap(rumor, 'self', create);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(retry.id);
    expect(self.id).not.toBe(first.id);
    expect(create).toHaveBeenCalledTimes(2);
    expect(data.upsertEvent).toHaveBeenCalledTimes(2);
  });
  it('does not permit publication when saving the signed event fails', async () => {
    data.getEventById.mockResolvedValue(null);
    data.upsertEvent.mockRejectedValue(new Error('disk full'));
    await expect(
      getOrCreateOutboundGiftWrap(
        { id: 'e'.repeat(64) } as NostrEvent,
        'recipient',
        async () => ({ toNostrEvent: async () => ({}) }) as NDKEvent
      )
    ).rejects.toThrow('disk full');
  });
});
