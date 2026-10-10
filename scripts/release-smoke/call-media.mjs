// Executed inside the packaged WebView. Synthetic sources exercise the real
// recorder and streaming decoder without microphone/camera access in CI.
export async function probeCallMedia(verifyVideo) {
  const types = ['audio/webm;codecs=opus', 'video/webm;codecs=vp8,opus'];
  const result = {
    secure: globalThis.isSecureContext,
    capture: typeof navigator.mediaDevices?.getUserMedia === 'function',
    codecs: types.map((mime) => ({
      mime,
      record: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
      stream: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime),
    })),
    decoded: [],
  };
  if (!result.secure || !result.capture || result.codecs.some((c) => !c.record || !c.stream))
    return result;
  for (const mime of types) {
    const context = new AudioContext({ sampleRate: 48000 });
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    const stream = destination.stream;
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    canvas.style.cssText =
      'position:fixed;top:140px;left:0;width:160px;height:120px;z-index:2147483647';
    document.body.append(canvas);
    const graphics = canvas.getContext('2d');
    graphics.fillRect(0, 0, 160, 120);
    let draw;
    if (mime.startsWith('video/')) {
      stream.addTrack(canvas.captureStream(24).getVideoTracks()[0]);
      draw = setInterval(() => {
        graphics.fillStyle = '#24c86a';
        graphics.fillRect(0, 0, 160, 120);
      }, 40);
    }
    const player = document.createElement('video');
    player.muted = true;
    player.autoplay = true;
    player.playsInline = true;
    player.style.cssText =
      'position:fixed;top:0;left:0;width:160px;height:120px;z-index:2147483647';
    document.body.append(player);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const source = new MediaSource();
    const url = URL.createObjectURL(source);
    let timeout;
    try {
      const completed = (async () => {
        const opened = new Promise((resolve) =>
          source.addEventListener('sourceopen', resolve, { once: true }),
        );
        const rendered =
          mime.startsWith('video/') && verifyVideo
            ? verifyVideo(player)
            : new Promise((resolve, reject) => {
                const decoded = () => {
                  if (
                    player.currentTime > 0 &&
                    (!mime.startsWith('video/') || player.videoWidth === 160)
                  )
                    resolve();
                };
                player.ontimeupdate = decoded;
                player.onresize = decoded;
                player.onerror = () =>
                  reject(new Error(player.error?.message || 'Playback failed'));
              });
        void rendered.catch(() => {});
        player.src = url;
        // Observe playback itself: WebKit may leave play() pending while its
        // native sink is already displaying frames.
        void player.play().catch(() => {});
        await opened;
        const buffer = source.addSourceBuffer(mime);
        source.duration = Number.POSITIVE_INFINITY;
        await context.resume();
        let appended = Promise.resolve();
        let bytes = 0;
        await new Promise((resolve, reject) => {
          recorder.onerror = (event) => reject(event.error || new Error('Recording failed'));
          recorder.ondataavailable = (event) => {
            if (!event.data.size) return;
            bytes += event.data.size;
            appended = appended.then(async () => {
              const data = await event.data.arrayBuffer();
              await new Promise((done, failed) => {
                buffer.addEventListener('updateend', done, { once: true });
                buffer.addEventListener(
                  'error',
                  () => failed(new Error('Streaming decode failed')),
                  { once: true },
                );
                buffer.appendBuffer(data);
              });
              // Follow the incoming stream, as the actual call player does.
              if (buffer.buffered.length) {
                const end = buffer.buffered.end(buffer.buffered.length - 1);
                if (end - player.currentTime > 1.5)
                  player.currentTime = Math.max(buffer.buffered.start(0), end - 0.35);
              }
            });
            void appended.catch(reject);
          };
          recorder.onstop = resolve;
          recorder.start(100);
          // Keep the stream live until a decoded frame has been observed.
          void rendered.then(() => {
            if (recorder.state !== 'inactive') recorder.stop();
          }, reject);
        });
        await appended;
        if (!bytes) throw new Error(`No recorded data for ${mime}`);
        await rendered;
        result.decoded.push(mime);
      })();
      await Promise.race([
        completed,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Media roundtrip timed out: ${mime}`)),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      clearInterval(draw);
      recorder.ondataavailable = null;
      if (recorder.state !== 'inactive') recorder.stop();
      for (const track of stream.getTracks()) track.stop();
      oscillator.stop();
      await context.close();
      player.pause();
      player.removeAttribute('src');
      player.load();
      player.remove();
      canvas.remove();
      URL.revokeObjectURL(url);
    }
  }
  return result;
}
