/** Observe speech without rerouting playback or changing the selected speaker. */
export function observeCallActivity(
  stream: MediaStream,
  report: (level: number) => void
): () => void {
  if (typeof AudioContext === 'undefined' || !stream.getAudioTracks().length) return () => {};
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  void context.resume().catch(() => {});
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const power = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
    report(Math.sqrt(power));
  }, 100);
  return () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    void context.close();
    report(0);
  };
}
