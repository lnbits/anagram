import {
  callCaptureErrorKey,
  callMediaSupported,
  createCallMediaReceiver,
  getCallCamera,
  getCallMedia,
  getCallMicrophone,
  recordCallMedia,
} from '#src/services/callMediaService.ts';
import {
  primeCallAudio,
  registerCallAudio,
  setCallSpeaker,
} from '#src/services/callPlaybackService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
const platform = vi.hoisted(() => ({ ios: false, native: false }));
vi.mock('#src/lib/platform/ios.ts', () => ({ isIosNative: () => platform.ios }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => platform.native }));

afterEach(() => {
  platform.ios = false;
  platform.native = false;
  registerCallAudio(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('call devices and playback', () => {
  it('checks browser capabilities, not cached microphone permission state', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    const query = vi.fn().mockRejectedValue(new Error('Permissions API unavailable'));
    vi.stubGlobal('navigator', { permissions: { query }, mediaDevices: { getUserMedia: vi.fn() } });
    expect(callMediaSupported('audio')).toBe(true);
    expect(callMediaSupported('video')).toBe(true);
    expect(query).not.toHaveBeenCalled();
    vi.stubGlobal('isSecureContext', false);
    expect(callMediaSupported('audio')).toBe(false);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('WebAssembly', undefined);
    expect(callMediaSupported('audio')).toBe(false);
  });
  it('does not imply permission denial when the device is busy or absent', () => {
    expect(callCaptureErrorKey(new DOMException('Denied', 'NotAllowedError'))).toBe(
      'call.error.permission',
    );
    expect(callCaptureErrorKey(new DOMException('Busy', 'NotReadableError'))).toBe(
      'call.error.deviceBusy',
    );
    expect(callCaptureErrorKey(new DOMException('Missing', 'NotFoundError'))).toBe(
      'call.error.deviceMissing',
    );
    expect(callCaptureErrorKey(new Error('Unexpected'))).toBe('call.error.capture');
  });
  it('supports iPhone managed playback only when recording and playback codecs both exist', () => {
    platform.ios = true;
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('MediaSource', undefined);
    const recorder = vi.fn(() => true);
    const player = vi.fn(() => true);
    vi.stubGlobal('MediaRecorder', { isTypeSupported: recorder });
    vi.stubGlobal('ManagedMediaSource', { isTypeSupported: player });
    expect(callMediaSupported('audio')).toBe(true);
    expect(callMediaSupported('video')).toBe(true);
    platform.ios = false;
    expect(callMediaSupported('audio')).toBe(false);
    expect(() => createCallMediaReceiver('audio/webm;codecs=opus', vi.fn())).toThrow('unavailable');
    platform.ios = true;
    player.mockImplementation((mime?: string) => !mime?.startsWith('video/'));
    expect(callMediaSupported('audio')).toBe(true);
    expect(callMediaSupported('video')).toBe(false);
    // Older iOS can have managed playback without the required WebM encoder.
    recorder.mockReturnValue(false);
    expect(callMediaSupported('audio')).toBe(false);
    recorder.mockReturnValue(true);
    vi.stubGlobal('ManagedMediaSource', undefined);
    expect(callMediaSupported('audio')).toBe(false);
    expect(() => createCallMediaReceiver('audio/webm;codecs=opus', vi.fn())).toThrow('unavailable');
  });
  it('keeps the standard playback path on browsers exposing both APIs', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    const managed = vi.fn();
    vi.stubGlobal('ManagedMediaSource', { isTypeSupported: managed });
    expect(callMediaSupported('video')).toBe(true);
    expect(managed).not.toHaveBeenCalled();
  });
  it('selects an exact microphone without requesting camera access', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await getCallMicrophone('mic-2');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic-2' },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  });
  it('falls back from a disconnected microphone preference when starting a new call', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Removed microphone', 'NotFoundError'))
      .mockResolvedValue({});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await getCallMedia('audio', 'removed-device');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]?.[0].audio.deviceId).toBeUndefined();
  });
  it.each(['width', 'height', 'frameRate', 'facingMode'])(
    'keeps the selected camera when its preferred %s is unsupported',
    async (constraint) => {
      const stream = {};
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce({
          name: 'OverconstrainedError',
          constraint,
        })
        .mockResolvedValue(stream);
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
      await expect(getCallCamera('colour-camera')).resolves.toBe(stream);
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(getUserMedia.mock.calls[1]?.[0]).toEqual({
        audio: false,
        video: { deviceId: { exact: 'colour-camera' } },
      });
    },
  );
  it('keeps microphone processing and selection when starting video with native camera modes', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new DOMException('Unsupported size', 'OverconstrainedError'), {
          constraint: 'width',
        }),
      )
      .mockResolvedValue({});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await getCallMedia('video', 'mic-2');
    expect(getUserMedia.mock.calls[1]?.[0]).toEqual({
      audio: getUserMedia.mock.calls[0]?.[0].audio,
      video: true,
    });
    expect(getUserMedia.mock.calls[1]?.[0].audio.deviceId).toEqual({ exact: 'mic-2' });
  });
  it.each(['deviceId', 'echoCancellation', ''])(
    'does not hide rejected %s constraints',
    async (constraint) => {
      const error = Object.assign(new DOMException('Rejected', 'OverconstrainedError'), {
        constraint,
      });
      const getUserMedia = vi.fn().mockRejectedValue(error);
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
      await expect(getCallCamera('missing-camera')).rejects.toBe(error);
      expect(getUserMedia).toHaveBeenCalledOnce();
    },
  );
  it.each(['NotAllowedError', 'NotReadableError', 'NotFoundError'])(
    'does not retry a camera %s',
    async (name) => {
      const error = new DOMException('Capture failed', name);
      const getUserMedia = vi.fn().mockRejectedValue(error);
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
      await expect(getCallCamera('camera')).rejects.toBe(error);
      expect(getUserMedia).toHaveBeenCalledOnce();
    },
  );
  it('primes the persistent audio element without treating autoplay denial as input denial', async () => {
    const element = {
      src: '',
      muted: true,
      play: vi.fn().mockRejectedValue(new DOMException('Autoplay', 'NotAllowedError')),
    } as unknown as HTMLAudioElement;
    registerCallAudio(element);
    primeCallAudio();
    await Promise.resolve();
    expect(element.play).toHaveBeenCalledOnce();
    expect(element.src).toMatch(/^data:audio\/wav/);
    expect(element.muted).toBe(false);
    element.src = 'blob:live-call';
    primeCallAudio();
    expect(element.play).toHaveBeenCalledOnce();
  });
  it('uses the system speaker where output selection is unavailable and preserves failures', async () => {
    const element = {} as HTMLMediaElement;
    await expect(setCallSpeaker(element, '')).resolves.toBeUndefined();
    await expect(setCallSpeaker(element, 'headset')).rejects.toThrow('unavailable');
    element.setSinkId = vi.fn().mockResolvedValue(undefined);
    await setCallSpeaker(element, 'headset');
    expect(element.setSinkId).toHaveBeenCalledWith('headset');
    vi.mocked(element.setSinkId).mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await expect(setCallSpeaker(element, 'denied')).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });
});

describe('continuous media buffering', () => {
  it.each(['MediaSource', 'ManagedMediaSource'])('bounds buffering and cleans up %s', (api) => {
    class Buffer extends EventTarget {
      updating = false;
      buffered = { length: 1, start: () => 0, end: () => 20 };
      appendBuffer = vi.fn();
      remove = vi.fn(() => {
        this.dispatchEvent(new Event('updateend'));
      });
    }
    const buffer = new Buffer();
    class Source extends EventTarget {
      static current: Source;
      duration = 0;
      constructor() {
        super();
        Source.current = this;
      }
      addSourceBuffer() {
        return buffer;
      }
    }
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal(api, Source);
    platform.ios = api === 'ManagedMediaSource';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const failure = vi.fn();
    const receiver = createCallMediaReceiver('audio/webm;codecs=opus', failure);
    receiver.append(new Uint8Array([1, 2]));
    Source.current.dispatchEvent(new Event('sourceopen'));
    expect(buffer.remove).toHaveBeenCalledTimes(1);
    expect(buffer.appendBuffer).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    buffer.dispatchEvent(new Event('updateend'));
    expect(buffer.remove).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    receiver.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media');
  });
  it('cancels an old recorder chunk awaiting conversion before a microphone reset', async () => {
    class Recorder {
      static current: Recorder;
      state = 'inactive';
      ondataavailable:
        ((event: { data: { size: number; arrayBuffer(): Promise<ArrayBuffer> } }) => void) | null =
        null;
      onerror: (() => void) | null = null;
      constructor() {
        Recorder.current = this;
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    let complete: (value: ArrayBuffer) => void = () => {};
    const send = vi.fn().mockResolvedValue(undefined);
    const stop = recordCallMedia({} as MediaStream, 'audio/webm;codecs=opus', send, vi.fn());
    Recorder.current.ondataavailable?.({
      data: {
        size: 2,
        arrayBuffer: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      },
    });
    await Promise.resolve();
    stop();
    complete(new ArrayBuffer(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(Recorder.current.state).toBe('inactive');
  });
});

it.each(['audio/webm;codecs=opus', 'video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus'])(
  'keeps ordered %s flowing when a send takes longer than the recording cadence',
  async (mime) => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    class Recorder {
      static current: Recorder;
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      constructor() {
        Recorder.current = this;
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    const delivered: number[] = [];
    let sending = 0,
      peakSending = 0;
    const failure = vi.fn(),
      congestion = vi.fn();
    const send = vi.fn(async (frame: Uint8Array) => {
      peakSending = Math.max(peakSending, ++sending);
      await new Promise((resolve) => setTimeout(resolve, 200));
      delivered.push(...frame.subarray(1));
      sending--;
    });
    const stop = recordCallMedia({} as MediaStream, mime, send, failure, {
      onCongestion: congestion,
    });
    for (let i = 0; i < 50; i++) {
      Recorder.current.ondataavailable?.({ data: new Blob([new Uint8Array([i])]) });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(congestion).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(delivered).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(peakSending).toBe(1);
    expect(send.mock.calls.length).toBeLessThan(30);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('stops a congested video recorder by queue age without dropping chunks or ending audio', async () => {
  vi.useFakeTimers();
  class Recorder {
    static current: Recorder;
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      Recorder.current = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
    }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const congestion = vi.fn(),
    failure = vi.fn();
  const send = vi.fn(() => new Promise<void>(() => {}));
  const stop = recordCallMedia({} as MediaStream, 'video/webm;codecs=vp8', send, failure, {
    onCongestion: congestion,
  });
  try {
    Recorder.current.ondataavailable?.({
      data: { size: 2, arrayBuffer: async () => new ArrayBuffer(2) } as Blob,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledOnce();
    now = 1600;
    await vi.advanceTimersByTimeAsync(250);
    expect(congestion).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(Recorder.current.state).toBe('inactive');
    await vi.advanceTimersByTimeAsync(5000);
    expect(congestion).toHaveBeenCalledOnce();
  } finally {
    stop();
    vi.useRealTimers();
  }
});

it.each([
  { native: true, agent: 'Linux x86_64', mime: 'video/webm;codecs=vp8', renews: true },
  {
    native: true,
    agent: 'Linux x86_64',
    mime: 'video/webm;codecs=vp8',
    renews: false,
    reset: false,
  },
  { native: true, agent: 'Linux; Android 15', mime: 'video/webm;codecs=vp8', renews: false },
  { native: false, agent: 'Linux x86_64', mime: 'video/webm;codecs=vp8', renews: false },
  { native: true, agent: 'Linux x86_64', mime: 'audio/webm;codecs=opus', renews: false },
  { native: true, agent: 'Linux x86_64', mime: 'video/webm;codecs=vp8,opus', renews: false },
])(
  'renews only native Linux video-only recordings: $native $agent $mime',
  async ({ native, agent, mime, renews, reset = true }) => {
    vi.useFakeTimers();
    platform.native = native;
    vi.stubGlobal('navigator', { userAgent: agent });
    class Recorder {
      static current: Recorder;
      static created = 0;
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      start = vi.fn(() => {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) });
      });
      stop = vi.fn(() => {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([2])]) });
        this.onstop?.();
      });
      constructor() {
        Recorder.current = this;
        Recorder.created++;
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    const sent: (number | string)[] = [];
    const failure = vi.fn();
    const stop = recordCallMedia(
      {} as MediaStream,
      mime,
      async (bytes) => {
        sent.push(...bytes.subarray(1));
      },
      failure,
      reset
        ? {
            onStreamRestart: async () => {
              sent.push('reset');
            },
          }
        : undefined,
    );
    await vi.advanceTimersByTimeAsync(4100);
    expect(Recorder.created).toBe(renews ? 2 : 1);
    expect(Recorder.current.start).toHaveBeenCalledOnce();
    for (const args of Recorder.current.start.mock.calls)
      expect(args).toEqual([mime === 'audio/webm;codecs=opus' ? 50 : 100]);
    // Reset the receiver before delivering a fresh WebM initialization header.
    expect(sent).toEqual(renews ? [1, 'reset', 1] : [1]);
    expect(vi.getTimerCount()).toBe(renews ? 1 : 0);
    stop();
    await vi.advanceTimersByTimeAsync(8000);
    expect(Recorder.created).toBe(renews ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(failure).not.toHaveBeenCalled();
  },
);

it('stops renewal and congestion timers if the native video encoder cannot restart', async () => {
  vi.useFakeTimers();
  platform.native = true;
  vi.stubGlobal('navigator', { userAgent: 'Linux x86_64' });
  let starts = 0;
  class Recorder {
    state = 'inactive';
    onstop: (() => void) | null = null;
    start = vi.fn(() => {
      if (++starts > 1) throw new Error('Encoder unavailable');
      this.state = 'recording';
    });
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const failure = vi.fn();
  const congestion = vi.fn();
  const stop = recordCallMedia(
    {} as MediaStream,
    'video/webm;codecs=vp8',
    async () => {},
    failure,
    {
      onCongestion: congestion,
      onStreamRestart: async () => {},
    },
  );
  await vi.advanceTimersByTimeAsync(4100);
  expect(failure).toHaveBeenCalledOnce();
  expect(congestion).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  stop();
  await vi.advanceTimersByTimeAsync(8000);
  expect(failure).toHaveBeenCalledOnce();
});
