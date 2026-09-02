export interface BackgroundTaskOptions {
  delayMs?: number;
  onError?: (error: unknown) => void;
}

interface ScheduledBackgroundTask {
  cancel: () => void;
}

interface BackgroundScheduler {
  postTask?: <T>(
    callback: () => T | PromiseLike<T>,
    options: {
      delay: number;
      priority: 'background';
      signal: AbortSignal;
    }
  ) => Promise<T>;
  yield?: () => Promise<void>;
}

const scheduledTasksByKey = new Map<string, ScheduledBackgroundTask>();

function normalizeDelayMs(value: number | undefined): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

export function scheduleBackgroundTask(
  key: string,
  task: (signal: AbortSignal) => void | Promise<void>,
  options: BackgroundTaskOptions = {}
): () => void {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new Error('A background task key is required.');
  }

  scheduledTasksByKey.get(normalizedKey)?.cancel();

  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let isFinished = false;
  let cancel: () => void;

  const finish = (): void => {
    if (isFinished) {
      return;
    }

    isFinished = true;
    const currentTask = scheduledTasksByKey.get(normalizedKey);
    if (currentTask?.cancel === cancel) {
      scheduledTasksByKey.delete(normalizedKey);
    }
  };

  cancel = (): void => {
    if (isFinished) {
      return;
    }

    abortController.abort();
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    finish();
  };

  scheduledTasksByKey.set(normalizedKey, { cancel });
  const runTask = (): void | Promise<void> => {
    if (abortController.signal.aborted) {
      return;
    }

    return task(abortController.signal);
  };
  const trackTask = (taskPromise: Promise<void>): void => {
    void taskPromise
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          options.onError?.(error);
        }
      })
      .finally(finish);
  };
  const scheduleWithTimer = (): void => {
    timeoutId = globalThis.setTimeout(() => {
      timeoutId = null;
      trackTask(Promise.resolve().then(runTask));
    }, delay);
  };

  const delay = normalizeDelayMs(options.delayMs);
  const scheduler = (globalThis as typeof globalThis & { scheduler?: BackgroundScheduler })
    .scheduler;
  if (typeof scheduler?.postTask === 'function') {
    try {
      trackTask(
        scheduler.postTask(runTask, {
          delay,
          priority: 'background',
          signal: abortController.signal,
        })
      );
    } catch {
      scheduleWithTimer();
    }
  } else {
    scheduleWithTimer();
  }

  return cancel;
}

export function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: BackgroundScheduler })
    .scheduler;

  if (typeof scheduler?.yield === 'function') {
    return scheduler.yield();
  }

  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

export function yieldToNextPaint(): Promise<void> {
  if (
    typeof globalThis.requestAnimationFrame !== 'function' ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  ) {
    return yieldToMainThread();
  }

  return new Promise<void>((resolve) => {
    globalThis.requestAnimationFrame(() => {
      globalThis.setTimeout(resolve, 0);
    });
  });
}
