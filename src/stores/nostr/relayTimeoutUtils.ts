export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  const normalizedTimeoutMs = Math.max(0, Math.floor(timeoutMs));
  if (normalizedTimeoutMs === 0) {
    return fallback;
  }

  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = globalThis.setTimeout(() => {
          timeoutId = null;
          resolve(fallback);
        }, normalizedTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

export async function waitForFirstReadyOrTimeout(options: {
  isReady: () => boolean;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<'ready' | 'timeout'> {
  if (options.isReady()) {
    return 'ready';
  }

  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
  if (timeoutMs === 0) {
    return options.isReady() ? 'ready' : 'timeout';
  }

  const pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? 25));
  const deadlineAt = Date.now() + timeoutMs;

  while (Date.now() < deadlineAt) {
    if (options.isReady()) {
      return 'ready';
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, Math.min(pollIntervalMs, remainingMs));
    });
  }

  return options.isReady() ? 'ready' : 'timeout';
}

export function selectReadyRelayUrls(
  relayUrls: string[],
  isRelayReady: (relayUrl: string) => boolean
): string[] {
  return relayUrls.filter((relayUrl) => isRelayReady(relayUrl));
}
