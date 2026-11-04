import { expect, test } from '@playwright/test';

for (const { capture, bounded } of [
  { capture: 'automatic', bounded: false },
  { capture: 'video-element', bounded: false },
  { capture: 'automatic', bounded: true },
  { capture: 'video-element', bounded: true },
]) {
  test(`packet video (${capture}, ${bounded ? 'group limits' : 'direct defaults'}) preserves camera shape through startup and orientation changes`, async ({
    page,
  }) => {
    await page.route('**/__packet-video-aspect', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
    );
    await page.goto('/__packet-video-aspect');
    await page.getByRole('button').click();
    const result = await page.evaluate(
      async ({ capture, bounded }) => {
        if (capture === 'video-element')
          Object.defineProperty(window, 'MediaStreamTrackProcessor', {
            configurable: true,
            value: undefined,
          });
        const { callPacketVideoSupported, recordPacketVideo, createPacketVideoReceiver } =
          await import('/src/services/callPacketVideo.ts');
        const { attachCallMedia } = await import('/src/services/callStreamRegistry.ts');
        if (!(await callPacketVideoSupported())) return { supported: false };
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const paint = canvas.getContext('2d')!;
        const draw = () => {
          paint.fillStyle = '#000';
          paint.fillRect(0, 0, canvas.width, canvas.height);
          const size = Math.min(canvas.width, canvas.height) / 3;
          paint.fillStyle = '#fff';
          paint.fillRect((canvas.width - size) / 2, (canvas.height - size) / 2, size, size);
        };
        draw();
        const drawing = setInterval(draw, 40);
        const stream = canvas.captureStream(24);
        // Some cameras report no dimensions until their first frame arrives.
        stream.getVideoTracks()[0].getSettings = () => ({});
        const errors: string[] = [];
        const receiver = createPacketVideoReceiver(() => errors.push('decode'));
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        document.body.append(video);
        attachCallMedia(video, receiver.url);
        const stop = recordPacketVideo(
          stream,
          async (packet) => receiver.append(packet.subarray(1)),
          () => errors.push('encode'),
          bounded ? { videoMaxWidth: 640, videoMaxHeight: 360 } : undefined,
        );
        void video.play();
        const frames: Array<{ width: number; height: number; squareRatio: number }> = [];
        try {
          for (const [width, height, outputWidth, outputHeight] of [
            [640, 480, bounded ? 480 : 640, bounded ? 360 : 480],
            [360, 640, bounded ? 202 : 360, bounded ? 360 : 640],
            [1280, 720, bounded ? 640 : 1280, bounded ? 360 : 720],
          ]) {
            canvas.width = width;
            canvas.height = height;
            draw();
            const deadline = performance.now() + 5000;
            while (
              (video.readyState < 2 ||
                video.videoWidth !== outputWidth ||
                video.videoHeight !== outputHeight) &&
              !errors.length &&
              performance.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 50));
            const sample = document.createElement('canvas');
            sample.width = video.videoWidth || 1;
            sample.height = video.videoHeight || 1;
            const pixels = sample.getContext('2d')!;
            if (video.readyState >= 2) pixels.drawImage(video, 0, 0);
            const data = pixels.getImageData(0, 0, sample.width, sample.height).data;
            let left = sample.width,
              right = -1,
              top = sample.height,
              bottom = -1;
            for (let y = 0; y < sample.height; y++) {
              for (let x = 0; x < sample.width; x++) {
                if (data[(y * sample.width + x) * 4] < 200) continue;
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
            }
            frames.push({
              width: video.videoWidth,
              height: video.videoHeight,
              squareRatio: (right - left + 1) / (bottom - top + 1),
            });
          }
          return { supported: true, errors, frames };
        } finally {
          stop();
          receiver.close();
          clearInterval(drawing);
          stream.getTracks().forEach((track) => track.stop());
          video.srcObject = null;
          video.remove();
        }
      },
      { capture, bounded },
    );
    test.skip(!result.supported, 'No packet video codec in this engine');
    expect(result.errors).toEqual([]);
    expect(result.frames?.map(({ width, height }) => [width, height])).toEqual(
      bounded
        ? [
            [480, 360],
            [202, 360],
            [640, 360],
          ]
        : [
            [640, 480],
            [360, 640],
            [1280, 720],
          ],
    );
    for (const frame of result.frames!) expect(frame.squareRatio).toBeCloseTo(1, 1);
  });
}

for (const capture of [
  'automatic',
  'automatic-presentation',
  'video-element',
  'video-element-restart',
  'overloaded-decoder',
  'all-congested',
] as const) {
  test(`shared packet video (${capture}) keeps a fast peer moving while a second peer is congested`, async ({
    page,
  }, info) => {
    await page.route('**/__packet-video', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
    );
    await page.goto('/__packet-video');
    await page.getByRole('button').click();
    const result = await page.evaluate(async (capture) => {
      if (capture === 'video-element' || capture === 'video-element-restart')
        Object.defineProperty(window, 'MediaStreamTrackProcessor', {
          configurable: true,
          value: undefined,
        });
      const { callPacketVideoSupported, recordPacketVideo, createPacketVideoReceiver } =
        await import('/src/services/callPacketVideo.ts');
      const { cloneCallTrack } = await import('/src/services/callSharedCapture.ts');
      const { attachCallMedia } = await import('/src/services/callStreamRegistry.ts');
      if (!(await callPacketVideoSupported()))
        return {
          supported: false,
          encoder: typeof VideoEncoder,
          decoder: typeof VideoDecoder,
          frame: typeof VideoFrame,
        };
      const captureCanvas = HTMLCanvasElement.prototype.captureStream;
      if (capture === 'automatic-presentation')
        HTMLCanvasElement.prototype.captureStream = function (rate) {
          const stream = captureCanvas.call(this, rate);
          for (const track of stream.getVideoTracks())
            Object.defineProperty(track, 'requestFrame', { value: undefined });
          return stream;
        };
      let restrictCapturePlayback = false;
      const authorizedPlayers = new WeakSet<HTMLMediaElement>();
      const play = HTMLMediaElement.prototype.play;
      if (capture === 'video-element-restart')
        HTMLMediaElement.prototype.play = function () {
          if (
            restrictCapturePlayback &&
            this.matches('video[aria-hidden]') &&
            !authorizedPlayers.has(this)
          )
            return Promise.reject(
              new DOMException('New capture player requires a gesture', 'NotAllowedError'),
            );
          return play.call(this).then(() => {
            authorizedPlayers.add(this);
          });
        };
      const OriginalDecoder = VideoDecoder;
      const overloadDrops: number[] = [];
      if (capture === 'overloaded-decoder') {
        window.VideoDecoder = class extends OriginalDecoder {
          index = overloadDrops.push(0) - 1;
          get decodeQueueSize() {
            if (overloadDrops[this.index] < 8) {
              overloadDrops[this.index]++;
              return 3;
            }
            return super.decodeQueueSize;
          }
          reset() {
            throw new Error('An overloaded active decoder must drain without reset');
          }
        };
      }
      let observing = true;
      const bitrates: number[] = [];
      let created = 0,
        closed = 0,
        encoded = 0;
      const Original = VideoEncoder;
      window.VideoEncoder = class extends Original {
        configure(config: VideoEncoderConfig) {
          if (config.bitrate) bitrates.push(config.bitrate);
          super.configure(config);
        }
        constructor(init: VideoEncoderInit) {
          super(init);
          created++;
        }
        close() {
          closed++;
          super.close();
        }
        encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions) {
          encoded++;
          super.encode(frame, options);
        }
      };
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      document.body.append(canvas);
      const paint = canvas.getContext('2d')!;
      // Avoid a repeating colour period that aliases with the 350 ms delayed peer.
      let colour = 0;
      const drawing = setInterval(() => {
        colour = (colour + 0x9e3779) & 0xffffff;
        paint.fillStyle = `#${colour.toString(16).padStart(6, '0')}`;
        paint.fillRect(0, 0, 320, 180);
      }, 40);
      const source = canvas.captureStream(24);
      const errors: string[] = [],
        counts = [0, 0],
        pictureChanges = [0, 0],
        stops: (() => void)[] = [];
      const elements: HTMLVideoElement[] = [],
        receivers = [],
        clones: MediaStreamTrack[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const receiver = createPacketVideoReceiver(() => errors.push('decode'));
          receivers.push(receiver);
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          elements.push(video);
          document.body.append(video);
          attachCallMedia(video, receiver.url);
          const sample = document.createElement('canvas');
          sample.width = sample.height = 1;
          const pixels = sample.getContext('2d', { willReadFrequently: true })!;
          let previous = [0, 0, 0];
          const displayed = () => {
            pixels.drawImage(video, 0, 0, 1, 1);
            const current = pixels.getImageData(0, 0, 1, 1).data;
            if (
              previous.reduce((sum, value, index) => sum + Math.abs(value - current[index]), 0) > 32
            ) {
              pictureChanges[i]++;
              previous = [...current.subarray(0, 3)];
            }
            counts[i]++;
            if (observing) video.requestVideoFrameCallback(displayed);
          };
          video.requestVideoFrameCallback(displayed);
          const clone = cloneCallTrack(source.getVideoTracks()[0]);
          clones.push(clone);
          stops.push(
            recordPacketVideo(
              new MediaStream([clone]),
              async (packet) => {
                if (i || capture === 'all-congested')
                  await new Promise((resolve) => setTimeout(resolve, 350));
                receiver.append(packet.subarray(1));
              },
              () => errors.push('encode'),
            ),
          );
          void video.play();
        }
        if (capture === 'video-element-restart') {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const previous = stops.splice(0);
          previous.forEach((stop) => stop());
          restrictCapturePlayback = true;
          const before = [...pictureChanges];
          for (let i = 0; i < 2; i++) {
            stops.push(
              recordPacketVideo(
                new MediaStream([clones[i]]),
                async (packet) => {
                  receivers[i].append(packet.subarray(1));
                },
                () => errors.push('restart'),
              ),
            );
          }
          // Late cleanup of the previous link must not close the replacement encoder.
          previous.forEach((stop) => stop());
          await new Promise((resolve) => setTimeout(resolve, 2500));
          if (!pictureChanges.every((count, i) => count > before[i] + 2))
            errors.push('pictures did not resume');
        } else await new Promise((resolve) => setTimeout(resolve, 5000));
        const fastPeerFrames = counts[0];
        if (capture === 'overloaded-decoder') {
          // Eight deliberately dropped deliveries cost the 350 ms peer several
          // seconds. Allow recovery its own bounded window; keep the fast peer's
          // original five-second throughput requirement unchanged.
          const deadline = performance.now() + 3000;
          while (pictureChanges.some((count) => count <= 2) && performance.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          supported: true,
          counts,
          pictureChanges,
          fastPeerFrames,
          overloadDrops,
          errors,
          created,
          encoded,
          bitrates,
        };
      } finally {
        observing = false;
        HTMLCanvasElement.prototype.captureStream = captureCanvas;
        HTMLMediaElement.prototype.play = play;
        stops.forEach((stop) => stop());
        receivers.forEach((receiver) => receiver.close());
        elements.forEach((video) => {
          video.pause();
          video.srcObject = null;
        });
        clearInterval(drawing);
        [...source.getTracks(), ...clones].forEach((track) => track.stop());
        window.VideoEncoder = Original;
        window.VideoDecoder = OriginalDecoder;
        if (closed !== created) throw new Error('Video encoder leak');
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (document.querySelector('video[aria-hidden]')) throw new Error('Video capture leak');
      }
    }, capture);
    console.log('[packet video]', JSON.stringify(result));
    test.skip(!result.supported, 'This engine uses the tested legacy WebM video fallback');
    await info.attach('packet-video.json', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
    expect(result.errors).toEqual([]);
    expect(result.created).toBe(capture === 'video-element-restart' ? 2 : 1);
    if (capture !== 'all-congested') expect(Math.min(...result.bitrates!)).toBe(600000);
    expect(result.fastPeerFrames).toBeGreaterThan(capture === 'all-congested' ? 2 : 30);
    expect(result.counts![1]).toBeGreaterThan(2);
    expect(result.pictureChanges!.every((count) => count > 2)).toBe(true);
    if (capture === 'overloaded-decoder') expect(result.overloadDrops).toEqual([8, 8]);
    if (capture === 'all-congested') expect(result.encoded).toBeLessThan(30);
  });
}

for (const capture of ['automatic', 'video-element'] as const) {
  test(`packet video (${capture}) releases capture if encoder setup fails`, async ({ page }) => {
    await page.route('**/__packet-video-failure', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
    );
    await page.goto('/__packet-video-failure');
    const result = await page.evaluate(async (capture) => {
      if (capture === 'video-element')
        Object.defineProperty(window, 'MediaStreamTrackProcessor', {
          configurable: true,
          value: undefined,
        });
      const { callPacketVideoSupported, recordPacketVideo } =
        await import('/src/services/callPacketVideo.ts');
      if (!(await callPacketVideoSupported())) return { supported: false };
      const canvas = document.createElement('canvas');
      const stream = canvas.captureStream(24);
      const track = stream.getVideoTracks()[0];
      const clone = track.clone.bind(track);
      const owned: MediaStreamTrack[] = [];
      track.clone = () => {
        const next = clone();
        owned.push(next);
        return next;
      };
      const Original = VideoEncoder;
      window.VideoEncoder = class extends Original {
        configure() {
          throw new Error('Injected codec startup failure');
        }
      };
      let failed = false;
      try {
        recordPacketVideo(
          stream,
          async () => {},
          () => {},
        );
      } catch (error) {
        failed = String(error).includes('Injected codec startup failure');
      } finally {
        window.VideoEncoder = Original;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = {
        supported: true,
        failed,
        ended: owned.length === 1 && owned.every((t) => t.readyState === 'ended'),
        sourceAlive: track.readyState === 'live',
        captureElements: document.querySelectorAll('video[aria-hidden]').length,
      };
      track.stop();
      return result;
    }, capture);
    test.skip(!result.supported, 'No packet video codec in this engine');
    expect(result).toMatchObject({
      failed: true,
      ended: true,
      sourceAlive: true,
      captureElements: 0,
    });
  });
}

test('packet video rejects disguised or oversized keyframes before decoding', async ({ page }) => {
  await page.route('**/__packet-video-bounds', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
  );
  await page.goto('/__packet-video-bounds');
  const result = await page.evaluate(async () => {
    const { callPacketVideoSupported, createPacketVideoReceiver } =
      await import('/src/services/callPacketVideo.ts');
    if (!(await callPacketVideoSupported())) return { supported: false };
    const Original = VideoDecoder;
    let decoded = 0,
      errors = 0;
    window.VideoDecoder = class extends Original {
      decode() {
        decoded++;
      }
    };
    const receiver = createPacketVideoReceiver(() => errors++);
    try {
      const bytes = new Uint8Array(20);
      bytes[0] = 1;
      bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0x10, 0, 0x10], 10);
      receiver.append(bytes); // A real VP8 keyframe falsely labelled delta.
      bytes[1] = 1;
      receiver.append(bytes); // Correct label but dimensions are 4096 by 4096.
      return { supported: true, decoded, errors };
    } finally {
      receiver.close();
      window.VideoDecoder = Original;
    }
  });
  test.skip(!result.supported, 'No packet video codec in this engine');
  expect(result).toMatchObject({ decoded: 0, errors: 2 });
});

test('packet video releases its stream when decoder startup fails', async ({ page }) => {
  await page.route('**/__packet-decoder-failure', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
  );
  await page.goto('/__packet-decoder-failure');
  const result = await page.evaluate(async () => {
    const { callPacketVideoSupported, createPacketVideoReceiver } =
      await import('/src/services/callPacketVideo.ts');
    const { getCallStream } = await import('/src/services/callStreamRegistry.ts');
    if (!(await callPacketVideoSupported())) return { supported: false };
    const Original = VideoDecoder,
      originalId = crypto.randomUUID.bind(crypto);
    const capture = HTMLCanvasElement.prototype.captureStream;
    const id = originalId();
    let stream: MediaStream | undefined;
    crypto.randomUUID = () => id;
    HTMLCanvasElement.prototype.captureStream = function (rate) {
      return (stream = capture.call(this, rate));
    };
    window.VideoDecoder = class extends Original {
      configure() {
        throw new Error('Injected decoder failure');
      }
    };
    let failed = false;
    try {
      createPacketVideoReceiver(() => {});
    } catch (error) {
      failed = String(error).includes('Injected decoder failure');
    } finally {
      window.VideoDecoder = Original;
      crypto.randomUUID = originalId;
      HTMLCanvasElement.prototype.captureStream = capture;
    }
    return {
      supported: true,
      failed,
      registered: Boolean(getCallStream(`anagram-call:${id}`)),
      ended: stream?.getTracks().every((t) => t.readyState === 'ended'),
    };
  });
  test.skip(!result.supported, 'No packet video codec in this engine');
  expect(result).toMatchObject({ failed: true, registered: false, ended: true });
});
