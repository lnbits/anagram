import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardRelayAuthentication } from '#src/lib/nostr/relayAuthentication.ts';
import type { AbstractRelay } from 'nostr-tools/abstract-relay';

afterEach(() => vi.useRealTimers());
function setup(auth: AbstractRelay['auth']) {
  const signer = vi.fn(async () => ({}) as never);
  const relay = { auth, onauth: signer, close: vi.fn() };
  const callbacks = { authenticated: vi.fn(), failed: vi.fn() };
  guardRelayAuthentication(relay, callbacks, 100);
  return { relay, callbacks, signer };
}
describe('relay authentication failure isolation', () => {
  it('contains automatic AUTH rejection and never reports it as authenticated', async () => {
    const { relay, callbacks, signer } = setup(async () => {
      throw new Error('serviceUrl missing');
    });
    await expect(relay.auth(signer)).resolves.toBe('');
    expect(callbacks.authenticated).not.toHaveBeenCalled();
    expect(callbacks.failed).toHaveBeenCalledOnce();
    expect(relay.close).toHaveBeenCalledOnce();
  });
  it('preserves rejection for explicit AUTH callers', async () => {
    const { relay, callbacks } = setup(async () => {
      throw new Error('denied');
    });
    await expect(relay.auth(async () => ({}) as never)).rejects.toThrow('authentication failed');
    expect(callbacks.authenticated).not.toHaveBeenCalled();
  });
  it('closes a relay promptly even when the library swallows a signer error', async () => {
    const { relay, callbacks, signer } = setup(
      (sign) =>
        new Promise(() => {
          void sign({ kind: 22242, created_at: 1, tags: [], content: '' }).catch(() => {});
        }),
    );
    signer.mockRejectedValue(new Error('signer unavailable'));
    await relay.auth(signer);
    expect(callbacks.failed).toHaveBeenCalledOnce();
    expect(relay.close).toHaveBeenCalledOnce();
  });
  it('times out silent authentication and prevents late signing from sending AUTH', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const sent = vi.fn();
    const { relay, callbacks, signer } = setup(
      (sign) =>
        new Promise(() => {
          void sign({ kind: 22242, created_at: 1, tags: [], content: '' }).then(sent, () => {});
        }),
    );
    signer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({} as never);
        }),
    );
    const pending = relay.auth(signer);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).not.toHaveBeenCalled();
    expect(callbacks.authenticated).not.toHaveBeenCalled();
    expect(relay.close).toHaveBeenCalledOnce();
  });
  it('reports successful authentication without closing the connection', async () => {
    const { relay, callbacks, signer } = setup(async () => 'accepted');
    await expect(relay.auth(signer)).resolves.toBe('accepted');
    expect(callbacks.authenticated).toHaveBeenCalledOnce();
    expect(callbacks.failed).not.toHaveBeenCalled();
    expect(relay.close).not.toHaveBeenCalled();
  });
});
