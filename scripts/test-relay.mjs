import { WebSocketServer } from 'ws';
import { matchFilters, verifyEvent } from 'nostr-tools';
const server = new WebSocketServer({
  port: Number(process.env.TEST_RELAY_PORT || 7777),
  host: '127.0.0.1',
});
let paused = false;
const events = new Map();
const subscriptions = new Map();
server.on('connection', (socket) => {
  subscriptions.set(socket, new Map());
  socket.on('message', (data) => {
    try {
      const [verb, id, ...rest] = JSON.parse(data.toString());
      if (verb === 'TEST_CONTROL') {
        paused = id;
        socket.send(JSON.stringify(['TEST_CONTROL', paused]));
        for (const peer of subscriptions.keys()) if (peer !== socket) peer.terminate();
        return;
      }
      if (paused) {
        if (verb === 'EVENT')
          socket.send(JSON.stringify(['OK', id.id, false, 'error: test relay paused']));
        else if (verb === 'REQ')
          socket.send(JSON.stringify(['CLOSED', id, 'error: test relay paused']));
        return;
      }
      if (verb === 'EVENT') {
        const event = id;
        if (!verifyEvent(event)) {
          socket.send(JSON.stringify(['OK', event.id, false, 'invalid']));
          return;
        }
        events.set(event.id, event);
        socket.send(JSON.stringify(['OK', event.id, true, '']));
        for (const [peer, subs] of subscriptions)
          for (const [sid, filters] of subs)
            if (peer.readyState === 1 && matchFilters(filters, event))
              peer.send(JSON.stringify(['EVENT', sid, event]));
      } else if (verb === 'REQ') {
        subscriptions.get(socket).set(id, rest);
        const seen = new Set();
        for (const filter of rest) {
          for (const event of [...events.values()]
            .filter((e) => matchFilters([filter], e))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit ?? events.size)) {
            if (!seen.has(event.id)) {
              seen.add(event.id);
              socket.send(JSON.stringify(['EVENT', id, event]));
            }
          }
        }
        socket.send(JSON.stringify(['EOSE', id]));
      } else if (verb === 'CLOSE') subscriptions.get(socket).delete(id);
    } catch (error) {
      socket.send(JSON.stringify(['NOTICE', String(error)]));
    }
  });
  socket.on('close', () => subscriptions.delete(socket));
});
console.log('Test relay ready on ws://127.0.0.1:7777');
