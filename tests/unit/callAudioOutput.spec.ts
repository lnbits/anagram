import { afterEach, expect, it, vi } from 'vitest';
import {
  setCallSpeaker,
  releaseCallSpeaker,
  watchCallStreamPlayback,
} from '#src/services/callAudioOutput.ts';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function media() {
  const element = {
    sinkId: '',
    srcObject: {} as MediaStream,
    paused: false,
    muted: false,
    readyState: 4,
    currentTime: 0,
    play: vi.fn(async () => {}),
    setSinkId: vi.fn(async (id: string) => {
      element.sinkId = id;
    }),
  };
  return element as unknown as HTMLMediaElement & typeof element;
}
it('serializes changes and repairs a late timed-out switch to the latest selection', async () => {
  vi.useFakeTimers();
  const element = media(),
    first = deferred();
  element.setSinkId.mockImplementationOnce(async (id) => {
    await first.promise;
    element.sinkId = id;
  });
  const old = setCallSpeaker(element, 'old');
  await Promise.resolve();
  const latest = setCallSpeaker(element, 'latest');
  await vi.advanceTimersByTimeAsync(5001);
  await Promise.all([old, latest]); // Superseded failures do not report against the latest choice.
  expect(element.sinkId).toBe('latest');
  first.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(element.sinkId).toBe('latest');
  expect(element.setSinkId.mock.calls.map(([id]) => id)).toEqual(['old', 'latest', 'latest']);
  releaseCallSpeaker(element);
  expect(vi.getTimerCount()).toBe(0);
});
it('does not resurrect a detached stream after a timed-out device change', async () => {
  vi.useFakeTimers();
  const element = media(),
    first = deferred();
  element.setSinkId.mockImplementationOnce(async (id) => {
    await first.promise;
    element.sinkId = id;
  });
  const switching = setCallSpeaker(element, 'headset');
  const result = expect(switching).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(5001);
  await result;
  releaseCallSpeaker(element);
  element.srcObject = null;
  first.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(element.setSinkId).toHaveBeenCalledTimes(1);
  expect(element.srcObject).toBeNull();
});
it('rebinds the same stream on AbortError but leaves a paused player paused', async () => {
  const element = media(),
    stream = element.srcObject;
  element.paused = true;
  element.setSinkId.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
  await expect(setCallSpeaker(element, 'headset')).rejects.toMatchObject({ name: 'AbortError' });
  expect(element.srcObject).toBe(stream);
  expect(element.play).not.toHaveBeenCalled();
  releaseCallSpeaker(element);
});
it('bounds silent-playback recovery and excludes mute, absent packets and paused playback', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible' });
  const element = media();
  let packets = 0;
  const stop = watchCallStreamPlayback(element, () => packets, element.play);
  const tick = async (arriving = true) => {
    if (arriving) packets++;
    await vi.advanceTimersByTimeAsync(1000);
  };
  for (let i = 0; i < 6; i++) await tick(false);
  element.muted = true;
  for (let i = 0; i < 6; i++) await tick();
  element.muted = false;
  element.paused = true;
  for (let i = 0; i < 6; i++) await tick();
  element.paused = false;
  expect(element.play).not.toHaveBeenCalled();
  for (let i = 0; i < 20; i++) await tick();
  expect(element.play).toHaveBeenCalledTimes(2);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
