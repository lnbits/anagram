import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  authLinkTarget,
  authLinkMetadata,
  watchAuthLinkPreview,
} from '#src/stores/nostr/authLinkPreview.ts';
import NostrClient, {
  type NostrSubscription,
  type NostrSubscriptionOptions,
} from '#src/lib/nostr/client.ts';

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const naddr = nip19.naddrEncode({
  kind: 34550,
  pubkey,
  identifier: 'lounge',
  relays: ['wss://nos.lol'],
});
const group = authLinkTarget(`https://anagram.chat/public/${naddr}`)!;
const profile = authLinkTarget(`https://anagram.chat/chats/${pubkey}`)!;
const sign = (kind: number, content = '', tags: string[][] = []) =>
  finalizeEvent(
    {
      kind,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    key,
  );

describe('logged-out link metadata', () => {
  it('shares requests, limits concurrent discovery and cancels unused or expired requests', async () => {
    vi.useFakeTimers();
    const stops: ReturnType<typeof vi.fn>[] = [];
    const subscriptions = vi
      .spyOn(NostrClient.prototype, 'subscribe')
      .mockImplementation((_filters, options: NostrSubscriptionOptions = {}) => {
        const stop = vi.fn(() => options.onClose?.());
        stops.push(stop);
        return { stop } as unknown as NostrSubscription;
      });
    const releases: (() => void)[] = [];
    try {
      releases.push(
        watchAuthLinkPreview(group, () => {}),
        watchAuthLinkPreview(group, () => {}),
      );
      for (let i = 1; i <= 4; i++)
        releases.push(
          watchAuthLinkPreview(
            { type: 'profile', pubkey: String(i).repeat(64), relays: [] },
            () => {},
          ),
        );
      expect(subscriptions).toHaveBeenCalledTimes(3);
      releases[0]();
      expect(stops[0]).not.toHaveBeenCalled();
      releases[5](); // Cancel a queued request before it starts.
      releases[1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(stops[0]).toHaveBeenCalledOnce();
      expect(subscriptions).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(5000);
      expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
      expect(subscriptions).toHaveBeenCalledTimes(4);
    } finally {
      releases.forEach((release) => release());
      subscriptions.mockRestore();
      vi.useRealTimers();
    }
  });
  it('recognizes direct, share-page and public profile links without accepting secrets or private group routes', () => {
    expect(authLinkTarget(`https://anagram.chat/join/chat.html#/public/${naddr}`)).toEqual(group);
    for (const id of [
      pubkey,
      nip19.npubEncode(pubkey),
      nip19.nprofileEncode({ pubkey, relays: [] }),
    ])
      expect(authLinkTarget(`https://anagram.chat/chats/${id}`)).toEqual(profile);
    for (const path of [
      '/',
      '/chats/requests',
      `/groups/${pubkey}`,
      '/public/broken',
      `/chats/${nip19.nsecEncode(key)}`,
    ])
      expect(authLinkTarget(`https://anagram.chat${path}`)).toBeNull();
  });

  it('requires the signed group address and refuses forged or mismatched metadata', () => {
    const event = sign(34550, '', [
      ['d', 'lounge'],
      ['anagram-room', '1'],
      ['name', 'The lounge'],
      ['relay', 'wss://nos.lol'],
      ['image', 'https://example.org/group.png'],
    ]);
    expect(authLinkMetadata(group, event)).toEqual({
      name: 'The lounge',
      picture: 'https://example.org/group.png',
    });
    expect(
      authLinkMetadata(group, { ...event, tags: [...event.tags, ['name', 'Forged']] }),
    ).toBeNull();
    expect(authLinkMetadata({ ...group, address: `34550:${pubkey}:other` }, event)).toBeNull();
    expect(authLinkMetadata({ ...group, pubkey: 'a'.repeat(64) }, event)).toBeNull();
  });

  it('bounds profile labels, rejects unsafe images and keeps only public display fields', () => {
    expect(
      authLinkMetadata(
        profile,
        sign(
          0,
          JSON.stringify({
            display_name: 'A'.repeat(1000),
            picture: 'javascript:alert(1)',
            secret: 'unused',
          }),
        ),
      ),
    ).toEqual({ name: 'A'.repeat(100), picture: '' });
    expect(
      authLinkMetadata(
        profile,
        sign(
          0,
          JSON.stringify({
            display_name: '  ',
            name: 'Alice',
            picture: 'https://example.org/alice.png',
          }),
        ),
      ),
    ).toEqual({ name: 'Alice', picture: 'https://example.org/alice.png' });
    expect(authLinkMetadata(profile, sign(0, '{'))).toBeNull();
    expect(authLinkMetadata(profile, sign(14, '{}'))).toBeNull();
    const event = sign(0, '{"name":"Alice"}');
    expect(authLinkMetadata(profile, { ...event, content: '{"name":"Forged"}' })).toBeNull();
  });
});
