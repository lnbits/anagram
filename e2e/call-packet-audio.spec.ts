import { expect, test } from '@playwright/test';

for (const { nativeAck, startupDelay } of [
  { nativeAck: false, startupDelay: 0 },
  { nativeAck: true, startupDelay: 0 },
  { nativeAck: false, startupDelay: 1800 },
]) {
  test(`Opus worker and AudioWorklet play decoded audio through loss, jitter and a relay stall (native acknowledgements: ${nativeAck}, startup delay: ${startupDelay} ms)`, async ({
    page,
  }, info) => {
    await page.route('**/__packet-audio', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
    );
    await page.goto('/__packet-audio');
    const options = { nativeAck, startupDelay };
    await page.evaluate(async ({ nativeAck, startupDelay }) => {
      const { prepareCallPacketAudio, recordCallMedia, createCallMediaReceiver } =
        await import('/src/services/callMediaService.ts');
      const { OPUS_CALL_MIME } = await import('/src/services/callAudioPackets.ts');
      const { attachCallMedia } = await import('/src/services/callStreamRegistry.ts');
      const { callPacketAudioDiagnostics } = await import('/src/services/callPacketAudio.ts');
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const run = async () => {
        // Match the negotiated packet sample rate for the synthetic microphone.
        const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        const resumed = context.resume();
        const release = await prepareCallPacketAudio();
        if (!release) throw new Error('Packet audio unavailable');
        await resumed;
        const destination = context.createMediaStreamDestination();
        const tone = context.createOscillator();
        tone.frequency.value = 440;
        tone.connect(destination);
        tone.start();
        const errors: string[] = [];
        // Tap the real playback worklet on its own clock. Routing the probe
        // through another AudioContext measures an extra device queue, which
        // can drift independently after stalls in WebKit. The constructor still
        // creates the real node, and the normal audio element remains connected.
        const WorkletNode = globalThis.AudioWorkletNode;
        let output: AudioWorkletNode | undefined;
        globalThis.AudioWorkletNode = class extends WorkletNode {
          constructor(...args: ConstructorParameters<typeof WorkletNode>) {
            super(...args);
            output = this;
          }
        };
        let receiver: ReturnType<typeof createCallMediaReceiver>;
        try {
          receiver = createCallMediaReceiver(OPUS_CALL_MIME, () => errors.push('decoder'));
        } finally {
          globalThis.AudioWorkletNode = WorkletNode;
        }
        if (!output) throw new Error('Missing playback worklet');
        const playback = output as AudioWorkletNode;
        const audio = document.createElement('audio');
        document.body.append(audio);
        attachCallMedia(audio, receiver.url);
        const analyser = playback.context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        const silent = playback.context.createGain();
        silent.gain.value = 0;
        playback.connect(analyser).connect(silent).connect(playback.context.destination);
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        const waitForTone = async (frequency: number, timeout = 2000) => {
          const other = frequency === 440 ? 880 : 440;
          const bin = (hz: number) =>
            Math.round((hz * analyser.fftSize) / playback.context.sampleRate);
          const start = performance.now();
          while (performance.now() - start < timeout) {
            analyser.getFloatFrequencyData(spectrum);
            if (
              spectrum[bin(frequency)] > -45 &&
              spectrum[bin(frequency)] > spectrum[bin(other)] + 8
            )
              return performance.now() - start;
            await delay(5);
          }
          throw new Error(
            `No decoded ${frequency} Hz audio; errors=${errors} time=${audio.currentTime} stats=${JSON.stringify(callPacketAudioDiagnostics())} max=${Math.max(...spectrum)}`,
          );
        };
        let count = 0,
          stall = false;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        let inFlight = 0,
          maxInFlight = 0;
        const captureStarted = performance.now();
        const stop = recordCallMedia(
          destination.stream,
          OPUS_CALL_MIME,
          async (frame) => {
            const n = count++;
            // Exercise a cold device/stream graph without sleeping in the test's
            // readiness check or changing the actual codec/receiver.
            if (performance.now() - captureStarted < startupDelay) return;
            if (n % 19 === 0) return; // deterministic packet loss
            const ms = stall ? 650 : [0, 10, 30, 5][n % 4];
            const timer = setTimeout(() => {
              timers.delete(timer);
              receiver.append(frame);
            }, ms);
            timers.add(timer);
            if (nativeAck) {
              maxInFlight = Math.max(maxInFlight, ++inFlight);
              await delay(35);
              inFlight--;
            }
          },
          () => errors.push('encoder'),
        );
        const timings: number[] = [];
        try {
          await audio.play();
          // A fixed sleep can expire before CI's audio device/stream graphs
          // start rendering. Establish decoded baseline audio before measuring
          // tone-change latency; startup still has its own finite deadline.
          const startupMs = await waitForTone(440, 5000);
          const readyPackets = count;
          const recordingAt = performance.now();
          for (let i = 0; i < 6; i++) {
            if (i === 2) {
              stall = true;
              await delay(500);
              stall = false;
              await delay(900);
            }
            if (i === 4) {
              // The audio render/codec threads keep running during a UI stall.
              // Recovery must discard old encoded deliveries instead of replaying them.
              const until = performance.now() + 250;
              while (performance.now() < until) {
                /* simulate a blocked UI thread */
              }
              await delay(500);
            }
            const frequency = i % 2 ? 440 : 880;
            tone.frequency.setValueAtTime(frequency, context.currentTime);
            timings.push(await waitForTone(frequency));
            await delay(150);
          }
          return {
            timings,
            startupMs,
            played: audio.currentTime,
            errors,
            packets: count,
            maxInFlight,
            rate: ((count - readyPackets) * 1000) / (performance.now() - recordingAt),
            stats: callPacketAudioDiagnostics(),
          };
        } finally {
          stop();
          timers.forEach(clearTimeout);
          playback.disconnect(analyser);
          analyser.disconnect();
          silent.disconnect();
          receiver.close();
          release();
          audio.pause();
          audio.srcObject = null;
          tone.stop();
          destination.stream.getTracks().forEach((track) => track.stop());
          await context.close();
        }
      };
      document.querySelector('button')!.onclick = () => {
        (window as any).__packetResult = run();
      };
    }, options);
    await page.getByRole('button').click();
    const result = await page.evaluate(() => (window as any).__packetResult);
    console.log('[packet audio]', JSON.stringify(result));
    await info.attach('packet-audio.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(result.errors).toEqual([]);
    expect(result.packets).toBeGreaterThan(100);
    expect(result.played).toBeGreaterThan(1);
    expect(result.timings).toHaveLength(6);
    if (startupDelay) expect(result.startupMs).toBeGreaterThanOrEqual(startupDelay);
    expect(Math.max(...result.timings)).toBeLessThan(400);
    if (nativeAck) {
      expect(result.maxInFlight).toBe(2);
      expect(result.rate).toBeGreaterThan(35);
    }
  });
}
