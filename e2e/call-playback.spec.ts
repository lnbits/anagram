import { expect, test, type ConsoleMessage } from '@playwright/test';

for (const nativeRenewal of [false, true]) {
  test(`shared WebM video gives staggered late joiners decodable headers${nativeRenewal ? ' through Linux recorder renewals' : ''}`, async ({
    page,
  }, testInfo) => {
    await page.route('**/__shared-video', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
    );
    await page.goto('/__shared-video');
    await page.getByRole('button').click();
    const result = await page.evaluate(async (nativeRenewal) => {
      if (nativeRenewal) {
        (window as any).isTauri = true;
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          value: 'Linux x86_64',
        });
      }
      const { recordCallMedia, createCallMediaReceiver } =
        await import('/src/services/callMediaService.ts');
      const { cloneCallTrack } = await import('/src/services/callSharedCapture.ts');
      const { watchCallLive } = await import('/src/services/callPlaybackService.ts');
      const mime = 'video/webm;codecs=vp8';
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      document.body.append(canvas);
      const paint = canvas.getContext('2d')!;
      const draw = setInterval(() => {
        paint.fillStyle = `hsl(${performance.now() % 360},90%,50%)`;
        paint.fillRect(0, 0, 320, 180);
      }, 50);
      const source = canvas.captureStream(20).getVideoTracks()[0];
      const errors: string[] = [];
      const stops: Array<() => void> = [];
      const players: Array<{ video: HTMLVideoElement; frames: number; resets: number }> = [];
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        for (let i = 0; i < 5; i++) {
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.autoplay = true;
          document.body.append(video);
          const player = { video, frames: 0, resets: 0 };
          players.push(player);
          let frameCallback = 0;
          const displayed = () => {
            player.frames++;
            frameCallback = video.requestVideoFrameCallback(displayed);
          };
          frameCallback = video.requestVideoFrameCallback(displayed);
          video.onerror = () => errors.push(video.error?.message ?? 'video failed');
          const createReceiver = () => {
            const receiver = createCallMediaReceiver(mime, () => errors.push('decoder failed'));
            video.src = receiver.url;
            void video.play().catch(() => {});
            return receiver;
          };
          let receiver = createReceiver();
          const follow = watchCallLive(video, 'video');
          const clone = cloneCallTrack(source);
          const stop = recordCallMedia(
            new MediaStream([clone]),
            mime,
            async (bytes) => receiver.append(bytes.subarray(1)),
            () => errors.push('recorder failed'),
            {
              onStreamRestart: async () => {
                player.resets++;
                receiver.close();
                receiver = createReceiver();
              },
            },
          );
          stops.push(() => {
            stop();
            follow();
            clone.stop();
            video.cancelVideoFrameCallback(frameCallback);
            video.onerror = null;
            video.pause();
            video.removeAttribute('src');
            video.load();
            receiver.close();
            video.remove();
          });
          await delay(600);
        }
        // Cross two periodic renewals as well as the late-join resets. A new
        // WebM header must not be appended to an old receiver timeline.
        const joinResets = players.map((p) => p.resets);
        if (nativeRenewal) await delay(9000);
        // Every participant must keep decoding after the last shared reset.
        const before = players.map((p) => p.frames);
        const deadline = performance.now() + 10000;
        while (
          players.some((p, i) => p.frames - before[i] < 5) &&
          performance.now() < deadline &&
          !errors.length
        )
          await delay(100);
        return {
          errors,
          joinResets,
          players: players.map(({ video, frames, resets }) => ({
            frames,
            resets,
            time: video.currentTime,
            ready: video.readyState,
            paused: video.paused,
            seeking: video.seeking,
            buffered: Array.from({ length: video.buffered.length }, (_, i) => [
              video.buffered.start(i),
              video.buffered.end(i),
            ]),
          })),
          frames: players.map((p, i) => p.frames - before[i]),
          resets: players.map((p) => p.resets),
        };
      } finally {
        stops.forEach((stop) => stop());
        source.stop();
        clearInterval(draw);
        canvas.remove();
      }
    }, nativeRenewal);
    await testInfo.attach('shared-video-playback', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(result.errors).toEqual([]);
    expect(result.frames).toHaveLength(5);
    for (const [index, frames] of result.frames.entries())
      expect(
        frames,
        `Player ${index}: ${JSON.stringify(result.players[index])}`,
      ).toBeGreaterThanOrEqual(5);
    expect(result.joinResets).toEqual([4, 3, 2, 1, 0]);
    if (nativeRenewal) {
      const renewals = result.resets[4];
      expect(renewals).toBeGreaterThanOrEqual(2);
      expect(result.resets).toEqual(result.joinResets.map((resets) => resets + renewals));
    } else expect(result.resets).toEqual(result.joinResets);
  });
}

for (const kind of ['audio', 'video', 'combined'] as const) {
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
          const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
          if (managed) element.disableRemotePlayback = true;
          if (element instanceof HTMLVideoElement) element.playsInline = true;
          element.muted = true;
          document.body.append(element);
          // Recover even if a stalled WebView emits neither progress nor timeupdate.
          const stopFollowing = watchCallLive(element, kind === 'audio' ? 'audio' : 'video');
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
          let stream = new MediaStream();
          if (kind !== 'video') {
            context = new AudioContext();
            const destination = context.createMediaStreamDestination();
            oscillator = context.createOscillator();
            oscillator.connect(destination);
            oscillator.start();
            await context.resume();
            stream = destination.stream;
          }
          if (kind !== 'audio') {
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
            stream.addTrack(canvas.captureStream(24).getVideoTracks()[0]);
            stage('canvas captured');
          }
          const mime =
            kind === 'audio'
              ? 'audio/webm;codecs=opus'
              : kind === 'combined'
                ? 'video/webm;codecs=vp8,opus'
                : CALL_VIDEO_MIME_TYPE;
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
          const playedSeconds = () => {
            const ranges = element.played;
            let seconds = 0;
            for (let i = 0; i < ranges.length; i++) seconds += ranges.end(i) - ranges.start(i);
            return seconds;
          };
          const snapshot = () => ({
            kind,
            managed,
            mime,
            chunk,
            errors,
            currentTime: element.currentTime,
            paused: element.paused,
            seeking: element.seeking,
            playedSeconds: playedSeconds(),
            displayedFrames,
            readyState: element.readyState,
            buffered: Array.from({ length: element.buffered.length }, (_, i) => [
              element.buffered.start(i),
              element.buffered.end(i),
            ]),
          });
          const waitForPlayback = async (after: number) => {
            const playedBefore = playedSeconds();
            const framesBefore = displayedFrames;
            const deadline = performance.now() + 10000;
            // Live catch-up can seek currentTime past `after` while play() is
            // still pending. Require media actually played and video rendered
            // before pausing or declaring recovery; a seek alone is not playback.
            const progressing = () =>
              !element.paused &&
              !element.seeking &&
              element.currentTime > after &&
              playedSeconds() - playedBefore >= 0.25 &&
              (kind === 'audio' || displayedFrames - framesBefore >= 3);
            while (!progressing() && performance.now() < deadline) {
              if (errors.length) throw new Error(JSON.stringify(snapshot()));
              await delay(50);
            }
            if (!progressing())
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
            // Preserve up to 1.5s of buffered speech. At 1.1x, draining that
            // toward 0.25s takes 12.5s, plus the two-second measurement window.
            // Keep recovery bounded while allowing speech to finish playing.
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
            // Repeated 150–200 ms transport delays can retain a modest backlog.
            // Preserve that speech instead of demanding a seek to the live edge.
            const audioLagLimit = slowSend || unevenSend ? 0.8 : 0.45;
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
                lag < (kind === 'audio' ? audioLagLimit : 0.75) &&
                advanced > 1.5 &&
                (kind === 'audio' || frames > 5)
              )
                break;
            } while (performance.now() - recoveryStarted < (kind === 'audio' ? 15000 : 8000));
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
      expect(result.lag).toBeLessThan(
        kind === 'audio' ? (slowSend || unevenSend ? 0.8 : 0.45) : 0.75,
      );
      expect(result.advanced).toBeGreaterThan(1.5);
      if (kind !== 'audio') expect(result.displayedFrames).toBeGreaterThan(5);
    });
  }
}
