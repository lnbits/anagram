import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  calculateDelayMs,
  classifyRelayMessage,
  parseCommandLineArguments,
  resolveMockRelayConfig,
  resolveRelayResponseBehavior,
  startMockRelayProxy,
} from '../../scripts/mock-relay-proxy.cjs';

describe('mock relay proxy', () => {
  it('rejects duplicate bursts deterministically and records routing without ciphertext or signatures', async () => {
    const sockets = new Set<Socket>();
    const upstream = createServer();
    upstream.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    upstream.on('upgrade', (request, socket) => {
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const portReservation = createServer();
    await new Promise<void>((resolve) => portReservation.listen(0, '127.0.0.1', resolve));
    const port = (portReservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portReservation.close(() => resolve()));
    const relay = await startMockRelayProxy({
      listenPort: port,
      targetUrl: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      rateLimit: { windowMs: 10_000, maxFrames: 8 },
    });
    const client = new WebSocket(relay.relayUrl);
    const replies: unknown[] = [];
    client.addEventListener('message', (event) => replies.push(JSON.parse(String(event.data))));
    try {
      await new Promise<void>((resolve, reject) => {
        client.addEventListener('open', () => resolve(), { once: true });
        client.addEventListener('error', reject, { once: true });
      });
      for (let index = 0; index < 9; index += 1)
        client.send(
          JSON.stringify(['REQ', `scope-${index}`, { kinds: [1059], '#p': ['a'.repeat(64)] }])
        );
      const eventId = 'b'.repeat(64);
      client.send(
        JSON.stringify([
          'EVENT',
          {
            id: eventId,
            kind: 1059,
            content: 'PRIVATE_CIPHERTEXT',
            sig: 'PRIVATE_SIGNATURE',
            tags: [['secret', 'PRIVATE_TAG']],
          },
        ])
      );
      await expect.poll(() => relay.trafficSnapshot().rateLimitRejections).toBe(2);
      expect(relay.trafficSnapshot().duplicateActiveSignatures).toBeGreaterThan(0);
      await expect.poll(() => replies.length).toBe(2);
      expect(replies).toContainEqual(['CLOSED', 'scope-8', 'rate-limited: cool off']);
      expect(replies).toContainEqual(['OK', eventId, false, 'rate-limited: cool off']);
      const snapshot = JSON.stringify(relay.trafficSnapshot());
      expect(snapshot).not.toContain('PRIVATE_');
      expect(relay.trafficSnapshot().frames.at(-1)).toMatchObject({
        command: 'EVENT',
        eventId,
        kind: 1059,
      });
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await relay.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
  it('uses a shared delay unless a relay phase overrides it', () => {
    const config = resolveMockRelayConfig(
      {},
      {
        MOCK_RELAY_DELAY_MS: '700',
        MOCK_RELAY_ACK_DELAY_MS: '1200',
        MOCK_RELAY_DROP_EOSE: 'true',
        MOCK_RELAY_HANG_MODE: 'none',
      }
    );

    expect(config).toMatchObject({
      handshakeDelayMs: 700,
      requestDelayMs: 700,
      ackDelayMs: 1200,
      eventDelayMs: 700,
      eoseDelayMs: 700,
      dropEose: true,
    });
  });

  it('rejects invalid delay and hang settings', () => {
    expect(() => resolveMockRelayConfig({}, { MOCK_RELAY_ACK_DELAY_MS: '-1' })).toThrow(
      'MOCK_RELAY_ACK_DELAY_MS'
    );
    expect(() => resolveMockRelayConfig({}, { MOCK_RELAY_HANG_MODE: 'sometimes' })).toThrow(
      'MOCK_RELAY_HANG_MODE'
    );
  });

  it.each([
    ['["OK","event-id",true,""]', 'ack'],
    ['["EVENT","subscription",{}]', 'event'],
    ['["EOSE","subscription"]', 'eose'],
    ['["NOTICE","maintenance"]', 'other'],
    ['not-json', 'other'],
  ])('classifies %s as %s', (message, expectedType) => {
    expect(classifyRelayMessage(message)).toBe(expectedType);
  });

  it('applies per-message delay, jitter, and drop behavior', () => {
    const config = resolveMockRelayConfig(
      {
        ackDelayMs: 200,
        eventDelayMs: 300,
        eoseDelayMs: 400,
        jitterMs: 100,
        dropAcks: true,
      },
      {}
    );

    expect(resolveRelayResponseBehavior('["OK","id",true,""]', config, () => 0.5)).toEqual({
      delayMs: 250,
      messageType: 'ack',
      shouldDrop: true,
    });
    expect(resolveRelayResponseBehavior('["EVENT","sub",{}]', config, () => 0)).toEqual({
      delayMs: 300,
      messageType: 'event',
      shouldDrop: false,
    });
  });

  it('drops every relay response in response-hang mode', () => {
    const config = resolveMockRelayConfig({ hangMode: 'responses' }, {});

    expect(resolveRelayResponseBehavior('["NOTICE","waiting"]', config)).toMatchObject({
      messageType: 'other',
      shouldDrop: true,
    });
  });

  it('parses standalone command-line settings', () => {
    expect(
      parseCommandLineArguments([
        '--target',
        'ws://relay.example:8080',
        '--ack-delay-ms',
        '2500',
        '--drop-eose',
        '--verbose',
      ])
    ).toEqual({
      targetUrl: 'ws://relay.example:8080',
      ackDelayMs: '2500',
      dropEose: true,
      verbose: true,
    });
  });

  it('adds inclusive bounded jitter', () => {
    expect(calculateDelayMs(100, 20, () => 0)).toBe(100);
    expect(calculateDelayMs(100, 20, () => 0.999)).toBe(120);
  });
});
