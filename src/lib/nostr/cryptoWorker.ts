import type { Event } from 'nostr-tools';
let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (event: Event) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export function disposeCryptoWorker() {
  worker?.terminate();
  worker = null;
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('Session ended'));
  }
  pending.clear();
}
export function unwrapInWorker(wrap: Event, key: Uint8Array, requireEmptySealTags = false): Promise<Event> {
  if (!worker) {
    worker = new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      clearTimeout(item.timer);
      data.error ? item.reject(new Error(data.error)) : item.resolve(data.rumor);
    };
    worker.onerror = () => disposeCryptoWorker();
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Message decryption timed out'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    const copy = key.slice();
    worker!.postMessage({ id, wrap, key: copy, requireEmptySealTags }, [copy.buffer]);
  });
}
