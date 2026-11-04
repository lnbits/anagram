import { followCallLive, watchCallLive } from '#src/services/callPlaybackService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

function media(currentTime: number, ranges: number[][], seeking = false) {
  const seek = vi.fn((time: number) => {
    currentTime = time;
  });
  const element = {
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index][0],
      end: (index: number) => ranges[index][1],
    },
    seeking,
    playbackRate: 1,
    get currentTime() {
      return currentTime;
    },
    set currentTime(time: number) {
      seek(time);
    },
  } as HTMLMediaElement;
  return { element, seek };
}

describe('live call playback recovery', () => {
  it('waits for playback to resume before catching up a paused stream', () => {
    vi.useFakeTimers();
    const ranges = [[0, 10]];
    const { element, seek } = media(9.5, ranges);
    Object.defineProperty(element, 'paused', { value: true, writable: true });
    const stop = watchCallLive(element, 'audio');
    for (let i = 0; i < 8; i++) {
      ranges[0][1] += 0.25;
      followCallLive(element, 'audio');
      vi.advanceTimersByTime(250);
    }
    expect(seek).not.toHaveBeenCalled();
    Object.defineProperty(element, 'paused', { value: false });
    vi.advanceTimersByTime(250);
    expect(seek).toHaveBeenCalledExactlyOnceWith(11.8);
    stop();
  });

  it('drains modest audio backlog without seeking or changing video policy', () => {
    const audio = media(9.5, [[0, 10]]);
    const video = media(9.5, [[0, 10]]);
    followCallLive(audio.element, 'audio');
    followCallLive(video.element);
    expect(audio.element.playbackRate).toBe(1.1);
    expect(audio.seek).not.toHaveBeenCalled();
    expect(video.element.playbackRate).toBe(1);
    expect(video.seek).not.toHaveBeenCalled();
    // Keep draining through the hysteresis band, then restore normal speed.
    audio.element.currentTime = 9.7;
    followCallLive(audio.element, 'audio');
    expect(audio.element.playbackRate).toBe(1.1);
    audio.element.currentTime = 9.8;
    followCallLive(audio.element, 'audio');
    expect(audio.element.playbackRate).toBe(1);
    audio.element.currentTime = 9.7;
    followCallLive(audio.element, 'audio');
    expect(audio.element.playbackRate).toBe(1);
  });

  it('seeks a large audio backlog immediately and restores normal speed', () => {
    const ranges = [[0, 10]];
    const { element, seek } = media(9.5, ranges);
    followCallLive(element, 'audio');
    expect(element.playbackRate).toBe(1.1);
    ranges[0][1] = 12;
    followCallLive(element, 'audio');
    expect(seek).toHaveBeenCalledExactlyOnceWith(11.8);
    expect(element.playbackRate).toBe(1);
    followCallLive(element, 'audio');
    expect(seek).toHaveBeenCalledOnce();
  });

  it('preserves sub-second audio bursts without seeking', () => {
    const { element, seek } = media(9, [[0, 10]]);
    for (let i = 0; i < 20; i++) followCallLive(element, 'audio');
    expect(seek).not.toHaveBeenCalled();
    expect(element.playbackRate).toBe(1.1);
  });

  it('drains a sub-threshold audio backlog over several seconds without a seek', () => {
    vi.useFakeTimers();
    const ranges = [[0, 10]];
    const { element, seek } = media(9.3, ranges);
    const stop = watchCallLive(element, 'audio');
    const advance = (steps: number) => {
      for (let i = 0; i < steps; i++) {
        ranges[0][1] += 0.1;
        element.currentTime += 0.1 * element.playbackRate;
        seek.mockClear(); // The assignment above models the playback clock.
        vi.advanceTimersByTime(100);
        expect(seek).not.toHaveBeenCalled();
      }
    };
    advance(10);
    expect(ranges[0][1] - element.currentTime).toBeGreaterThan(0.45);
    advance(50);
    expect(ranges[0][1] - element.currentTime).toBeLessThanOrEqual(0.25);
    expect(element.playbackRate).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores normal audio speed on pause, seek, buffer loss and detach', () => {
    vi.useFakeTimers();
    for (const reason of ['pause', 'seek', 'empty', 'detach']) {
      const { element } = media(9.5, [[0, 10]]);
      const stop = watchCallLive(element, 'audio');
      vi.advanceTimersByTime(250);
      expect(element.playbackRate).toBe(1.1);
      if (reason === 'detach') stop();
      else {
        if (reason === 'pause') Object.defineProperty(element, 'paused', { value: true });
        if (reason === 'seek') Object.defineProperty(element, 'seeking', { value: true });
        if (reason === 'empty') Object.defineProperty(element.buffered, 'length', { value: 0 });
        followCallLive(element, 'audio');
      }
      expect(element.playbackRate).toBe(1);
      stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the audio cushion on stalled-event recovery and preserves seek/gap guards', () => {
    vi.useFakeTimers();
    const { element } = media(8, [[0, 10]]);
    const stop = watchCallLive(element, 'audio');
    vi.advanceTimersByTime(250);
    expect(element.currentTime).toBeCloseTo(9.8);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    const seeking = media(8, [[0, 10]], true);
    followCallLive(seeking.element, 'audio');
    expect(seeking.seek).not.toHaveBeenCalled();
    const gap = media(9.7, [
      [0, 9.8],
      [9.9, 10],
    ]);
    followCallLive(gap.element, 'audio');
    expect(gap.seek).not.toHaveBeenCalled(); // Speech remains in the earlier range.
    gap.element.currentTime = 9.8;
    gap.seek.mockClear();
    followCallLive(gap.element, 'audio');
    expect(gap.seek).toHaveBeenCalledExactlyOnceWith(9.9);
  });

  it('recovers without browser progress events and stops work when detached', () => {
    vi.useFakeTimers();
    const ranges = [[0, 1]];
    const { element, seek } = media(0.8, ranges);
    const stop = watchCallLive(element);
    vi.advanceTimersByTime(1000);
    expect(seek).not.toHaveBeenCalled();
    ranges[0][1] = 3;
    vi.advanceTimersByTime(250);
    expect(element.currentTime).toBeCloseTo(2.65);
    vi.advanceTimersByTime(1000);
    expect(seek).toHaveBeenCalledTimes(1);
    stop();
    ranges[0][1] = 5;
    vi.advanceTimersByTime(1000);
    expect(seek).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for buffered media, including streams that have not started', () => {
    const { element, seek } = media(0, []);
    followCallLive(null);
    followCallLive(element);
    expect(seek).not.toHaveBeenCalled();
  });

  it('allows normal chunk jitter without repeatedly seeking', () => {
    const { element, seek } = media(9.5, [[0, 10]]);
    for (let i = 0; i < 10; i++) followCallLive(element);
    expect(seek).not.toHaveBeenCalled();
  });

  it('recovers a sub-second backlog once and retains a playback cushion', () => {
    const { element, seek } = media(9, [[0, 10]]);
    followCallLive(element);
    expect(element.currentTime).toBeCloseTo(9.65);
    for (let i = 0; i < 10; i++) followCallLive(element);
    expect(seek).toHaveBeenCalledTimes(1);
  });

  it('lets an in-flight seek finish before correcting further drift', () => {
    const { element, seek } = media(8, [[0, 10]], true);
    followCallLive(element);
    expect(seek).not.toHaveBeenCalled();
  });

  it('seeks into the latest playable range rather than a gap', () => {
    const { element, seek } = media(5, [
      [0, 6],
      [9.9, 10],
    ]);
    followCallLive(element);
    expect(seek).toHaveBeenCalledWith(9.9);
  });
});
