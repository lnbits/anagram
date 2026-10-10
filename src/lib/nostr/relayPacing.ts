// Bound bursts per connection so profile/history fan-out cannot crowd out a send.
// AUTH/CLOSE are control frames and remain immediate. Cancelling a queued REQ
// removes it before it reaches the wire.
export function paceRelayRequests(relay: { send(message: string): Promise<void>; close(): void }) {
  const send = relay.send.bind(relay),
    close = relay.close.bind(relay);
  type Pending = {
    message: string;
    command: string;
    id: string;
    resolve(): void;
    reject(error: unknown): void;
  };
  const queue: Pending[] = [];
  const sent: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function pump() {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    while (sent.length && now - sent[0] >= 120) sent.shift();
    while (queue.length && sent.length < 8) {
      const index = queue.findIndex((item) => item.command === 'EVENT');
      const item = queue.splice(index < 0 ? 0 : index, 1)[0];
      sent.push(now);
      void send(item.message).then(item.resolve, item.reject);
    }
    if (queue.length) timer = setTimeout(pump, Math.max(1, sent[0] + 120 - now));
  }
  relay.send = (message) => {
    let command: string, id: string;
    try {
      [command, id] = JSON.parse(message);
    } catch {
      return send(message);
    }
    if (command === 'CLOSE') {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].command === 'REQ' && queue[i].id === id) queue.splice(i, 1)[0].resolve();
      }
    }
    if (command !== 'REQ' && command !== 'EVENT') return send(message);
    return new Promise<void>((resolve, reject) => {
      queue.push({ message, command, id, resolve, reject });
      pump();
    });
  };
  relay.close = () => {
    clearTimeout(timer);
    for (const item of queue.splice(0)) {
      if (item.command === 'EVENT') item.reject(new Error('Relay closed before publish'));
      else item.resolve();
    }
    sent.length = 0;
    close();
  };
}
