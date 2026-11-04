// Loaded only by run.mjs, inside the real Tauri WebView (or Chromium for harness checks).
import { isTauri } from '@tauri-apps/api/core';
import { createCallRuntime } from '/src/stores/nostr/callRuntime.svelte.ts';
import { createCallRoomRuntime } from '/src/stores/nostr/callRoomRuntime.svelte.ts';
import { createIrohCallEndpoint } from '/src/services/irohCallTransport.ts';
import {
  callMediaSupported,
  prepareCallPacketAudio,
  callPacketVideoSupported,
  recordCallMedia,
  createCallMediaReceiver,
} from '/src/services/callMediaService.ts';
import { attachCallMedia, getCallStream } from '/src/services/callStreamRegistry.ts';
import { callPacketAudioDiagnostics } from '/src/services/callPacketAudio.ts';
import { watchCallLive } from '/src/services/callPlaybackService.ts';

// Separate Linux group clients avoid putting every participant's audio graph in one WebView.
const participant = new URL(location.href).searchParams.get('participant');
const ownPeer = participant === null ? null : Number(participant);
const token = new URL(location.href).searchParams.get('token');
const report = async (data) => {
  document.querySelector('pre').textContent = JSON.stringify(data, null, 2);
  await fetch(`/__native_calls/report?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, peer: ownPeer }),
  });
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const wait = async (check, description) => {
  const deadline = performance.now() + 30000;
  while (!check()) {
    assert(performance.now() < deadline, description);
    await delay(100);
  }
};

async function scenario(kind, context, monitorContexts, legacy = false) {
  const withVideo = new URL(location.href).searchParams.get('media') !== 'audio';
  const count =
    kind === 'direct' ? 2 : Number(new URL(location.href).searchParams.get('participants') || 6);
  const localPeers = ownPeer === null ? Array.from({ length: count }, (_, i) => i) : [ownPeer];
  const ids = Array.from({ length: count }, (_, i) => (i + 10).toString(16).repeat(64));
  const calls = [],
    connections = ids.map(() => []),
    players = new Set();
  const captures = ids.map(() => 0),
    cleanup = [],
    errors = [];
  const sendCosts = ids.map(() => ({ count: 0, totalMs: 0, maxMs: 0 }));
  const recordings = new Set();
  let stopping = false;
  // New test elements may need the same user gesture as the app's Play audio
  // recovery button. The runner supplies a real keyboard event, never a policy override.
  const resumePlayback = () => {
    for (const player of players) void player.element.play().catch(() => {});
  };
  window.addEventListener('keydown', resumePlayback);
  const clockStart = performance.now();
  const audioStart = context.currentTime;
  const snapshot = () => ({
    elapsedSeconds: (performance.now() - clockStart) / 1000,
    sourceSeconds: context.currentTime - audioStart,
    monitorSeconds: monitorContexts.map((c) => c?.currentTime),
    kind,
    legacy,
    phases: calls.map((c) => c.session?.phase),
    failures: calls.map((c) => c.failureDetail),
    errors,
    captureVideos: [...document.querySelectorAll('video[aria-hidden="true"]')].map((video) => ({
      time: video.currentTime,
      paused: video.paused,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
    })),
    packetAudio: callPacketAudioDiagnostics(),
    audioSend: sendCosts.map((s) => ({
      count: s.count,
      meanMs: s.totalMs / Math.max(1, s.count),
      maxMs: s.maxMs,
    })),
    connections: connections.map((c) => c.length),
    captures,
    recordings: [...recordings].map((r) => ({
      peer: r.peer,
      mime: r.mime,
      sent: r.sent,
      idleMs: performance.now() - r.lastSent,
      tracks: r.stream
        .getTracks()
        .map((t) => ({ kind: t.kind, enabled: t.enabled, state: t.readyState })),
    })),
    players: [...players].map((p) => ({
      peer: p.peer,
      video: p.video,
      time: p.element.currentTime,
      frames: p.frames,
      pictureChanges: p.pictureChanges,
      audioSamples: p.audioSamples,
      paused: p.element.paused,
      playError: p.playError,
      readyState: p.element.readyState,
      chunks: p.chunks,
      buffered: Array.from({ length: p.element.buffered.length }, (_, i) => [
        p.element.buffered.start(i),
        p.element.buffered.end(i),
      ]),
    })),
  });
  const stage = (name) => report({ stage: `${kind}: ${name}`, ...snapshot() });
  const healthy = () => {
    assert(!errors.length, JSON.stringify(snapshot()));
    return (
      localPeers.every((i) => calls[i]) &&
      calls.every(
        (c) =>
          c.session?.phase === 'active' &&
          (kind === 'direct' ||
            (c.participants.length === count - 1 &&
              c.participants.every((p) => p.phase === 'active'))),
      )
    );
  };
  const microphone = (peer) => {
    captures[peer]++;
    const oscillator = context.createOscillator(),
      output = context.createMediaStreamDestination();
    oscillator.frequency.value = 330 + peer * 110;
    oscillator.connect(output);
    oscillator.start();
    cleanup.push(() => {
      oscillator.stop();
      output.stream.getTracks().forEach((t) => t.stop());
    });
    return output.stream;
  };
  const camera = (width = 320, height = 180) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // Keep sources in the window so native engines do not throttle hidden canvases.
    document.querySelector('#sources').append(canvas);
    const paint = canvas.getContext('2d');
    const manual =
      typeof globalThis.CanvasCaptureMediaStreamTrack?.prototype.requestFrame === 'function';
    const stream = canvas.captureStream(manual ? 0 : 24);
    const track = stream.getVideoTracks()[0];
    let colour = 0;
    const draw = setInterval(() => {
      colour = (colour + 0x9e3779) & 0xffffff;
      paint.fillStyle = `#${colour.toString(16).padStart(6, '0')}`;
      paint.fillRect(0, 0, canvas.width, canvas.height);
      if (width >= 1280) {
        paint.fillStyle = '#fff';
        paint.font = '24px sans-serif';
        paint.fillText(`Screen share ${colour} — 1280 × 720`, 32, 64);
      }
      if (manual) track.requestFrame();
    }, 1000 / 24);
    cleanup.push(() => {
      clearInterval(draw);
      stream.getTracks().forEach((t) => t.stop());
      canvas.remove();
    });
    return stream;
  };
  const barrier = async (name, value = null) => {
    if (ownPeer === null) return [];
    const response = await fetch(`/__native_calls/barrier?token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ name, peer: ownPeer, value }),
    });
    if (!response.ok) throw new Error('Barrier failed');
    return response.json();
  };
  const sendWire = async (kind, to, signal) => {
    const response = await fetch(`/__native_calls/signals?token=${token}`, {
      method: 'POST',
      body: JSON.stringify({ kind, peer: ids.indexOf(to), from: ids[ownPeer], signal }),
    });
    if (!response.ok) throw new Error('Signal failed');
  };
  let signalStopped = false;
  if (ownPeer !== null)
    void (async () => {
      while (!signalStopped) {
        const response = await fetch(`/__native_calls/signals?token=${token}&peer=${ownPeer}`);
        const messages = await response.json();
        for (const message of messages) {
          if (signalStopped) return;
          const call = calls[ownPeer];
          void Promise.resolve(
            message.kind === 'media'
              ? call.receiveSignal(message.from, message.signal)
              : call.receive(message.from, message.signal),
          ).catch((e) => errors.push(String(e)));
        }
      }
    })().catch((e) => {
      if (!signalStopped) errors.push(String(e));
    });
  try {
    for (const i of localPeers) {
      const media = {
        getOwnPubkey: () => ids[i],
        resolvePeer: async () => ({ name: `Peer ${i}` }),
        supported: callMediaSupported,
        preparePacketAudio: legacy && i === 0 ? undefined : prepareCallPacketAudio,
        packetVideoSupported: legacy && i === 0 ? undefined : callPacketVideoSupported,
        sendSignal: async (to, signal) =>
          ownPeer === null
            ? calls[ids.indexOf(to)].receiveSignal(ids[i], signal)
            : sendWire('media', to, signal),
        getMedia: async () => microphone(i),
        getCamera: async () => camera(),
        getScreen: async () => camera(1280, 720),
        createEndpoint: async () => {
          const endpoint = await createIrohCallEndpoint(['https://127.0.0.1:7004/']);
          const wrap = (connection) => {
            connections[i].push(connection);
            const sendAudio = connection.sendAudio;
            if (sendAudio)
              connection.sendAudio = async (data) => {
                const at = performance.now();
                await sendAudio(data);
                const elapsed = performance.now() - at;
                sendCosts[i].count++;
                sendCosts[i].totalMs += elapsed;
                sendCosts[i].maxMs = Math.max(sendCosts[i].maxMs, elapsed);
              };
            return connection;
          };
          return {
            ...endpoint,
            connect: async (...args) => wrap(await endpoint.connect(...args)),
            accept: async (...args) => wrap(await endpoint.accept(...args)),
          };
        },
        record: (stream, mime, send, onError, options) => {
          const recording = { peer: i, mime, stream, sent: 0, lastSent: performance.now() };
          const stop = recordCallMedia(
            stream,
            mime,
            async (frame) => {
              recording.sent++;
              recording.lastSent = performance.now();
              return send(frame);
            },
            onError,
            options,
          );
          recordings.add(recording);
          return () => {
            recordings.delete(recording);
            stop();
          };
        },
        createReceiver: (mime, onError) => {
          const monitorContext = monitorContexts[i];
          const failed = (message) => {
            if (!stopping) errors.push(message);
            onError();
          };
          const receiver = createCallMediaReceiver(mime, () => failed(`receiver ${i}: ${mime}`));
          const video = mime.startsWith('video/');
          // WebKitGTK can overflow its sample offsets if a metered element is
          // reused for a new MSE timeline. The app does not attach this test-only
          // MediaElementAudioSourceNode, so give each measured receiver its own.
          const element = document.createElement(video ? 'video' : 'audio');
          element.muted = true;
          element.autoplay = true;
          if (video) element.playsInline = true;
          const player = {
            peer: i,
            video,
            element,
            url: receiver.url,
            frames: 0,
            pictureChanges: 0,
            chunks: 0,
            audioSamples: 0,
          };
          players.add(player);
          const stopFollowing = watchCallLive(element, video ? 'video' : 'audio');
          let frameCallback;
          let audioTimer, audioSource, analyser, silent;
          if (video) {
            assert(
              typeof element.requestVideoFrameCallback === 'function',
              'Video frame observer unavailable',
            );
            const sample = document.createElement('canvas');
            sample.width = sample.height = 1;
            const pixels = sample.getContext('2d', { willReadFrequently: true });
            let previous = [0, 0, 0],
              sampledAt = -Infinity;
            const displayed = () => {
              if (!players.has(player)) return;
              if (performance.now() - sampledAt >= 250) {
                sampledAt = performance.now();
                pixels.drawImage(element, 0, 0, 1, 1);
                const current = pixels.getImageData(0, 0, 1, 1).data;
                if (
                  previous.reduce(
                    (sum, value, index) => sum + Math.abs(value - current[index]),
                    0,
                  ) > 32
                ) {
                  player.pictureChanges++;
                  previous = [...current.subarray(0, 3)];
                }
              }
              player.frames++;
              frameCallback = element.requestVideoFrameCallback(displayed);
            };
            frameCallback = element.requestVideoFrameCallback(displayed);
          } else {
            // Observe decoded sound, not merely a moving playback cursor. Silence
            // the output downstream of the analyser so runners do not emit tones.
            element.muted = false;
            const stream = getCallStream(receiver.url);
            if (stream) audioSource = monitorContext.createMediaStreamSource(stream);
            else audioSource = monitorContext.createMediaElementSource(element);
            analyser = monitorContext.createAnalyser();
            silent = monitorContext.createGain();
            silent.gain.value = 0;
            audioSource.connect(analyser).connect(silent).connect(monitorContext.destination);
            const samples = new Float32Array(analyser.fftSize);
            let lastAudioTime = 0;
            audioTimer = setInterval(() => {
              const time = element.currentTime;
              analyser.getFloatTimeDomainData(samples);
              // WebKit may retain the analyser's last block after a stalled MSE
              // player stops consuming audio. Only count newly played samples.
              if (
                time > lastAudioTime &&
                !element.paused &&
                samples.some((sample) => Math.abs(sample) > 0.01)
              )
                player.audioSamples++;
              lastAudioTime = time;
            }, 100);
          }
          element.onerror = () => failed(`player ${i}: ${element.error?.message}`);
          document.querySelector('#players').append(element);
          attachCallMedia(element, receiver.url);
          // Match CallAudio/CallVideo: WebKit can reject play() before a new
          // source has loaded. Actual decoded samples/frames still decide pass.
          const play = () =>
            void element.play().then(
              () => {
                player.playError = undefined;
              },
              (e) => {
                player.playError = e.message;
                if (
                  e.name === 'NotAllowedError' &&
                  element.readyState >= 2 &&
                  !player.requestedPlay
                ) {
                  player.requestedPlay = true;
                  void report({ stage: 'playback blocked' });
                }
                if (
                  !stopping &&
                  players.has(player) &&
                  e.name !== 'NotAllowedError' &&
                  e.name !== 'AbortError'
                )
                  errors.push(e.message);
              },
            );
          element.onloadeddata = play;
          play();
          return {
            ...receiver,
            append: (bytes) => {
              player.chunks++;
              receiver.append(bytes);
            },
            close: () => {
              players.delete(player);
              stopFollowing();
              element.onerror = null;
              element.onloadeddata = null;
              if (frameCallback !== undefined) element.cancelVideoFrameCallback(frameCallback);
              clearInterval(audioTimer);
              audioSource?.disconnect();
              analyser?.disconnect();
              silent?.disconnect();
              element.pause();
              element.srcObject = null;
              element.removeAttribute('src');
              element.load();
              element.remove();
              receiver.close();
            },
          };
        },
      };
      calls[i] =
        kind === 'direct'
          ? createCallRuntime(media)
          : createCallRoomRuntime({
              media,
              getOwnPubkey: () => ids[i],
              isBlocked: () => false,
              otherCallBusy: () => false,
              getIdentity: async () => ({ name: `Peer ${i}`, relays: ['wss://example.invalid/'] }),
              send: async (to, signal) =>
                ownPeer === null
                  ? calls[ids.indexOf(to)].receive(ids[i], signal)
                  : sendWire('room', to, signal),
            });
    }
    await stage('starting audio');
    if (kind === 'direct') {
      await calls[0].start(ids[1], 'audio');
      await calls[1].accept();
    } else if (ownPeer !== null) {
      if (ownPeer === 0) await calls[0].create();
      const links = await barrier('room-created', calls[0]?.session.link);
      if (ownPeer !== 0) await calls[ownPeer].join(links[0]);
    } else {
      await calls[0].create();
      for (let i = 1; i < count; i++) await calls[i].join(calls[0].session.link);
    }
    const lanes = localPeers.length * (count - 1);
    await wait(
      () =>
        healthy() &&
        players.size === lanes &&
        [...players].every((p) => p.element.currentTime > 1 && p.audioSamples > 3),
      'Initial audio did not play',
    );
    await barrier('audio-ready');
    await stage(withVideo ? 'audio playing; enabling video' : 'audio playing');
    if (withVideo) for (const call of calls.filter(Boolean)) await call.toggleCamera();
    let playerCount = lanes * (withVideo ? 2 : 1);
    await wait(
      () =>
        healthy() &&
        players.size === playerCount &&
        [...players].every((p) => !p.video || (p.frames > 5 && p.pictureChanges > 3)),
      'Media did not start playing',
    );
    await barrier('video-ready');
    const sustain = async (name) => {
      // Longer than the receiver's pruning window and Linux's keyframe renewal.
      const baseline = new Map(
        [...players].map((p) => [
          p,
          {
            time: p.element.currentTime,
            frames: p.frames,
            pictureChanges: p.pictureChanges,
            audioSamples: p.audioSamples,
          },
        ]),
      );
      for (let sample = 0; sample < 5; sample++) {
        await delay(5000);
        assert(healthy(), `Call ended during ${name}: ${JSON.stringify(snapshot())}`);
        assert(players.size === playerCount, 'A media lane disappeared');
        for (const p of players) {
          const previous = baseline.get(p);
          assert(
            previous && !p.element.paused && p.element.currentTime > previous.time + 0.5,
            `Playback stalled: ${JSON.stringify(snapshot())}`,
          );
          assert(
            !p.video ||
              (p.frames > previous.frames + 2 && p.pictureChanges > previous.pictureChanges + 2),
            `Video stopped displaying: ${JSON.stringify(snapshot())}`,
          );
          assert(
            p.video || p.audioSamples > previous.audioSamples + 3,
            `Decoded audio went silent: ${JSON.stringify(snapshot())}`,
          );
          baseline.set(p, {
            time: p.element.currentTime,
            frames: p.frames,
            pictureChanges: p.pictureChanges,
            audioSamples: p.audioSamples,
          });
        }
        await stage(`${name} ${5 * (sample + 1)}s`);
      }
      for (const p of players) {
        const b = p.element.buffered;
        assert(
          p.element.srcObject || (b.length && b.end(b.length - 1) - b.start(0) < 15),
          `Unbounded playback buffer: ${JSON.stringify(snapshot())}`,
        );
      }
    };
    await sustain(withVideo ? 'sustained audio/video' : 'sustained audio');
    await barrier('cameras-sustained');
    if (withVideo) {
      await stage('starting 720p screen sharing');
      await calls[0]?.startScreenSharing();
      await barrier('screen-started');
      playerCount += ownPeer === null ? count - 1 : ownPeer === 0 ? 0 : 1;
      await wait(
        () =>
          healthy() &&
          players.size === playerCount &&
          [...players].every((p) => !p.video || p.pictureChanges > 3),
        'Screen did not start playing',
      );
      await barrier('screen-playing');
      await sustain('screen sharing with audio and cameras');
      await barrier('screen-sustained');
      await calls[0]?.stopScreenSharing();
      await barrier('screen-stopped');
      playerCount = lanes * 2;
      await wait(() => players.size === playerCount, 'Stopping screen sharing retained a decoder');
    }
    await barrier('sustained');
    const started = calls.map((c) => c.session.startedAt),
      before = connections.map((c) => c.length);
    calls[0]?.toggleMicrophone();
    await barrier('mute-issued');
    const fromMutedPeer = (p) =>
      kind === 'direct'
        ? p.peer === 1
        : calls[p.peer].participants.some(
            (member) => member.pubkey === ids[0] && member.audioUrl === p.url,
          );
    // Check decoded output, not just the mute flag or signalling. Every receiver
    // of peer zero must go silent while the other participants keep speaking.
    await delay(1500);
    const mutedSamples = new Map(
      [...players].filter((p) => !p.video).map((p) => [p, p.audioSamples]),
    );
    await delay(1000);
    const muteChecks = [...mutedSamples].map(([p, samples]) => ({
      peer: p.peer,
      samples: p.audioSamples - samples,
      muted: fromMutedPeer(p),
    }));
    assert(
      muteChecks.every((check) => (check.samples === 0) === check.muted),
      `Microphone mute did not silence exactly its receivers: ${JSON.stringify({ muteChecks, ...snapshot() })}`,
    );
    await barrier('mute-verified');
    await stage('muted; disconnecting one peer connection');
    if (ownPeer === null || ownPeer === 0) connections[0][0].close('failed');
    await barrier('disconnect-issued');
    await wait(
      () =>
        healthy() &&
        ((ownPeer !== null && ownPeer !== 0) || connections[0].length > before[0]) &&
        players.size === playerCount &&
        [...players].every(
          (p) =>
            (!p.video && fromMutedPeer(p)) ||
            (p.element.currentTime > 1 && (!p.video || (p.frames > 5 && p.pictureChanges > 3))),
        ),
      'Call did not recover audio/video',
    );
    assert(
      (ownPeer !== null && ownPeer !== 0) ||
        (kind === 'direct' ? calls[0].session.microphoneMuted : calls[0].microphoneMuted),
      'Reconnect lost mute state',
    );
    assert(
      calls.every((c, i) => c.session.startedAt === started[i]),
      'Reconnect reset call start time',
    );
    assert(
      localPeers.every((i) => captures[i] === 1),
      'Reconnect recaptured microphone',
    );
    // Require fresh decoded sound after unmute, not samples retained from before
    // mute while a legacy receiver reset is still travelling to another peer.
    await barrier('recovered');
    for (const player of players) if (!player.video) player.audioSamples = 0;
    await barrier('unmute-observers-ready');
    calls[0]?.toggleMicrophone();
    await barrier('unmute-issued');
    // A legacy recorder started muted may replace its audio receiver on unmute.
    // Wait for decoded sound before capturing the sustained-playback baseline.
    await wait(
      () =>
        healthy() &&
        players.size === playerCount &&
        [...players].every((p) => p.video || p.audioSamples > 3),
      'Audio did not return after unmuting the recovered call',
    );
    await sustain('after reconnect');
    const transports = await Promise.all(
      connections.flat().map((c) => c.transportStats?.().catch(() => null)),
    );
    assert(
      transports.filter((stats) => stats?.paths > 0).length >= lanes,
      'Missing active transport diagnostics',
    );
    assert(
      transports.filter(Boolean).every((stats) => stats.relayOnly),
      'Call opened a direct IP path',
    );
    const result = { ...snapshot(), transports };
    await barrier('finished');
    await stage('hangup');
    if (kind === 'direct') await calls[0].end();
    else for (const c of calls.filter(Boolean)) await c.leave();
    await wait(() => players.size === 0, 'Hangup retained media players');
    return result;
  } catch (error) {
    await report({ stage: `${kind}: failed`, error: String(error), ...snapshot() });
    throw error;
  } finally {
    stopping = true;
    signalStopped = true;
    window.removeEventListener('keydown', resumePlayback);
    calls.forEach((c) => c.reset());
    cleanup.forEach((stop) => stop());
  }
}

const scenarios = [
  { kind: 'direct', legacy: false },
  { kind: 'group', legacy: false },
  { kind: 'direct', legacy: true },
].filter((s) => {
  const selected = new URL(location.href).searchParams.get('scenario') || 'all';
  return selected === 'all' || (s.legacy ? selected === 'legacy' : selected === s.kind);
});
const results = [];
let nextScenario = 0;
document.querySelector('button').onclick = async () => {
  document.querySelector('button').disabled = true;
  const context = new AudioContext({ sampleRate: 48000 });
  // Keep synthesis -> codec -> analysis acyclic. Feeding decoded streams back
  // into their synthesizer context can deadlock native GStreamer audio graphs.
  // Each simulated app has its own output graph. Sharing one mixer for every
  // client's decoders serializes their pulls unlike separate native WebViews.
  const current = scenarios[nextScenario];
  const count =
    current.kind === 'direct'
      ? 2
      : Number(new URL(location.href).searchParams.get('participants') || 6);
  const monitorContexts = Array.from({ length: count }, (_, i) =>
    ownPeer === null || ownPeer === i ? new AudioContext({ sampleRate: 48000 }) : null,
  );
  // Resume synchronously in the native keyboard/click gesture, before reporting.
  const resumed = Promise.all([
    context.resume(),
    ...monitorContexts.filter(Boolean).map((c) => c.resume()),
  ]);
  const packetPreparation = prepareCallPacketAudio();
  let releasePackets;
  let passed = false;
  try {
    await report({ stage: 'started', native: isTauri(), userAgent: navigator.userAgent });
    assert(
      isTauri() === (new URL(location.href).searchParams.get('native') === '1'),
      'Wrong app/browser runtime',
    );
    await resumed;
    releasePackets = await packetPreparation;
    await report({
      stage: 'media prepared',
      packetAudio: Boolean(releasePackets),
      packetVideo: await callPacketVideoSupported(),
      videoApis: {
        encoder: typeof VideoEncoder,
        decoder: typeof VideoDecoder,
        frame: typeof VideoFrame,
        processor: typeof MediaStreamTrackProcessor,
        vp8Encoder:
          typeof VideoEncoder === 'undefined'
            ? false
            : (
                await VideoEncoder.isConfigSupported({
                  codec: 'vp8',
                  width: 640,
                  height: 360,
                  bitrate: 600000,
                  latencyMode: 'realtime',
                })
              ).supported,
        vp8Decoder:
          typeof VideoDecoder === 'undefined'
            ? false
            : (await VideoDecoder.isConfigSupported({ codec: 'vp8', optimizeForLatency: true }))
                .supported,
      },
    });
    assert(
      callMediaSupported('audio') && callMediaSupported('video'),
      'Required call codecs unavailable',
    );
    results.push(await scenario(current.kind, context, monitorContexts, current.legacy));
    nextScenario++;
    passed = true;
  } catch (error) {
    await report({ done: true, passed: false, error: String(error), stack: error?.stack });
  } finally {
    releasePackets?.();
    await Promise.all([context.close(), ...monitorContexts.filter(Boolean).map((c) => c.close())]);
  }
  if (!passed) return;
  if (nextScenario === scenarios.length) {
    await report({
      done: true,
      passed: true,
      native: isTauri(),
      userAgent: navigator.userAgent,
      results,
    });
  } else {
    // Each new call gets its own gesture and releases its codec/audio contexts
    // at hangup, as the app does. Do not retain an artificial suite-wide engine.
    await delay(500);
    document.querySelector('button').disabled = false;
    document.querySelector('button').focus();
    await report({ stage: 'ready' });
  }
};
await report({ stage: 'ready' });
