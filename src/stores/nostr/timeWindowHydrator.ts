/** Bounded background workers for time-window hydration. Every request has a
 * finite window and page cap; offline routes back off without blocking others. */
export async function hydrateTimeWindows<T extends { key: string }>(options: {
  discover: () => Promise<T[]>;
  step: (target: T) => Promise<boolean>;
  cancelled: () => boolean;
  onError: (target: T, error: unknown) => void;
  signal: AbortSignal;
  concurrency?: number;
  concurrencyKey?: (target: T) => string;
  onDiscoveryError?: (error: unknown) => void;
}): Promise<void> {
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 2)));
  const jobs = new Map<string, { target: T; done: boolean; failures: number; retryAt: number }>();
  const active = new Map<string, Promise<void>>();
  const activeKeys = new Set<string>();
  const concurrencyKey = (target: T) => options.concurrencyKey?.(target) ?? target.key;
  const cancelled = () => options.cancelled() || options.signal.aborted;
  let discoveryRetryAt = 0,
    discoveryFailures = 0;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  options.signal.addEventListener('abort', notify);
  try {
    while (!cancelled()) {
      if (Date.now() >= discoveryRetryAt) {
        try {
          for (const target of await options.discover()) {
            if (!jobs.has(target.key))
              jobs.set(target.key, { target, done: false, failures: 0, retryAt: 0 });
          }
          discoveryRetryAt = 0;
          discoveryFailures = 0;
        } catch (error) {
          discoveryRetryAt =
            Date.now() + Math.min(60000, 1000 * 2 ** Math.min(discoveryFailures++, 6));
          options.onDiscoveryError?.(error);
        }
      }
      if (cancelled()) return;
      for (const [key, job] of [...jobs]) {
        if (active.size >= concurrency) break;
        if (
          job.done ||
          active.has(key) ||
          activeKeys.has(concurrencyKey(job.target)) ||
          job.retryAt > Date.now()
        )
          continue;
        // Round robin: a deep/busy relay must yield to newly discovered inboxes
        // and group epochs instead of winning by insertion order on every wake.
        jobs.delete(key);
        jobs.set(key, job);
        activeKeys.add(concurrencyKey(job.target));
        const work = Promise.resolve()
          .then(async () => {
            try {
              job.done = await options.step(job.target);
              job.failures = 0;
              job.retryAt = Date.now() + 250;
            } catch (error) {
              if (!cancelled()) {
                job.failures++;
                job.retryAt =
                  Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.failures - 1, 6));
                options.onError(job.target, error);
              }
            }
          })
          .finally(() => {
            active.delete(key);
            activeKeys.delete(concurrencyKey(job.target));
            notify();
          });
        active.set(key, work);
      }
      if (!discoveryRetryAt && !active.size && [...jobs.values()].every((job) => job.done)) return;
      const retryAt = Math.min(
        discoveryRetryAt || Infinity,
        ...[...jobs.values()]
          .filter(
            (job) =>
              active.size < concurrency &&
              !job.done &&
              !active.has(job.target.key) &&
              !activeKeys.has(concurrencyKey(job.target)),
          )
          .map((job) => job.retryAt),
      );
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        timer = setTimeout(
          notify,
          Number.isFinite(retryAt) ? Math.max(25, retryAt - Date.now()) : 30000,
        );
        if (cancelled()) notify();
      });
    }
  } finally {
    options.signal.removeEventListener('abort', notify);
  }
}
