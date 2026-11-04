import type { Readable } from 'svelte/store';

// Hydration can update state many times within one frame. Keep the initial value
// synchronous, then publish the latest snapshot once per frame-sized interval.
export function coalesceStore<T>(
  source: Readable<T>,
  immediateKey?: (value: T) => unknown,
): Readable<T> & { flush(): void } {
  const flushers = new Set<() => void>();
  return {
    flush() {
      for (const flush of flushers) flush();
    },
    subscribe(run) {
      let initial = true;
      let key: unknown;
      let latest: T;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        run(latest);
      };
      flushers.add(flush);
      const stop = source.subscribe((value) => {
        latest = value;
        const nextKey = immediateKey?.(value);
        // Navigation must not wait behind a hydration batch for the old chat.
        if (initial || !Object.is(key, nextKey)) {
          initial = false;
          key = nextKey;
          clearTimeout(timer);
          timer = undefined;
          run(value);
        } else if (timer === undefined) {
          timer = setTimeout(flush, 16);
        }
      });
      return () => {
        clearTimeout(timer);
        flushers.delete(flush);
        stop();
      };
    },
  };
}
