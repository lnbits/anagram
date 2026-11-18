import { expect, test } from '@playwright/test';

test('packet audio gradually recovers a sustained backlog with real Opus and playback', async ({
  page,
}, info) => {
  await page.route('**/__audio-catchup', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
  );
  await page.goto('/__audio-catchup');
  await page.evaluate(async () => {
    const media = await import('/src/services/callMediaService.ts');
    const { callPacketAudioDiagnostics } = await import('/src/services/callPacketAudio.ts');
    const { attachCallMedia } = await import('/src/services/callStreamRegistry.ts');
    const { OPUS_CALL_MIME } = await import('/src/services/callAudioPackets.ts');
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    document.querySelector('button')!.onclick = () => {
      (window as any).__result = (async () => {
        const sourceContext = new AudioContext({ sampleRate: 48000 });
        await sourceContext.resume();
        const release = await media.prepareCallPacketAudio();
        if (!release) throw new Error('Packet audio unavailable');
        const destination = sourceContext.createMediaStreamDestination();
        const tone = sourceContext.createOscillator();
        tone.frequency.value = 440;
        tone.connect(destination);
        tone.start();
        let node: AudioWorkletNode | undefined;
        const Original = globalThis.AudioWorkletNode;
        globalThis.AudioWorkletNode = class extends Original {
          constructor(...args: ConstructorParameters<typeof Original>) {
            super(...args);
            node = this;
          }
        };
        const errors: string[] = [];
        let receiver: ReturnType<typeof media.createCallMediaReceiver>;
        try {
          receiver = media.createCallMediaReceiver(OPUS_CALL_MIME, () => errors.push('decode'));
        } finally {
          globalThis.AudioWorkletNode = Original;
        }
        const analyser = node!.context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        const silent = node!.context.createGain();
        silent.gain.value = 0;
        node!.connect(analyser).connect(silent).connect(node!.context.destination);
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        const audio = document.createElement('audio');
        document.body.append(audio);
        attachCallMedia(audio, receiver!.url);
        const held: Uint8Array[] = [];
        let hold = false;
        const stop = media.recordCallMedia(
          destination.stream,
          OPUS_CALL_MIME,
          async (packet) => {
            if (hold) held.push(packet);
            else receiver!.append(packet);
          },
          () => errors.push('encode'),
        );
        const measure = async (hz: number) => {
          const start = performance.now();
          tone.frequency.setValueAtTime(hz, sourceContext.currentTime);
          const other = hz === 440 ? 880 : 440;
          const bin = (frequency: number) => Math.round((frequency * analyser.fftSize) / 48000);
          while (performance.now() - start < 3000) {
            analyser.getFloatFrequencyData(spectrum);
            if (spectrum[bin(hz)] > -45 && spectrum[bin(hz)] > spectrum[bin(other)])
              return performance.now() - start;
            await delay(10);
          }
          throw new Error('Decoded tone did not arrive');
        };
        try {
          await audio.play();
          await measure(440);
          await delay(500);
          hold = true;
          await delay(800);
          hold = false;
          held.forEach((packet) => receiver!.append(packet));
          const stalledMs = await measure(880);
          const during = callPacketAudioDiagnostics();
          await delay(14000);
          const recoveredMs = await measure(440);
          return { errors, stalledMs, recoveredMs, during, after: callPacketAudioDiagnostics() };
        } finally {
          stop();
          receiver!.close();
          release();
          tone.stop();
          node!.disconnect();
          analyser.disconnect();
          silent.disconnect();
          audio.pause();
          audio.srcObject = null;
          audio.remove();
          destination.stream.getTracks().forEach((track) => track.stop());
          await sourceContext.close();
        }
      })();
    };
  });
  await page.getByRole('button').click();
  const result = await page.evaluate(() => (window as any).__result);
  await info.attach('catchup.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  console.log('[catchup]', JSON.stringify(result));
  expect(result.errors).toEqual([]);
  expect(result.stalledMs).toBeGreaterThan(650);
  expect(result.recoveredMs).toBeLessThan(350);
  expect(result.after[0].skipped).toBe(0);
  expect(result.after[0].renderedSamples).toBeGreaterThan(48000 * 10);
  expect(result.after[0].bufferedMs).toBeLessThan(180);
});
