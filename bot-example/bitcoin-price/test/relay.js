// Local relay fixture: real WebSockets, signatures, filters, EOSE and publish ACKs.
import { WebSocketServer, WebSocket } from 'ws';
import { matchFilters, verifyEvent } from 'nostr-tools';
export async function relay(options = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await new Promise((resolve) => wss.once('listening', resolve));
  const events = new Map(),
    subscriptions = new Map();
  const fixture = {
    url: `ws://127.0.0.1:${wss.address().port}/`,
    events,
    subscriptions,
    reject: false,
    requireAuth: false,
    online: true,
    connections: [],
  };
  const emit = (event) => {
    events.set(event.id, event);
    for (const [socket, subs] of subscriptions)
      for (const [id, filters] of subs) {
        if (socket.readyState === WebSocket.OPEN && matchFilters(filters, event))
          socket.send(JSON.stringify(['EVENT', id, event]));
      }
  };
  wss.on('connection', (socket) => {
    fixture.connections.push(Date.now());
    socket.on('error', () => {});
    if (!fixture.online) {
      socket.terminate();
      return;
    }
    const subs = new Map();
    const authorized = new Set();
    const challenge = `challenge-${Math.random()}`;
    if (fixture.requireAuth) socket.send(JSON.stringify(['AUTH', challenge]));
    subscriptions.set(socket, subs);
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (raw) => {
      const [type, ...data] = JSON.parse(raw.toString());
      if (type === 'AUTH') {
        const event = data[0];
        const ok =
          verifyEvent(event) &&
          event.kind === 22242 &&
          event.tags.some((t) => t[0] === 'challenge' && t[1] === challenge) &&
          event.tags.some((t) => t[0] === 'relay' && t[1] === fixture.url);
        if (ok) authorized.add(event.pubkey);
        socket.send(JSON.stringify(['OK', event.id, ok, ok ? '' : 'invalid: auth']));
      } else if (type === 'EVENT') {
        const event = data[0];
        const accepted = !fixture.reject && verifyEvent(event);
        if (accepted) emit(event);
        socket.send(
          JSON.stringify(['OK', event.id, accepted, accepted ? '' : 'blocked: test rejection']),
        );
      } else if (type === 'REQ') {
        const [id, ...filters] = data;
        if (
          fixture.requireAuth &&
          filters.some((f) => f.kinds?.includes(1059) && f['#p']?.some((p) => !authorized.has(p)))
        ) {
          socket.send(JSON.stringify(['CLOSED', id, 'auth-required: authenticate as recipient']));
          return;
        }
        subs.set(id, filters);
        const selected = [...events.values()]
          .filter((e) => matchFilters(filters, e))
          .sort((a, b) => b.created_at - a.created_at);
        for (const event of selected.slice(0, Math.max(...filters.map((f) => f.limit ?? 1000))))
          socket.send(JSON.stringify(['EVENT', id, event]));
        socket.send(JSON.stringify(['EOSE', id]));
      } else if (type === 'CLOSE') subs.delete(data[0]);
    });
  });
  fixture.emit = emit;
  fixture.disconnect = () => {
    for (const socket of wss.clients) socket.terminate();
  };
  fixture.close = () =>
    new Promise((resolve) => {
      fixture.disconnect();
      wss.close(resolve);
    });
  return fixture;
}
export async function until(condition, message = 'condition', timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
