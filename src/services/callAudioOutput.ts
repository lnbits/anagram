// Output changes are serialized per element. Browser switches cannot be cancelled;
// reconcile a late result once, and never retry against a detached/replaced stream.
type Selection = {
  revision: number;
  target: string;
  confirmed: string;
  active: boolean;
  queue: Promise<void>;
  repairs: number;
};
const selections = new WeakMap<HTMLMediaElement, Selection>();
export function releaseCallSpeaker(element: HTMLMediaElement | undefined): void {
  if (!element) return;
  const selection = selections.get(element);
  if (selection) selection.active = false;
  selections.delete(element);
}

export async function setCallSpeaker(element: HTMLMediaElement, deviceId: string): Promise<void> {
  if (typeof element.setSinkId !== 'function') {
    if (!deviceId) return;
    throw new Error('Audio output selection is unavailable in this browser');
  }
  let selection = selections.get(element);
  if (!selection) {
    selection = {
      revision: 0,
      target: '',
      confirmed: element.sinkId ?? '',
      active: true,
      queue: Promise.resolve(),
      repairs: 0,
    };
    selections.set(element, selection);
  }
  const state = selection;
  const revision = ++state.revision;
  state.target = deviceId;
  state.repairs = 0;
  const stream = element.srcObject;
  const current = () => state.active && selections.get(element) === state;
  const switchOutput = async (target: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const switching = element.setSinkId(target);
    const repair = () => {
      if (
        !current() ||
        element.srcObject !== stream ||
        element.sinkId === state.target ||
        state.repairs >= 1
      )
        return;
      state.repairs++;
      // Also serialized behind a newer selection already in flight.
      state.queue = state.queue
        .then(async () => {
          if (current() && element.srcObject === stream) await switchOutput(state.target);
        })
        .catch(() => {});
    };
    void switching.then(
      () => {
        if (timedOut) repair();
      },
      () => {},
    );
    try {
      await Promise.race([
        switching,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new DOMException('Audio output switch timed out', 'TimeoutError'));
          }, 5000);
        }),
      ]);
    } catch (cause) {
      if (
        current() &&
        element.srcObject === stream &&
        stream &&
        cause instanceof Error &&
        cause.name === 'AbortError'
      ) {
        const playing = !element.paused;
        element.srcObject = null;
        element.srcObject = stream;
        if (playing) void element.play().catch(() => {});
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
  const result = state.queue.then(async () => {
    if (!current() || state.revision !== revision) return;
    try {
      if (element.sinkId !== deviceId) await switchOutput(deviceId);
      if (current() && state.revision === revision) state.confirmed = deviceId;
    } catch (cause) {
      if (!current() || state.revision !== revision) return;
      state.target = state.confirmed;
      throw cause;
    }
  });
  state.queue = result.catch(() => {});
  await result;
}

// A live transport is insufficient evidence of audible playback. Recover only
// when packets continue arriving but a playing MediaStream's clock has stopped.
// Two attempts per attached stream bound churn; normal silence/mute is excluded.
export function watchCallStreamPlayback(
  element: HTMLMediaElement,
  received: () => number,
  resume: () => Promise<void>,
): () => void {
  let count = received(),
    time = element.currentTime,
    stalledAt: number | undefined;
  let attempts = 0,
    closed = false,
    pending = false;
  const stream = element.srcObject;
  const timer = setInterval(() => {
    const nextCount = received(),
      nextTime = element.currentTime;
    const eligible =
      stream &&
      element.srcObject === stream &&
      !element.paused &&
      !element.muted &&
      element.readyState >= 2 &&
      document.visibilityState === 'visible' &&
      nextCount > count;
    count = nextCount;
    if (!eligible || nextTime > time) stalledAt = undefined;
    else stalledAt ??= performance.now();
    time = nextTime;
    if (pending || attempts >= 2 || stalledAt === undefined || performance.now() - stalledAt < 3000)
      return;
    attempts++;
    stalledAt = undefined;
    pending = true;
    element.srcObject = null;
    element.srcObject = stream;
    void resume()
      .catch(() => {})
      .finally(() => {
        if (!closed) pending = false;
      });
  }, 1000);
  return () => {
    closed = true;
    clearInterval(timer);
  };
}
