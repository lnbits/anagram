import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { WebSocket } from 'ws';
// The app tests select browser exports; the fixture needs ws's Node server entry.
const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket: NodeWebSocket } = require(
  require.resolve('ws/package.json').replace('package.json', 'index.js'),
) as typeof import('ws');
import { finalizeEvent, nip19, verifyEvent, type Event } from 'nostr-tools';
import NostrClient, { NostrPrivateKeySigner, NostrRelaySet } from '#src/lib/nostr/client.ts';
import { createPrivateMessageRelayClients } from '#src/stores/nostr/privateMessageRelayClients.ts';
import { createSubscriptionLoggingRuntime } from '#src/stores/nostr/subscriptionLoggingRuntime.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const account = NostrPrivateKeySigner.generate();
  const epoch = NostrPrivateKeySigner.generate();
  const nextEpoch = NostrPrivateKeySigner.generate();
  const client = new NostrClient({ signer: account });
  let owner: string | null = account.pubkey;
  const epochPrivateKey = vi.fn(
    async (recipient: string) =>
      [epoch, nextEpoch].find((key) => key.pubkey === recipient)?.privateKey ?? null,
  );
  const runtime = createPrivateMessageRelayClients({ client, owner: () => owner, epochPrivateKey, configureClient: () => () => {} });
  cleanups.push(() => {
    runtime.reset();
    for (const relay of client.pool.relays.values()) relay.disconnect();
  });
  return {
    client,
    account,
    epoch,
    nextEpoch,
    epochPrivateKey,
    runtime,
    setOwner: (value: string | null) => {
      owner = value;
    },
  };
}

describe('private message relay identities', () => {
  it('shares an epoch only while in use, without changing the account signer', async () => {
    const { runtime, client, account, epoch, nextEpoch } = setup();
    const [personal, live, history, next] = await Promise.all([
      runtime.acquire(account.pubkey),
      runtime.acquire(epoch.pubkey),
      runtime.acquire(epoch.pubkey),
      runtime.acquire(nextEpoch.pubkey),
    ]);
    expect(personal.client).toBe(client);
    expect(live.client).toBe(history.client);
    expect(next.client).not.toBe(live.client);
    expect(next.client.signer?.pubkey).toBe(nextEpoch.pubkey);
    const disconnect = vi.spyOn(
      live.client.pool.getRelay('wss://relay.example/', false),
      'disconnect',
    );
    live.release();
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();
    history.release();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(live.client.signer).toBeUndefined();
    expect(client.signer).toBe(account);
    expect(next.client.signer?.pubkey).toBe(nextEpoch.pubkey);
    next.release();
  });

  it('retains the account relay policy when an old epoch is released and replaced', async () => {
    const { runtime, client, epoch, nextEpoch } = setup();
    const old = await runtime.acquire(epoch.pubkey);
    const url = 'wss://relay.example/';
    const policy = old.client.relayTrafficPolicy(url);
    policy.rateLimited('REQ', 'rate-limited: wait', 60000);
    expect(client.relayTrafficPolicy(url)).toBe(policy);
    old.release();
    await Promise.resolve();
    const next = await runtime.acquire(nextEpoch.pubkey);
    expect(next.client.relayTrafficPolicy(url)).toBe(policy);
    expect(next.client.relayTrafficPolicy(url).delay('REQ')).toBeGreaterThan(59000);
    expect(next.client.relayTrafficPolicy('wss://other.example/').delay('REQ')).toBe(0);
    next.release();
  });

  it('rejects unknown or mismatched keys instead of authenticating as the account', async () => {
    const { runtime, epochPrivateKey, epoch, nextEpoch } = setup();
    await expect(runtime.acquire('f'.repeat(64))).rejects.toThrow('unavailable');
    epochPrivateKey.mockResolvedValue(nextEpoch.privateKey);
    await expect(runtime.acquire(epoch.pubkey)).rejects.toThrow('mismatch');
  });

  it.each(['logout', 'account change'])('discards pending key loads on %s', async (reason) => {
    const { runtime, epochPrivateKey, epoch, setOwner } = setup();
    let finish!: (key: string) => void;
    epochPrivateKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = runtime.acquire(epoch.pubkey);
    const rejected = expect(pending).rejects.toThrow('session changed');
    if (reason === 'logout') runtime.reset();
    else setOwner('a'.repeat(64));
    finish(epoch.privateKey);
    await rejected;
  });

  it('revokes open epoch clients on logout and closes late connections', async () => {
    const { runtime, epoch, client, account } = setup();
    const lease = await runtime.acquire(epoch.pubkey);
    const relay = lease.client.pool.getRelay('wss://relay.example/', false);
    const disconnect = vi.spyOn(relay, 'disconnect');
    runtime.reset();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(lease.client.signer).toBeUndefined();
    await expect(relay.connect()).rejects.toThrow('URL policy');
    lease.client.pool.emit('relay:connect', relay);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(client.signer).toBe(account);
  });

  it('revokes a released epoch immediately but lets pending CLOSE writes finish', async () => {
    const { runtime, epoch } = setup();
    const lease = await runtime.acquire(epoch.pubkey);
    const relay = lease.client.pool.getRelay('wss://relay.example/', false);
    const disconnect = vi.spyOn(relay, 'disconnect');
    // nostr-tools send() schedules the socket write on its connection promise.
    const pendingClose = Promise.resolve().then(() => {
      expect(disconnect).not.toHaveBeenCalled();
    });
    lease.release();
    expect(lease.client.signer).toBeUndefined();
    expect(lease.client.relayConnectionFilter?.(relay.url)).toBe(false);
    await pendingClose;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    'auth-required: authenticate first',
    'ERROR: auth-required: requested filter requires authentication',
  ])(
    'reads history and live wraps after %s',
    async (authReason) => {
      vi.stubGlobal('WebSocket', NodeWebSocket);
      const { client, account, epoch, runtime } = setup();
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      cleanups.push(() => {
        for (const socket of server.clients) socket.terminate();
        server.close();
      });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (typeof address === 'string' || !address) throw new Error('Missing relay address');
      const url = `ws://127.0.0.1:${address.port}/`;
      const sender = NostrPrivateKeySigner.generate();
      const wrap = (recipient: string, content: string) =>
        finalizeEvent(
          {
            kind: 1059,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', recipient]],
            content,
          },
          sender.secretKey,
        );
      const archived = new Map(
        [account, epoch].map((recipient) => [recipient.pubkey, wrap(recipient.pubkey, 'archived')]),
      );
      const authenticated = new Set<string>();
      const wireFrames: string[] = [];
      const logDeveloperTrace = vi.fn();
      const liveTargets: Array<{ socket: WebSocket; id: string; recipient: string }> = [];
      let denied = 0;
      server.on('connection', (socket) => {
        const challenge = crypto.randomUUID();
        let identity: string | undefined;
        socket.on('message', (data) => {
          wireFrames.push(data.toString());
          const [type, id, filter] = JSON.parse(data.toString());
          if (type === 'AUTH') {
            const event = id as Event;
            const valid =
              verifyEvent(event) &&
              event.kind === 22242 &&
              event.tags.some((tag) => tag[0] === 'challenge' && tag[1] === challenge) &&
              event.tags.some((tag) => tag[0] === 'relay' && tag[1] === url);
            if (valid) {
              identity = event.pubkey;
              authenticated.add(identity);
            }
            socket.send(JSON.stringify(['OK', event.id, valid, '']));
          }
          if (type === 'REQ') {
            const recipient = filter['#p']?.[0];
            if (!identity) {
              socket.send(JSON.stringify(['AUTH', challenge]));
              socket.send(JSON.stringify(['CLOSED', id, authReason]));
            } else if (identity !== recipient) {
              denied++;
              socket.send(JSON.stringify(['CLOSED', id, 'restricted: recipient mismatch']));
            } else {
              socket.send(JSON.stringify(['EVENT', id, archived.get(recipient)]));
              socket.send(JSON.stringify(['EOSE', id]));
              liveTargets.push({ socket, id, recipient });
            }
          }
        });
      });
      const logging = createSubscriptionLoggingRuntime({
        ndk: client,
        logDeveloperTrace,
        normalizeEventId: (value) => (typeof value === 'string' ? value : null),
        resolveGroupChatEpochEntries: () => [],
      });
      const personal = await runtime.acquire(account.pubkey);
      const group = await runtime.acquire(epoch.pubkey);
      const events: string[] = [];
      const completed: string[] = [];
      for (const [recipient, lease] of [
        [account.pubkey, personal],
        [epoch.pubkey, group],
      ] as const) {
        const sub = logging.subscribeWithReqLogging(
          'private-messages',
          'auth-test',
          { kinds: [1059], '#p': [recipient] },
          {
            relaySet: NostrRelaySet.fromRelayUrls([url], lease.client, false),
            onEvent: (event) => events.push(`${recipient}:${event.content}`),
            onEose: () => completed.push(recipient),
          },
        );
        cleanups.push(() => sub.stop());
      }
      await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
      expect(authenticated).toEqual(new Set([account.pubkey, epoch.pubkey]));
      expect(events).toContain(`${epoch.pubkey}:archived`);
      expect(events).toContain(`${account.pubkey}:archived`);
      const target = liveTargets.find((item) => item.recipient === epoch.pubkey)!;
      target.socket.send(JSON.stringify(['EVENT', target.id, wrap(epoch.pubkey, 'live')]));
      await vi.waitFor(() => expect(events).toContain(`${epoch.pubkey}:live`));
      const history = await runtime.acquire(epoch.pubkey);
      const onEose = vi.fn();
      const historySub = logging.subscribeWithReqLogging(
        'private-messages',
        'history-test',
        { kinds: [1059], '#p': [epoch.pubkey], until: Math.floor(Date.now() / 1000), limit: 128 },
        {
          relaySet: NostrRelaySet.fromRelayUrls([url], history.client, false),
          closeOnEose: true,
          onEose,
          onClose: history.release,
        },
      );
      cleanups.push(() => historySub.stop());
      await vi.waitFor(() => expect(onEose).toHaveBeenCalledOnce());
      expect(denied).toBe(0);
      expect(client.signer).toBe(account);
      // Exercise actual AUTH/REQ traffic and subscription diagnostics with fresh
      // account/epoch keys, including a second history read on the live socket.
      expect(logDeveloperTrace).toHaveBeenCalled();
      const exposed = JSON.stringify({
        wireFrames,
        diagnostics: logDeveloperTrace.mock.calls,
        signers: [client.signer, group.client.signer],
      });
      for (const signer of [account, epoch]) {
        expect(exposed).not.toContain(signer.privateKey);
        expect(exposed).not.toContain(nip19.nsecEncode(signer.secretKey));
        expect(exposed).not.toContain(JSON.stringify(Array.from(signer.secretKey)));
      }
      for (const frame of wireFrames.map((value) => JSON.parse(value))) {
        if (frame[0] !== 'AUTH') continue;
        expect(Object.keys(frame[1]).sort()).toEqual(
          ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'].sort(),
        );
      }
    },
    15000,
  );
});
