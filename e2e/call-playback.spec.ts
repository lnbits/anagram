import { expect, test, type ConsoleMessage } from '@playwright/test';

for (const kind of ['audio', 'video'] as const) {
  for (const { managed, slowSend, unevenSend } of [
    { managed: false, slowSend: false, unevenSend: false },
    { managed: true, slowSend: false, unevenSend: false },
    { managed: false, slowSend: true, unevenSend: false },
    { managed: false, slowSend: false, unevenSend: true },
  ]) {
    test(`${kind} ${managed ? 'managed' : 'standard'}${slowSend ? ' slow-send' : unevenSend ? ' uneven-send' : ''} playback catches up after a brief interruption without a seek loop`, async ({
      page,
      browserName,
    }, testInfo) => {
      // Exercise the real encoder/decoder locally, without relay or device variability.
      await page.route('**/__call-playback-probe', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<button>Start media</button>' }),
      );
      await page.goto('/__call-playback-probe');
      await page.getByRole('button').click();
      if (managed && browserName === 'webkit') {
        // The Apple CI job must exercise real managed playback, not the alias
        // used to cover the fallback branch in local Chromium regressions.
        expect(await page.evaluate(() => typeof (globalThis as any).ManagedMediaSource)).toBe(
          'function',
        );
      }
      // Keep progress outside the page: a native media hang can also stop its timers.
      const diagnostics: string[] = [];
      const onConsole = (message: ConsoleMessage) => {
        if (message.text().startsWith('[call-playback]')) {
          diagnostics.push(message.text());
          if (diagnostics.length > 160) diagnostics.shift();
        }
      };
      page.on('console', onConsole);
      const playback = page.evaluate(
        async ({ kind, managed, slowSend, unevenSend, traceMedia }) => {
          const stage = (name: string) =>
            console.log(`[call-playback] ${performance.now().toFixed(0)} ${name}`);
          stage('setup');
          // These markers do not read media state themselves. If a native getter
          // or seek blocks WebKit, the external deadline retains the last entry.
          const restores: (() => void)[] = [];
          if (traceMedia) {
            for (const [prototype, properties] of [
              [HTMLMediaElement.prototype, ['buffered', 'currentTime', 'paused']],
              [SourceBuffer.prototype, ['buffered']],
            ] as const) {
              for (const property of properties) {
                const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
                if (!descriptor?.get || !descriptor.configurable) continue;
                const label = `${prototype.constructor.name}.${property}`;
                Object.defineProperty(prototype, property, {
                  ...descriptor,
                  get() {
                    stage(`read ${label}`);
                    const value = descriptor.get!.call(this);
                    stage(`read ${label} returned`);
                    return value;
                  },
                  ...(descriptor.set
                    ? {
                        set(value: number) {
                          stage(`set ${label}`);
                          descriptor.set!.call(this, value);
                          stage(`set ${label} returned`);
                        },
                      }
                    : {}),
                });
                restores.push(() => Object.defineProperty(prototype, property, descriptor));
              }
            }
          }
          const heartbeat = traceMedia ? setInterval(() => stage('heartbeat'), 1000) : undefined;
          if (managed) {
            (window as any).isTauri = true;
            Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
            // WebKit uses its real ManagedMediaSource. Chromium exercises the same
            // fallback with its real decoder, without pretending this is an iPhone.
            const globals = globalThis as typeof globalThis & {
              ManagedMediaSource?: typeof MediaSource;
            };
            globals.ManagedMediaSource ??= MediaSource;
            Object.defineProperty(globalThis, 'MediaSource', {
              configurable: true,
              value: undefined,
            });
          }
          const { createCallMediaReceiver, recordCallMedia } =
            await import('/src/services/callMediaService.ts');
          const { watchCallLive } = await import('/src/services/callPlaybackService.ts');
          const { CALL_VIDEO_MIME_TYPE } = await import('/src/utils/callSignal.ts');
          const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
          const errors: string[] = [];
          stage('modules loaded');
          const element = document.createElement(kind);
          if (managed) element.disableRemotePlayback = true;
          if (element instanceof HTMLVideoElement) element.playsInline = true;
          element.muted = true;
          document.body.append(element);
          // Recover even if a stalled WebView emits neither progress nor timeupdate.
          const stopFollowing = watchCallLive(element, kind);
          element.onerror = () => errors.push(element.error?.message || 'media error');
          let seeks = 0;
          element.onseeking = () => seeks++;
          let displayedFrames = 0;
          let frameCallback = 0;
          if (element instanceof HTMLVideoElement) {
            const displayed = () => {
              displayedFrames++;
              frameCallback = element.requestVideoFrameCallback(displayed);
            };
            frameCallback = element.requestVideoFrameCallback(displayed);
          }
          let context: AudioContext | undefined;
          let oscillator: OscillatorNode | undefined;
          let draw: ReturnType<typeof setInterval> | undefined;
          let canvas: HTMLCanvasElement | undefined;
          let stream: MediaStream;
          if (kind === 'audio') {
            context = new AudioContext();
            const destination = context.createMediaStreamDestination();
            oscillator = context.createOscillator();
            oscillator.connect(destination);
            oscillator.start();
            await context.resume();
            stream = destination.stream;
          } else {
            canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            document.body.append(canvas);
            const paint = canvas.getContext('2d')!;
            draw = setInterval(() => {
              paint.fillStyle = `hsl(${performance.now() % 360},70%,50%)`;
              paint.fillRect(0, 0, canvas!.width, canvas!.height);
            }, 1000 / 24);
            stage('canvas capture');
            stream = canvas.captureStream(24);
            stage('canvas captured');
          }
          const mime = kind === 'audio' ? 'audio/webm;codecs=opus' : CALL_VIDEO_MIME_TYPE;
          stage('create receiver');
          const receiver = createCallMediaReceiver(mime, () => errors.push('receiver error'));
          element.src = receiver.url;
          let chunk = 0;
          stage('start recorder');
          const stop = recordCallMedia(
            stream,
            mime,
            async (bytes: Uint8Array) => {
              // Preserve the jitter regression; separately exercise sustained slow
              // acknowledgements that require queued WebM chunks to coalesce.
              await delay(
                slowSend ? 150 : (unevenSend ? [0, 25, 200, 150] : [0, 25, 70, 10])[chunk % 4],
              );
              chunk++;
              if (chunk === 1) stage('append first segment');
              receiver.append(bytes.subarray(1));
              if (chunk === 1) stage('first segment appended');
            },
            () => errors.push('recorder error'),
          );
          stage('recorder started');
          const snapshot = () => ({
            kind,
            managed,
            mime,
            chunk,
            errors,
            currentTime: element.currentTime,
            paused: element.paused,
            readyState: element.readyState,
            buffered: Array.from({ length: element.buffered.length }, (_, i) => [
              element.buffered.start(i),
              element.buffered.end(i),
            ]),
          });
          const waitForPlayback = async (after: number) => {
            const deadline = performance.now() + 10000;
            while (
              (element.paused || element.currentTime <= after) &&
              performance.now() < deadline
            ) {
              if (errors.length) throw new Error(JSON.stringify(snapshot()));
              await delay(50);
            }
            if (element.paused || element.currentTime <= after)
              throw new Error(`Media did not advance: ${JSON.stringify(snapshot())}`);
          };
          try {
            stage('start playback');
            void element.play().catch((error: Error) => errors.push(error.message));
            await waitForPlayback(1);
            stage('playback started');
            const before = seeks;
            stage('pause playback');
            element.pause();
            await delay(750);
            stage('resume playback');
            const pausedAt = element.currentTime;
            // WebKit can leave play() pending even while its native sink plays.
            // Check actual playback progress with a deadline, as the packaged probe does.
            void element.play().catch((error: Error) => errors.push(error.message));
            await waitForPlayback(pausedAt + 0.25);
            stage('playback resumed');
            await delay(1000);
            // Audio drains modest backlog at 1.1x rather than seeking it away.
            // Allow bounded recovery, but require a full two-second window of
            // low median lag and continued playback, not one favourable timer sample.
            // Draining 0.75s toward 0.25s can take five seconds at that rate;
            // eight seconds includes the measurement window and timer headroom.
            const recoveryStarted = performance.now();
            const sample = () => ({
              elapsed: performance.now() - recoveryStarted,
              time: element.currentTime,
              frames: displayedFrames,
              rate: element.playbackRate,
              lag: element.buffered.length
                ? element.buffered.end(element.buffered.length - 1) - element.currentTime
                : Number.POSITIVE_INFINITY,
            });
            const samples = [sample()];
            let lag = Number.POSITIVE_INFINITY;
            let advanced = 0;
            let frames = 0;
            do {
              await delay(100);
              if (errors.length) throw new Error(JSON.stringify(snapshot()));
              samples.push(sample());
              if (samples.length > 21) samples.shift();
              const latest = samples[samples.length - 1];
              advanced = latest.time - samples[0].time;
              frames = latest.frames - samples[0].frames;
              const lags = samples
                .slice(1)
                .map((entry) => entry.lag)
                .sort((a, b) => a - b);
              lag = lags[Math.floor(lags.length / 2)];
              if (
                samples.length === 21 &&
                lag < (kind === 'audio' ? 0.45 : 0.75) &&
                advanced > 1.5 &&
                (kind === 'audio' || frames > 5)
              )
                break;
            } while (performance.now() - recoveryStarted < 8000);
            return {
              errors,
              seeks: seeks - before,
              lag,
              advanced,
              displayedFrames: frames,
              recoveryMs: performance.now() - recoveryStarted,
              samples,
            };
          } finally {
            clearInterval(heartbeat);
            restores.forEach((restore) => restore());
            stopFollowing();
            if (element instanceof HTMLVideoElement)
              element.cancelVideoFrameCallback(frameCallback);
            stage(`stop recorder: ${JSON.stringify(snapshot())}`);
            stop();
            stage('stop capture');
            stream.getTracks().forEach((track) => track.stop());
            clearInterval(draw);
            oscillator?.stop();
            await context?.close();
            element.pause();
            stage('close receiver');
            receiver.close();
            element.remove();
            canvas?.remove();
            stage('cleanup complete');
          }
        },
        {
          kind,
          managed,
          slowSend,
          unevenSend,
          traceMedia: process.env.ANAGRAM_MEDIA_DIAGNOSTICS === '1',
        },
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        playback,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  `Media probe stopped responding. Last stages:\n${diagnostics.join('\n')}`,
                ),
              ),
            30000,
          );
        }),
      ]).finally(async () => {
        clearTimeout(deadline);
        page.off('console', onConsole);
        await testInfo.attach('playback-diagnostics', {
          body: diagnostics.join('\n'),
          contentType: 'text/plain',
        });
      });
      await testInfo.attach('playback-measurements', {
        body: JSON.stringify({ kind, managed, slowSend, unevenSend, result }, null, 2),
        contentType: 'application/json',
      });
      console.log(
        '[call playback]',
        JSON.stringify({ kind, managed, slowSend, unevenSend, ...result, samples: undefined }),
      );
      expect(result.errors).toEqual([]);
      // Browsers may catch up themselves; require low lag and sustained playback,
      // not an unnecessary application seek. Unit tests exercise forced drift.
      expect(result.seeks).toBeLessThanOrEqual(3);
      expect(result.samples).toHaveLength(21);
      expect(result.lag).toBeLessThan(kind === 'audio' ? 0.45 : 0.75);
      expect(result.advanced).toBeGreaterThan(1.5);
      if (kind === 'video') expect(result.displayedFrames).toBeGreaterThan(5);
    });
  }
}
