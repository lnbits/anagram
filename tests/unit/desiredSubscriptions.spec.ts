import { describe, expect, it, vi } from 'vitest';
import {
  bucketRelayTargets,
  createDesiredSubscriptions,
  subscriptionSignature,
} from '../../src/stores/nostr/desiredSubscriptions';

describe('desired subscriptions', () => {
  it('joins concurrent setup and keeps an unchanged healthy subscription', async () => {
    const runtime = createDesiredSubscriptions();
    let release!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const stop = vi.fn();
    const start = vi.fn((eose: () => void) => {
      eose();
      return { stop };
    });
    const desired = { key: 'contacts', signature: 'same', prepare, start };
    const first = runtime.ensure(desired);
    const second = runtime.ensure(desired);
    expect(first).toBe(second);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    await runtime.reconcile([desired]);
    await runtime.waitForEose();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('invalidates pending setup on logout', async () => {
    const runtime = createDesiredSubscriptions();
    let release!: () => void;
    const start = vi.fn(() => ({ stop: vi.fn() }));
    const pending = runtime.ensure({
      key: 'dm',
      signature: 'a',
      prepare: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      start,
    });
    await Promise.resolve();
    runtime.stop();
    release();
    await pending;
    expect(start).not.toHaveBeenCalled();
  });

  it('only replaces a changed scope and waits for event application at EOSE', async () => {
    const runtime = createDesiredSubscriptions();
    const stop = vi.fn();
    const start = vi.fn((eose: () => void) => {
      eose();
      return { stop };
    });
    const first = { key: 'user', signature: 'user', prepare: async () => {}, start };
    const group = { ...first, key: 'group', signature: 'epoch-1' };
    await runtime.reconcile([first, group]);
    await runtime.reconcile([first, { ...group, signature: 'epoch-2' }]);
    expect(start).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('normalizes signatures and scopes known routes without a Cartesian product', () => {
    const a = 'a'.repeat(64),
      b = 'b'.repeat(64),
      c = 'c'.repeat(64);
    expect(subscriptionSignature({ kinds: [10050, 0], authors: [a, b] }, ['wss://one.test'])).toBe(
      subscriptionSignature({ authors: [b, a], kinds: [0, 10050] }, ['wss://one.test/'])
    );
    const buckets = bucketRelayTargets(
      [
        { publicKey: a, relayUrls: ['wss://group.test'] },
        { publicKey: b, relayUrls: ['wss://dm.test'] },
        { publicKey: c, relayUrls: [] },
      ],
      ['wss://fallback.test']
    );
    expect(
      buckets.find((bucket) => bucket.relayUrls.includes('wss://group.test/'))?.publicKeys
    ).toEqual([a]);
    expect(
      buckets.find((bucket) => bucket.relayUrls.includes('wss://dm.test/'))?.publicKeys
    ).toEqual([b]);
  });
});
