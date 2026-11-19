import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NostrClient, { NostrRelayStatus } from '#src/lib/nostr/client.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const url = 'wss://recovery.example/';
  const client = new NostrClient({ authenticate: false });
  const transport = new AbstractRelay(url, { verifyEvent: () => true, idleTimeout: 20000 });
  const connected = vi.spyOn(transport, 'connected', 'get').mockReturnValue(false);
  vi.spyOn(client.transport, 'listConnectionStatus').mockImplementation(
    () => new Map([[url, transport.connected]]),
  );
  const connect = vi.spyOn(client.transport, 'ensureRelay').mockImplementation(async () => {
    connected.mockReturnValue(true);
    return transport;
  });
  const disconnected = vi.fn();
  client.pool.on('relay:disconnect', disconnected);
  const cancelTraffic = vi.spyOn(client, 'cancelRelayTraffic');
  const relay = client.pool.getRelay(url, false);
  const close = () => {
    connected.mockReturnValue(false);
    transport.close();
  };
  return { relay, transport, connected, connect, close, disconnected, cancelTraffic };
}

describe('relay connection close notifications', () => {
  it('reports one disconnect when subscription cleanup later closes the idle transport again', async () => {
    const { relay, transport, close, disconnected, cancelTraffic } = setup();
    await relay.connect();
    // AUTH failure can set this status before the transport reports its close.
    relay.status = NostrRelayStatus.DISCONNECTED;
    close();
    expect(disconnected).toHaveBeenCalledOnce();

    // Closing subscriptions after a dropped socket arms nostr-tools' idle timer.
    transport.idleSince = Date.now();
    transport.scheduleIdleClose();
    await vi.advanceTimersByTimeAsync(20000);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(cancelTraffic).toHaveBeenCalledOnce();

    await relay.connect();
    close();
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(cancelTraffic).toHaveBeenCalledTimes(2);
  });

  it('ignores a late close from an earlier connection while reconnecting and after reconnect', async () => {
    const { relay, transport, connected, connect, close, disconnected, cancelTraffic } = setup();
    await relay.connect();
    const oldClose = transport.onclose!;
    connected.mockReturnValue(false);
    let completeConnect!: () => void;
    connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeConnect = () => {
            connected.mockReturnValue(true);
            resolve(transport);
          };
        }),
    );
    const reconnect = relay.connect();
    oldClose();
    expect(relay.status).toBe(NostrRelayStatus.CONNECTING);
    expect(disconnected).not.toHaveBeenCalled();
    completeConnect();
    await reconnect;
    oldClose();
    expect(relay.status).toBe(NostrRelayStatus.CONNECTED);
    expect(cancelTraffic).not.toHaveBeenCalled();
    close();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(cancelTraffic).toHaveBeenCalledOnce();
  });
});
