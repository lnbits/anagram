// Reuse one audio element across negotiation, microphone changes and camera toggles.
// Input permission does not grant permission to autoplay a newly created media element.
let audio: HTMLAudioElement | null = null;
const SILENCE =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
export function registerCallAudio(element: HTMLAudioElement | null): void {
  audio = element;
}
export function primeCallAudio(): void {
  if (!audio || audio.src.startsWith('blob:')) return;
  audio.src = SILENCE;
  audio.muted = false;
  void audio.play().catch(() => {});
}
export { setCallSpeaker, releaseCallSpeaker, watchCallStreamPlayback } from './callAudioOutput.ts';

// Players call this on timeupdate as well as progress: WebKit may append MSE
// segments without emitting progress, leaving a playing call behind live audio.
const catchingUp = new WeakSet<HTMLMediaElement>();
const videoRecovery = new WeakMap<
  HTMLMediaElement,
  { seekAt: number; time: number; advancedAt?: number }
>();
function drainBacklog(element: HTMLMediaElement): void {
  if (!catchingUp.has(element)) {
    catchingUp.add(element);
    element.playbackRate = 1.1;
  }
}
function resetPlaybackRate(element: HTMLMediaElement): void {
  if (catchingUp.delete(element)) element.playbackRate = 1;
}
export function followCallLive(
  element: HTMLMediaElement | null,
  kind: 'audio' | 'video' = 'video',
) {
  // A pause can keep receiving chunks. Catch up once playback resumes instead
  // of repeatedly moving the paused cursor on every timer/progress event.
  if (!element) return;
  if (element.paused || !element.buffered.length) {
    videoRecovery.delete(element);
    resetPlaybackRate(element);
    return;
  }
  const latest = element.buffered.length - 1;
  const start = element.buffered.start(latest);
  const end = element.buffered.end(latest);
  const lag = end - element.currentTime;
  if (element.seeking) {
    resetPlaybackRate(element);
    // WebKit can retain a pending seek at a buffer gap indefinitely. Retry only
    // our own video correction, after settling time and substantial new backlog.
    // Ordinary seeks and audio must still finish without interference.
    const started = videoRecovery.get(element)?.seekAt;
    if (
      kind !== 'video' ||
      started === undefined ||
      performance.now() - started < 1500 ||
      lag <= 1.5
    )
      return;
  }
  if (kind === 'audio') {
    // Repeated seeks make the decoder rebuffer and can add as much delay as
    // they remove. Drain modest backlog smoothly, with hysteresis so chunk
    // arrival jitter does not keep changing the rate. Pitch is preserved by
    // the media element. Only a substantial backlog or a buffer gap needs a seek.
    let nextRange: number | undefined;
    for (let i = 0; i <= latest; i++) {
      if (
        element.currentTime >= element.buffered.start(i) &&
        element.currentTime < element.buffered.end(i)
      )
        break;
      if (element.buffered.start(i) > element.currentTime) {
        nextRange = element.buffered.start(i);
        break;
      }
    }
    if (lag > 1.5) {
      resetPlaybackRate(element);
      element.currentTime = Math.max(start, end - 0.2);
    } else if (nextRange !== undefined) {
      // Cross only an actual hole, after playing the preceding range in full.
      resetPlaybackRate(element);
      element.currentTime = nextRange;
    } else if (lag > 0.35) {
      drainBacklog(element);
    } else if (lag <= 0.25) resetPlaybackRate(element);
    return;
  }
  const now = performance.now();
  const previous = videoRecovery.get(element);
  if (previous && !element.seeking && element.currentTime > previous.time) {
    previous.time = element.currentTime;
    previous.advancedAt = now;
  }
  if (lag > 0.6) {
    if (previous && lag <= 1.5 && element.currentTime >= start) {
      if (now - previous.seekAt < 1500) return;
      // Re-seeking a decoder that has resumed playback can stall it again.
      // Drain a modest backlog while it advances. A stopped clock, large drift
      // or a missing range still follows the seek recovery path.
      if (previous.advancedAt !== undefined && now - previous.advancedAt < 1000) {
        drainBacklog(element);
        return;
      }
    }
    resetPlaybackRate(element);
    const target = Math.max(start, end - 0.35);
    videoRecovery.set(element, { seekAt: now, time: target });
    element.currentTime = target;
  } else if (lag <= 0.35) resetPlaybackRate(element);
}

// A stalled WebView can stop emitting both progress and timeupdate. Keep the
// live cursor moving independently, only for the lifetime of a remote player.
export function watchCallLive(
  element: HTMLMediaElement,
  kind: 'audio' | 'video' = 'video',
): () => void {
  const timer = setInterval(() => followCallLive(element, kind), 250);
  return () => {
    clearInterval(timer);
    resetPlaybackRate(element);
    videoRecovery.delete(element);
  };
}
