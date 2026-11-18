import {
  createCallMediaReceiver,
  getCallMicrophone,
  prepareCallPacketAudio,
  recordCallMedia,
} from '../services/callMediaService.ts';
import { OPUS_CALL_MIME } from '../services/callAudioPackets.ts';
import { attachCallMedia } from '../services/callStreamRegistry.ts';
import { callAudioDiagnostics } from '../services/callPacketAudio.ts';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const start = element<HTMLButtonElement>('start'),
  stop = element<HTMLButtonElement>('stop');
const status = element('status'),
  metrics = element('metrics');
const audio = element<HTMLAudioElement>('remote');
let cleanup: Array<() => void> = [],
  savedUrl: string | undefined;
const finish = () => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  audio.pause();
  audio.srcObject = null;
  audio.removeAttribute('src');
  start.disabled = false;
  stop.disabled = true;
  status.textContent = 'Stopped';
};
stop.onclick = finish;
window.addEventListener('pagehide', finish);

async function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(() => done(new Error('Local WebRTC gathering timed out')), 5000);
    const done = (error?: Error) => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', changed);
      error ? reject(error) : resolve();
    };
    pc.addEventListener('icegatheringstatechange', changed);
    changed();
  });
}

start.onclick = async () => {
  start.disabled = true;
  status.textContent = 'Preparing';
  if (savedUrl) URL.revokeObjectURL(savedUrl);
  element('recording').replaceChildren();
  const mode = element<HTMLSelectElement>('mode').value;
  try {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    cleanup.push(() => void context.close());
    await context.resume();
    const microphone = await getCallMicrophone();
    cleanup.push(() => microphone.getTracks().forEach((track) => track.stop()));
    const source = context.createMediaStreamDestination();
    cleanup.push(() => source.stream.getTracks().forEach((track) => track.stop()));
    const gain = context.createGain();
    gain.gain.value = 0.08;
    gain.connect(source);
    const file = element<HTMLInputElement>('file').files?.[0];
    let reference: OscillatorNode | AudioBufferSourceNode;
    if (file) {
      const player = context.createBufferSource();
      player.buffer = await context.decodeAudioData(await file.arrayBuffer());
      player.loop = true;
      reference = player;
    } else {
      const tone = context.createOscillator();
      tone.frequency.value = 440;
      reference = tone;
    }
    reference.connect(gain);
    reference.start();
    cleanup.push(() => reference.stop());
    if (mode === 'webrtc') {
      const sender = new RTCPeerConnection({ iceServers: [] });
      const receiver = new RTCPeerConnection({ iceServers: [] });
      cleanup.push(() => {
        sender.close();
        receiver.close();
      });
      receiver.ontrack = (event) => {
        audio.srcObject = event.streams[0];
      };
      source.stream.getTracks().forEach((track) => sender.addTrack(track, source.stream));
      await sender.setLocalDescription(await sender.createOffer());
      await gathered(sender);
      await receiver.setRemoteDescription(sender.localDescription!);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await gathered(receiver);
      await sender.setRemoteDescription(receiver.localDescription!);
    } else {
      if (mode === 'packet') {
        const release = await prepareCallPacketAudio();
        if (!release) throw new Error('Packet audio is unavailable in this browser');
        cleanup.push(release);
      }
      const mime = mode === 'packet' ? OPUS_CALL_MIME : 'audio/webm;codecs=opus';
      const receiver = createCallMediaReceiver(mime, () => {
        status.textContent = 'Decoder error';
      });
      cleanup.push(() => receiver.close());
      attachCallMedia(audio, receiver.url);
      if (mode === 'packet') {
        cleanup.push(
          recordCallMedia(
            source.stream,
            mime,
            async (frame) => receiver.append(frame),
            () => {
              status.textContent = 'Encoder error';
            },
          ),
        );
      } else {
        const recorder = new MediaRecorder(source.stream, { mimeType: mime });
        let pending = Promise.resolve(),
          closed = false;
        recorder.ondataavailable = (event) => {
          pending = pending
            .then(async () => {
              const data = new Uint8Array(await event.data.arrayBuffer());
              if (!closed) receiver.append(data);
            })
            .catch((error) => {
              status.textContent = String(error);
            });
        };
        recorder.start(100);
        cleanup.push(() => {
          closed = true;
          recorder.stop();
        });
      }
    }
    await audio.play();
    const micSource = context.createMediaStreamSource(microphone);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const silent = context.createGain();
    silent.gain.value = 0;
    micSource.connect(analyser).connect(silent).connect(context.destination);
    cleanup.push(() => {
      micSource.disconnect();
      analyser.disconnect();
      silent.disconnect();
    });
    if (element<HTMLInputElement>('record').checked) {
      const recorder = new MediaRecorder(microphone);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        savedUrl = URL.createObjectURL(blob);
        const player = document.createElement('audio');
        player.controls = true;
        player.src = savedUrl;
        const download = document.createElement('a');
        download.href = savedUrl;
        download.download = `microphone-${mode}.${recorder.mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
        download.textContent = 'Download local microphone recording';
        element('recording').replaceChildren(player, download);
      };
      recorder.start();
      cleanup.push(() => recorder.stop());
    }
    const settings = microphone.getAudioTracks()[0].getSettings();
    const samples = new Float32Array(analyser.fftSize);
    const started = performance.now();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      metrics.textContent = JSON.stringify(
        {
          mode,
          elapsedSeconds: (performance.now() - started) / 1000,
          microphoneDbFS: 20 * Math.log10(Math.max(rms, 1e-9)),
          // Microphone level includes any local speech/noise. It is not an echo-cancellation score.
          processing: {
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl,
            sampleRate: settings.sampleRate,
          },
          audio: callAudioDiagnostics(),
        },
        null,
        2,
      );
    }, 250);
    cleanup.push(() => clearInterval(timer));
    stop.disabled = false;
    status.textContent = 'Playing reference — microphone is measured, not played back';
  } catch (error) {
    finish();
    status.textContent = `Failed: ${String(error)}`;
  }
};
