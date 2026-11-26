import { RelayTrafficPolicy, type RelayCommand } from '#src/stores/nostr/relayTrafficPolicy.ts';

type RelayWire = {
  send(message: string): Promise<void>;
  close(): void;
  connected?: boolean;
  publishTimeout?: number;
};
type Socket = {
  relay: RelayWire;
  send: RelayWire['send'];
  owner: () => string | undefined;
  refusedRequest?: (id: string, reason: string) => void;
};
type Pending = {
  socket: Socket;
  message: string;
  command: RelayCommand;
  id: string;
  expires: number;
  owner: string | undefined;
  resolve(): void;
  reject(error: unknown): void;
};
const schedulers = new WeakMap<RelayTrafficPolicy, ReturnType<typeof createRelayScheduler>>();

// One wire budget per relay for the account and all its epoch sockets.
// AUTH/CLOSE remain immediate.
// Long pauses return to the existing retry owners, never retaining stale payloads.
export function paceRelayRequests(
  relay: RelayWire,
  policy = new RelayTrafficPolicy(),
  refusedRequest?: (id: string, reason: string) => void,
  owner: () => string | undefined = () => undefined,
) {
  const send = relay.send.bind(relay),
    close = relay.close.bind(relay);
  const socket: Socket = { relay, send, owner, refusedRequest };
  let scheduler = schedulers.get(policy);
  if (!scheduler) {
    scheduler = createRelayScheduler(policy);
    schedulers.set(policy, scheduler);
  }
  relay.send = (message) => {
    let command: string, id: string;
    try {
      const frame = JSON.parse(message);
      command = frame[0];
      id = command === 'EVENT' ? (frame[1]?.id ?? frame[1]) : frame[1];
    } catch {
      return send(message);
    }
    if (command === 'CLOSE') {
      scheduler.cancelRequest(socket, id);
    }
    if (command !== 'REQ' && command !== 'EVENT' && command !== 'COUNT') return send(message);
    const type = command;
    return new Promise<void>((resolve, reject) => {
      const item: Pending = {
        socket,
        message,
        command: type,
        owner: owner(),
        id,
        expires: type === 'EVENT' ? Date.now() + (relay.publishTimeout ?? 5000) - 1 : Infinity,
        resolve,
        reject,
      };
      scheduler.enqueue(item);
    });
  };
  const cancel = () => scheduler.cancel(socket);
  relay.close = () => {
    cancel();
    close();
  };
  return { pump: scheduler.pump, cancel };
}

function createRelayScheduler(policy: RelayTrafficPolicy) {
  const queue: Pending[] = [];
  const sent: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function refuse(item: Pending, reason: string) {
    if (item.command === 'REQ') {
      // nostr-tools fire() ignores send() rejections. Use its close callback,
      // after subscribe() has finished assigning the subscription state.
      item.socket.refusedRequest?.(item.id, reason);
      item.resolve();
    } else item.reject(new Error(reason));
  }
  function pump() {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      const reason =
        (item.owner !== item.socket.owner()
          ? 'Relay operation cancelled after account change'
          : undefined) ??
        policy.blockReason(item.command) ??
        (item.socket.relay.connected === false
          ? 'Relay closed before send'
          : item.expires <= now
            ? 'Publish timed out before send'
            : undefined);
      if (reason) {
        queue.splice(i, 1);
        refuse(item, reason);
      }
    }
    while (sent.length && now - sent[0] >= 120) sent.shift();
    while (queue.length && sent.length < 8) {
      const ready = (item: Pending) => policy.spacingDelay(item.command) <= 0;
      let index = queue.findIndex((item) => item.command === 'EVENT' && ready(item));
      if (index < 0) index = queue.findIndex(ready);
      if (index < 0) break;
      const item = queue.splice(index, 1)[0];
      sent.push(now);
      policy.sent(item.command);
      void item.socket
        .send(item.message)
        .then(item.resolve, (error) =>
          refuse(item, error instanceof Error ? error.message : String(error)),
        );
    }
    if (queue.length) {
      const spacing = Math.min(...queue.map((item) => policy.spacingDelay(item.command)));
      const burst = sent.length >= 8 ? sent[0] + 120 - now : 0;
      // Resolve queued publications before nostr-tools' ACK timer fires; an
      // expired send must neither reach the socket nor leave an unhandled promise.
      const expiry = Math.min(...queue.map((item) => item.expires - now));
      timer = setTimeout(pump, Math.max(1, Math.min(Math.max(spacing, burst), expiry)));
    }
  }
  return {
    pump,
    enqueue(item: Pending) {
      if (queue.length >= 256) {
        refuse(item, 'Relay send queue is full; retry later');
        return;
      }
      queue.push(item);
      pump();
    },
    cancelRequest(socket: Socket, id: string) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const item = queue[i];
        if (item.socket === socket && item.command === 'REQ' && item.id === id)
          queue.splice(i, 1)[0].resolve();
      }
    },
    cancel(socket: Socket) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].socket !== socket) continue;
        const item = queue.splice(i, 1)[0];
        if (item.command !== 'REQ') item.reject(new Error('Relay closed before publish'));
        else item.resolve();
      }
      // Closing an epoch socket must not reset the shared burst budget.
      pump();
    },
  };
}
