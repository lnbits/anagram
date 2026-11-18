import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';

test('rate-limit feedback survives reconnect while another relay continues publishing', async ({
  page,
}) => {
  const servers = [0, 1].map(() => new WebSocketServer({ host: '127.0.0.1', port: 0 }));
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.once('listening', resolve))),
  );
  const urls = servers.map(
    (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
  );
  const publications = [0, 0];
  for (const [index, server] of servers.entries()) {
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [command, event] = JSON.parse(String(data));
        if (command !== 'EVENT') return;
        publications[index]++;
        socket.send(
          JSON.stringify(
            index === 0 && publications[0] === 1
              ? ['OK', event.id, false, 'rate-limited: wait', '2000']
              : ['OK', event.id, true, ''],
          ),
        );
      }),
    );
  }
  try {
    await page.goto('/');
    const result = await page.evaluate(async (urls) => {
      // Exercise the production adapter's installation hook and real WebSockets.
      // @ts-expect-error Vite serves this source module in the browser.
      const {
        default: NostrClient,
        NostrPrivateKeySigner,
        ClientEvent,
      } = await import('/src/lib/nostr/client.ts');
      const client = new NostrClient({ authenticate: false });
      const signer = NostrPrivateKeySigner.generate();
      client.signer = signer;
      const relays = urls.map((url) => client.pool.getRelay(url, false));
      const event = new ClientEvent(client, {
        kind: 1,
        tags: [],
        content: 'relay policy browser test',
      });
      await event.sign(signer);
      try {
        await Promise.all(relays.map((relay) => relay.connect()));
        const first = await Promise.allSettled(relays.map((relay) => relay.publish(event)));
        relays[0].disconnect();
        await relays[0].connect();
        const duringPause = await Promise.allSettled(relays.map((relay) => relay.publish(event)));
        const remaining = client.relayTrafficPolicy(urls[0]).delay('EVENT');
        await new Promise((resolve) => setTimeout(resolve, remaining + 20));
        const recovered = await relays[0].publish(event);
        return {
          first: first.map((result) => result.status),
          duringPause: duringPause.map((result) => result.status),
          remaining,
          recovered,
        };
      } finally {
        relays.forEach((relay) => relay.disconnect());
      }
    }, urls);
    expect(result.first).toEqual(['rejected', 'fulfilled']);
    expect(result.duringPause).toEqual(['rejected', 'fulfilled']);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.recovered).toBe(true);
    expect(publications).toEqual([2, 2]);
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) socket.terminate();
            server.close(() => resolve());
          }),
      ),
    );
  }
});
