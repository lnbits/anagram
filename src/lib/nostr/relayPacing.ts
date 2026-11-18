import { RelayTrafficPolicy, type RelayCommand } from '#src/stores/nostr/relayTrafficPolicy.ts';

// One wire budget for publications and queries. AUTH/CLOSE remain immediate.
// Long pauses return to the existing retry owners, never retaining stale payloads.
export function paceRelayRequests(
  relay: {
    send(message: string): Promise<void>;
    close(): void;
    connected?: boolean;
    publishTimeout?: number;
  },
  policy = new RelayTrafficPolicy(),
  refusedRequest?: (id: string, reason: string) => void,
  owner: () => string | undefined = () => undefined,
) {
  const send = relay.send.bind(relay),
    close = relay.close.bind(relay);
  type Pending = {
    message: string;
    command: RelayCommand;
    id: string;
    expires: number;
    owner: string | undefined;
    resolve(): void;
    reject(error: unknown): void;
  };
  const queue: Pending[] = [];
  const sent: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function refuse(item: Pending, reason: string) {
    if (item.command === 'REQ') {
      // nostr-tools fire() ignores send() rejections. Use its close callback,
      // after subscribe() has finished assigning the subscription state.
      refusedRequest?.(item.id, reason);
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
        (item.owner !== owner() ? 'Relay operation cancelled after account change' : undefined) ??
        policy.blockReason(item.command) ??
        (relay.connected === false
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
      void send(item.message).then(item.resolve, (error) =>
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
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].command === 'REQ' && queue[i].id === id) queue.splice(i, 1)[0].resolve();
      }
    }
    if (command !== 'REQ' && command !== 'EVENT' && command !== 'COUNT') return send(message);
    const type = command;
    return new Promise<void>((resolve, reject) => {
      const item: Pending = {
        message,
        command: type,
        owner: owner(),
        id,
        expires: type === 'EVENT' ? Date.now() + (relay.publishTimeout ?? 5000) - 1 : Infinity,
        resolve,
        reject,
      };
      if (queue.length >= 256) {
        refuse(item, 'Relay send queue is full; retry later');
        return;
      }
      queue.push(item);
      pump();
    });
  };
  function cancel() {
    clearTimeout(timer);
    for (const item of queue.splice(0)) {
      if (item.command !== 'REQ') item.reject(new Error('Relay closed before publish'));
      else item.resolve();
    }
    sent.length = 0;
  }
  relay.close = () => {
    cancel();
    close();
  };
  return { pump, cancel };
}
