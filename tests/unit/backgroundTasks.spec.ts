import {
  scheduleBackgroundTask,
  yieldToMainThread,
  yieldToNextPaint,
} from 'src/utils/backgroundTasks';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('backgroundTasks', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    Reflect.deleteProperty(globalThis, 'scheduler');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts work after yielding the current interaction turn', async () => {
    vi.useFakeTimers();
    const task = vi.fn();

    scheduleBackgroundTask('deferred-task', task);

    expect(task).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('uses background browser priority when task scheduling is available', async () => {
    const task = vi.fn();
    const postTask = vi.fn(
      async (callback: () => void | Promise<void>, options: Record<string, unknown>) => {
        expect(options).toMatchObject({ delay: 25, priority: 'background' });
        await callback();
      }
    );
    Object.defineProperty(globalThis, 'scheduler', {
      configurable: true,
      value: { postTask },
    });

    scheduleBackgroundTask('prioritized-task', task, { delayMs: 25 });
    await Promise.resolve();
    await Promise.resolve();

    expect(postTask).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('falls back to a timer when background scheduling is unavailable at runtime', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    Object.defineProperty(globalThis, 'scheduler', {
      configurable: true,
      value: {
        postTask: vi.fn(() => {
          throw new TypeError('Unsupported task options');
        }),
      },
    });

    scheduleBackgroundTask('fallback-task', task);
    await vi.runAllTimersAsync();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancels older scheduled work with the same key', async () => {
    vi.useFakeTimers();
    const firstTask = vi.fn();
    const latestTask = vi.fn();

    scheduleBackgroundTask('latest-task', firstTask, { delayMs: 20 });
    scheduleBackgroundTask('latest-task', latestTask, { delayMs: 20 });

    await vi.runAllTimersAsync();
    expect(firstTask).not.toHaveBeenCalled();
    expect(latestTask).toHaveBeenCalledTimes(1);
  });

  it('suppresses errors from cancelled running work', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let rejectTask!: (error: unknown) => void;
    const taskPromise = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });

    const cancel = scheduleBackgroundTask('cancelled-task', () => taskPromise, { onError });
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    rejectTask(new Error('cancelled'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it('yields through the platform scheduler when available', async () => {
    const schedulerYield = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'scheduler', {
      configurable: true,
      value: { yield: schedulerYield },
    });

    await yieldToMainThread();

    expect(schedulerYield).toHaveBeenCalledTimes(1);
  });

  it('allows a visible UI frame to paint before continuing work', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'visible' },
    });
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      globalThis.setTimeout(() => callback(0), 0);
      return 1;
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: requestAnimationFrame,
    });

    const paintYield = yieldToNextPaint();
    await vi.runAllTimersAsync();
    await paintYield;

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
