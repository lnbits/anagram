import { useMessageBubbleStatus } from '#src/composables/useMessageBubbleStatus.ts';
import type { Message } from '#src/types/chat.ts';
import { describe, expect, it } from 'vitest';
import { computed, ref } from '#src/lib/state/reactivity.ts';

describe('useMessageBubbleStatus', () => {
  it('builds outbound relay status tabs with published success counts', () => {
    const message = ref<Message>({
      id: '1',
      chatId: 'self-chat',
      text: 'hello',
      sender: 'me' as const,
      sentAt: '2026-01-01T00:00:00.000Z',
      authorPublicKey: 'self-chat',
      eventId: 'event-1',
      nostrEvent: {
        direction: 'out' as const,
        event: {
          id: 'event-1',
          kind: 14,
          content: 'hello',
          tags: [],
          pubkey: 'self-chat',
          created_at: 1700000000,
          sig: '',
        },
        relay_statuses: [
          {
            relay_url: 'wss://self.example',
            direction: 'outbound' as const,
            scope: 'recipient' as const,
            status: 'published' as const,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          {
            relay_url: 'wss://backup.example',
            direction: 'outbound' as const,
            scope: 'recipient' as const,
            status: 'failed' as const,
            detail: 'publish failed',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          {
            relay_url: 'wss://my.example',
            direction: 'outbound' as const,
            scope: 'self' as const,
            status: 'pending' as const,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      meta: {},
    });

    const { statusSections } = useMessageBubbleStatus({
      contactName: computed(() => 'My Self'),
      contactRelayUrls: computed(() => ['wss://self.example']),
      isMine: computed(() => true),
      message,
    });

    expect(statusSections.value).toEqual([
      expect.objectContaining({
        key: 'recipient',
        title: 'Contact Relays',
        tabLabel: 'Contact Relays (1/2)',
        successCount: 1,
        totalCount: 2,
        retryableCount: 1,
      }),
      expect.objectContaining({
        key: 'self',
        title: 'My Relays',
        tabLabel: 'My Relays (0/1)',
        successCount: 0,
        totalCount: 1,
        retryableCount: 0,
      }),
    ]);
  });
  it('shows relay copies for restored own messages without inventing publish acknowledgements', () => {
    const message = ref<Message>({
      id: '2',
      chatId: 'group',
      text: 'Restored',
      sender: 'me',
      sentAt: '2026-01-01T00:00:00Z',
      authorPublicKey: 'me',
      meta: {},
      nostrEvent: {
        direction: 'out',
        event: {
          id: 'restored',
          kind: 14,
          content: 'Restored',
          tags: [],
          pubkey: 'me',
          created_at: 1,
          sig: '',
        },
        relay_statuses: [
          {
            relay_url: 'wss://archive.example',
            direction: 'inbound',
            scope: 'subscription',
            status: 'received',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    const state = useMessageBubbleStatus({
      message,
      isMine: computed(() => true),
      contactName: computed(() => 'Group'),
      contactRelayUrls: computed(() => ['wss://other.example']),
    });
    expect(state.hasRelayStatuses.value).toBe(true);
    expect(state.showOutboundStatus.value).toBe(false);
    expect(state.statusSegments.value).toEqual([
      { key: 'received', className: 'bubble__status-segment--green', weight: 1 },
    ]);
    expect(state.statusSections.value).toEqual([
      expect.objectContaining({
        key: 'received',
        items: [
          expect.objectContaining({
            relayUrl: 'wss://archive.example',
            status: 'received',
            retryable: false,
          }),
        ],
      }),
    ]);
    // A relay copy must never mask a real failed publish from this device.
    message.value.nostrEvent!.relay_statuses.push({
      relay_url: 'wss://recipient.example',
      direction: 'outbound',
      scope: 'recipient',
      status: 'failed',
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(state.showOutboundStatus.value).toBe(true);
    expect(state.statusSegments.value).toEqual([expect.objectContaining({ key: 'failed' })]);
    expect(state.statusSections.value[0].retryableCount).toBe(1);
    message.value.nostrEvent!.relay_statuses = [];
    expect(state.hasRelayStatuses.value).toBe(false);
  });
});
