// An in-process relay: no public traffic, persistent accounts or external services.
import { WebSocketServer } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  nip19,
  verifyEvent,
} from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';

export async function startRelay() {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const events = new Map();
  const sockets = new Map();
  const received = [];
  const stats = { connections: 0, requests: 0, eose: 0, publications: 0 };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const url = `ws://127.0.0.1:${server.address().port}/`;
  function emit(event) {
    events.set(event.id, event);
    for (const [socket, subs] of sockets) {
      for (const [id, filters] of subs) {
        if (socket.readyState === 1 && matchFilters(filters, event))
          socket.send(JSON.stringify(['EVENT', id, event]));
      }
    }
  }
  emit(
    finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({ name: 'Release smoke test' }),
      },
      key,
    ),
  );
  // A real account advertises its DM inbox; avoid the UI's missing-relay prompt.
  for (const [kind, tags] of [
    [10050, [['relay', url]]],
    [10002, [['r', url]]],
  ]) {
    emit(
      finalizeEvent({ kind, tags, content: '', created_at: Math.floor(Date.now() / 1000) }, key),
    );
  }
  server.on('connection', (socket) => {
    stats.connections++;
    const subscriptions = new Map();
    sockets.set(socket, subscriptions);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      try {
        const [verb, id, ...filters] = JSON.parse(data.toString());
        if (verb === 'REQ') {
          stats.requests++;
          subscriptions.set(id, filters);
          for (const event of events.values())
            if (matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
          stats.eose++;
        } else if (verb === 'CLOSE') subscriptions.delete(id);
        else if (verb === 'EVENT') {
          if (!verifyEvent(id)) throw new Error('Invalid signed event');
          stats.publications++;
          if (id.kind === 1059) {
            const rumor = unwrapEvent(id, key);
            if (rumor.pubkey === pubkey && rumor.kind === 14) received.push(rumor.content);
          }
          emit(id);
          socket.send(JSON.stringify(['OK', id.id, true, '']));
        }
      } catch {
        socket.send(JSON.stringify(['NOTICE', 'Invalid test request']));
      }
    });
  });
  return {
    url,
    pubkey,
    nsec: nip19.nsecEncode(key),
    received,
    stats,
    deliver(text) {
      emit(
        wrapEvent(
          {
            kind: 14,
            content: text,
            tags: [['p', pubkey]],
            created_at: Math.floor(Date.now() / 1000),
          },
          key,
          pubkey,
        ),
      );
    },
    disconnect() {
      for (const socket of sockets.keys()) socket.terminate();
    },
    async close() {
      for (const socket of sockets.keys()) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
