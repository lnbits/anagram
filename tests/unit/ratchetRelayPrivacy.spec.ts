import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { AppKeys, Invite, Session } from 'nostr-double-ratchet';
import NostrClient, { ClientEvent, giftWrap, NostrPrivateKeySigner, NostrUser } from '#src/lib/nostr/client.ts';
import { createRatchetIntegration } from '#src/stores/nostr/ratchetIntegration.ts';
import type { createRatchetRuntime } from '#src/stores/nostr/ratchetRuntime.ts';

const { createRuntime } = vi.hoisted(() => ({ createRuntime: vi.fn() }));
const nodeRequire = createRequire(import.meta.url);
// Svelte tests resolve browser exports; this fixture needs ws's Node server.
const { WebSocketServer } = nodeRequire(
  nodeRequire.resolve('ws/package.json').replace(/package\.json$/, 'index.js'),
) as typeof import('ws');
vi.mock('#src/stores/nostr/ratchetRuntime.ts', () => ({ createRatchetRuntime: createRuntime }));
vi.mock('#src/services/chatDataService.ts', () => ({ chatDataService: {} }));
vi.mock('#src/services/nostrEventDataService.ts', () => ({ nostrEventDataService: {} }));

it('isolates actual DR sends, retries and public key discovery from account AUTH and receiving interests', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const frames: Array<{ connection: number; message: any[] }> = [];
  let serial = 0,
    rejectFirst = true;
  const secret = generateSecretKey(),
    owner = getPublicKey(secret);
  const peer = getPublicKey(generateSecretKey()),
    sibling = getPublicKey(generateSecretKey());
  const seal = (recipient: string) =>
    Session.init(
      getPublicKey(generateSecretKey()),
      generateSecretKey(),
      true,
      generateSecretKey(),
    ).sendEvent({ kind: 14, content: 'private' }, [['p', recipient]]).event;
  const ownCopy = seal(sibling),
    peerCopy = seal(peer);
  const ownerProof = finalizeEvent(
    new AppKeys([{ identityPubkey: owner, createdAt: Math.floor(Date.now() / 1000) }]).getEvent({
      ownerPubkey: owner,
    }),
    secret,
  );
  const firstContact = (await Invite.createNew(peer, peer).accept(owner, secret, owner, ownerProof))
    .event;
  const privateIds = new Set([ownCopy.id, peerCopy.id, firstContact.id]);
  server.on('connection', (socket) => {
    const connection = ++serial,
      challenge = `privacy-${connection}`;
    let authenticated = false;
    socket.send(JSON.stringify(['AUTH', challenge]));
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      frames.push({ connection, message });
      const [command, value] = message;
      if (command === 'AUTH') {
        authenticated =
          verifyEvent(value) &&
          value.kind === 22242 &&
          value.tags.some((tag: string[]) => tag[0] === 'challenge' && tag[1] === challenge);
        socket.send(
          JSON.stringify([
            'OK',
            value.id,
            authenticated,
            authenticated ? '' : 'auth-required: invalid',
          ]),
        );
      } else if (command === 'EVENT') {
        const accepted = authenticated && !(value.id === peerCopy.id && rejectFirst);
        if (authenticated && value.id === peerCopy.id) rejectFirst = false;
        socket.send(
          JSON.stringify([
            'OK',
            value.id,
            accepted,
            accepted ? '' : authenticated ? 'blocked: retry' : 'auth-required: authenticate',
          ]),
        );
      } else if (command === 'REQ') {
        if (authenticated && message.slice(2).some((filter: any) =>
          filter.kinds?.includes(37368) && filter.authors?.includes(owner)))
          socket.send(JSON.stringify(['EVENT', value, ownerProof]));
        socket.send(
          JSON.stringify(
            authenticated ? ['EOSE', value] : ['CLOSED', value, 'auth-required: authenticate'],
          ),
        );
      }
    });
  });
  let transport!: Parameters<typeof createRatchetRuntime>[0];
  createRuntime.mockImplementation(async (value) => {
    transport = value;
    return { close: async () => {}, send: vi.fn() };
  });
  vi.stubGlobal('localStorage', { getItem: () => '1' });
  const client = new NostrClient({ signer: new NostrPrivateKeySigner(secret) });
  const legacyCall = await giftWrap(new ClientEvent(client, {
    kind: 21117, tags: [['p', peer]], content: 'encrypted call control',
  }), new NostrUser({ pubkey: peer }), client.signer!);
  privateIds.add(legacyCall.id);
  const integration = createRatchetIntegration({
    client,
    owner: () => owner,
    signer: async () => client.signer!,
    relays: async () => [url],
    receive: async () => {},
  });
  const stops: Array<() => void> = [];
  try {
    await integration.resume();
    stops.push(transport.subscribe({ kinds: [1059], '#p': [sibling] }, () => {}));
    for (const key of [owner, peer])
      stops.push(transport.subscribe({ kinds: [37368], authors: [key] }, () => {}));
    const roster = await transport.registrationRoster();
    expect(roster.map((event) => event.id)).toContain(ownerProof.id);
    expect(Object.isFrozen(roster[0])).toBe(false);
    expect(Object.isFrozen(roster[0].tags)).toBe(false);
    await transport.fetch({ kinds: [30078], authors: [peer] });
    const profiles = client.subscribe(
      { kinds: [0, 10002, 10050], authors: [owner, peer, sibling] },
      { relayUrls: [url] },
    );
    stops.push(() => profiles.stop());
    await client.fetchEvents(
      { kinds: [0, 10002, 10050], authors: [owner, peer, sibling] },
      { relayUrls: [url] },
    );
    await transport.publish(finalizeEvent(Invite.createNew(owner, owner).getEvent(), secret));
    await expect(transport.publish(peerCopy)).rejects.toThrow();
    for (const event of [peerCopy, ownCopy, firstContact]) await transport.publish(event);
    // Call publication reaches NostrRelay.publish, outside the NDR adapter.
    await client.pool.getRelay(url, false).publish(legacyCall);
    await client.pool.getRelay(url, false).publish(legacyCall);
    const bareCall = finalizeEvent({ kind: 21117, created_at: Math.floor(Date.now() / 1000),
      tags: [['p', peer]], content: 'private call control' }, secret);
    await expect(Promise.all(client.transport.publish([url], bareCall))).rejects.toThrow('encrypted session');
    expect(frames.some(({ message }) => message[0] === 'EVENT' && message[1].id === bareCall.id)).toBe(false);
    await vi.waitFor(() =>
      expect(
        frames.some(({ message }) => message[0] === 'AUTH' && message[1].pubkey === owner),
      ).toBe(true),
    );
    const privateConnections = new Set(
      frames
        .filter(({ message }) => message[0] === 'EVENT' && privateIds.has(message[1].id))
        .map((frame) => frame.connection),
    );
    const authKeys = new Set<string>();
    expect(privateConnections.size).toBeGreaterThanOrEqual(4);
    for (const connection of privateConnections) {
      const messages = frames
        .filter((frame) => frame.connection === connection)
        .map((frame) => frame.message);
      expect(messages.some((message) => message[0] === 'REQ')).toBe(false);
      expect(
        new Set(
          messages.filter((message) => message[0] === 'EVENT').map((message) => message[1].id),
        ).size,
      ).toBe(1);
      const keys = new Set<string>(
        messages.filter((message) => message[0] === 'AUTH').map((message) => message[1].pubkey),
      );
      expect(keys.size).toBe(1);
      for (const key of keys) {
        expect([owner, peer, sibling]).not.toContain(key);
        expect(authKeys.has(key)).toBe(false);
        authKeys.add(key);
      }
    }
    for (const connection of new Set(
      frames
        .filter(
          ({ message }) =>
            message[0] === 'REQ' &&
            message
              .slice(2)
              .some((filter) =>
                filter.kinds?.some((kind: number) =>
                  [0, 10002, 10050, 37368, 30078].includes(kind),
                ),
              ),
        )
        .map((frame) => frame.connection),
    )) {
      const messages = frames
        .filter((frame) => frame.connection === connection)
        .map((frame) => frame.message);
      expect(messages.some((message) => message[0] === 'EVENT')).toBe(false);
      expect(
        messages
          .filter((message) => message[0] === 'AUTH')
          .every((message) => message[1].pubkey !== owner),
      ).toBe(true);
      expect(
        new Set(
          messages
            .filter((message) => message[0] === 'REQ')
            .flatMap((message) =>
              message.slice(2).flatMap((filter) => filter.authors ?? filter['#p'] ?? []),
            ),
        ).size,
      ).toBe(1);
    }
  } finally {
    stops.forEach((stop) => stop());
    await integration.close();
    client.transport.close([...client.transport.relays.keys()]);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
  }
});
