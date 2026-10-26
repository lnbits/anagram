import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('WebM audio preserves speech after a brief pause and gradually recovers latency alongside video', async ({
  page,
}, testInfo) => {
  page.on('console', (message) => {
    if (message.text().startsWith('[latency]')) console.log(message.text());
  });
  await page.route('**/__audio-latency', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
  );
  await page.goto('/__audio-latency');
  await page.getByRole('button').click();
  const result = await page.evaluate(async () => {
    const { recordCallMedia, createCallMediaReceiver } =
      await import('/src/services/callMediaService.ts');
    const { followCallLive, watchCallLive } = await import('/src/services/callPlaybackService.ts');
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    async function measure(baseline: boolean) {
      console.log(`[latency] ${baseline ? 'baseline' : 'audio'}: starting`);
      const context = new AudioContext();
      await context.resume();
      console.log('[latency] context resumed');
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const paint = canvas.getContext('2d')!;
      let high = false;
      const draw = () => {
        paint.fillStyle = high ? '#ffffff' : '#000000';
        paint.fillRect(0, 0, 64, 64);
      };
      draw();
      const drawing = setInterval(draw, 1000 / 24);
      const videoStream = canvas.captureStream(24);
      const audio = document.createElement('audio');
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      document.body.append(audio, video);
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(analyser).connect(silent).connect(context.destination);
      const samples = new Float32Array(analyser.frequencyBinCount);
      const preview = document.createElement('canvas');
      preview.width = preview.height = 1;
      const read = preview.getContext('2d', { willReadFrequently: true })!;
      const errors: string[] = [];
      const stops: Array<() => void> = [];
      const receivers = [];
      const originalStart = MediaRecorder.prototype.start;
      let seeks = 0;
      audio.onseeking = () => seeks++;
      try {
        // Run the previous cadence/policy as a local comparison using the same codecs.
        if (baseline)
          MediaRecorder.prototype.start = function (slice?: number) {
            return originalStart.call(this, this.mimeType.startsWith('audio/') ? 100 : slice);
          };
        for (const [element, stream, mime, kind] of [
          [audio, destination.stream, 'audio/webm;codecs=opus', baseline ? 'video' : 'audio'],
          [video, videoStream, 'video/webm;codecs=vp8', 'video'],
        ] as const) {
          const receiver = createCallMediaReceiver(mime, () => errors.push(`${mime}: receiver`));
          receivers.push(receiver);
          element.src = receiver.url;
          element.onerror = () => errors.push(element.error?.message || 'decode');
          element.onprogress = element.ontimeupdate = () => followCallLive(element, kind);
          stops.push(watchCallLive(element, kind));
          let chunk = 0;
          stops.push(
            recordCallMedia(
              stream,
              mime,
              async (data) => {
                await delay([0, 15, 30, 10][chunk++ % 4]);
                receiver.append(data.subarray(1));
              },
              () => errors.push(`${mime}: recorder`),
            ),
          );
          void element.play().catch((error: Error) => errors.push(error.message));
        }
        const deadline = performance.now() + 10000;
        while ((audio.currentTime < 1 || video.currentTime < 1) && performance.now() < deadline)
          await delay(25);
        if (audio.currentTime < 1 || video.currentTime < 1)
          throw new Error(`Playback did not start: ${errors}`);
        console.log('[latency] playback started');
        // Both policies see the same interruption. Audio must drain it without a seek.
        const beforePauseSeeks = seeks;
        audio.pause();
        video.pause();
        await delay(750);
        void audio.play();
        void video.play();
        await delay(1000);
        const timings: Array<{ audioMs: number; videoMs: number }> = [];
        for (let pulse = 0; pulse < 4; pulse++) {
          high = !high;
          const emitted = performance.now();
          oscillator.frequency.setValueAtTime(high ? 880 : 440, context.currentTime);
          draw();
          let audioAt = 0,
            videoAt = 0;
          while ((!audioAt || !videoAt) && performance.now() - emitted < 3000) {
            analyser.getFloatFrequencyData(samples);
            const bin = (hz: number) => Math.round((hz * analyser.fftSize) / context.sampleRate);
            const lowPower = samples[bin(440)],
              highPower = samples[bin(880)];
            if (!audioAt && Math.max(lowPower, highPower) > -60 && highPower > lowPower === high)
              audioAt = performance.now();
            if (!videoAt && video.readyState >= 2) {
              read.drawImage(video, 0, 0, 1, 1);
              if (read.getImageData(0, 0, 1, 1).data[0] > 128 === high) videoAt = performance.now();
            }
            await delay(20);
          }
          if (!audioAt || !videoAt)
            throw new Error(
              `Decoded pulse missing: ${JSON.stringify({ audioAt, videoAt, errors })}`,
            );
          timings.push({ audioMs: audioAt - emitted, videoMs: videoAt - emitted });
          console.log(`[latency] pulse ${pulse}: ${JSON.stringify(timings.at(-1))}`);
          await delay(600);
        }
        return { timings, errors, seeks, recoverySeeks: seeks - beforePauseSeeks };
      } finally {
        MediaRecorder.prototype.start = originalStart;
        stops.forEach((stop) => stop());
        clearInterval(drawing);
        videoStream.getTracks().forEach((track) => track.stop());
        destination.stream.getTracks().forEach((track) => track.stop());
        oscillator.stop();
        audio.pause();
        video.pause();
        receivers.forEach((receiver) => receiver.close());
        await context.close();
        audio.remove();
        video.remove();
      }
    }
    return { baseline: await measure(true), audio: await measure(false) };
  });
  await writeFile(testInfo.outputPath('latency.json'), JSON.stringify(result, null, 2));
  await testInfo.attach('audio-video-latency', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(result.baseline.errors).toEqual([]);
  expect(result.audio.errors).toEqual([]);
  expect(result.audio.recoverySeeks).toBe(0);
  for (const pulse of result.audio.timings) {
    // Retain the deliberately paused 750 ms of speech instead of cutting it
    // to meet a latency target. Normal speed catches up gradually afterward.
    expect(pulse.audioMs).toBeLessThan(1200);
    expect(pulse.videoMs).toBeLessThan(800);
  }
  expect(result.audio.timings.at(-1)!.audioMs).toBeLessThan(500);
  expect(result.audio.timings.at(-1)!.audioMs).toBeLessThan(result.audio.timings[0].audioMs);
});
