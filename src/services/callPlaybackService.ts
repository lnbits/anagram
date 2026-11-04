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
export async function setCallSpeaker(element: HTMLMediaElement, deviceId: string): Promise<void> {
  if (typeof element.setSinkId !== 'function') {
    if (!deviceId) return;
    throw new Error('Audio output selection is unavailable in this browser');
  }
  await element.setSinkId(deviceId);
}

// Players call this on timeupdate as well as progress: WebKit may append MSE
// segments without emitting progress, leaving a playing call behind live audio.
const catchingUpAudio = new WeakSet<HTMLMediaElement>();
function resetAudioRate(element: HTMLMediaElement): void {
  if (catchingUpAudio.delete(element)) element.playbackRate = 1;
}
export function followCallLive(
  element: HTMLMediaElement | null,
  kind: 'audio' | 'video' = 'video',
) {
  // A pause can keep receiving chunks. Catch up once playback resumes instead
  // of repeatedly moving the paused cursor on every timer/progress event.
  if (!element) return;
  if (element.paused || element.seeking || !element.buffered.length) {
    resetAudioRate(element);
    return;
  }
  const latest = element.buffered.length - 1;
  const start = element.buffered.start(latest);
  const end = element.buffered.end(latest);
  const lag = end - element.currentTime;
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
      resetAudioRate(element);
      element.currentTime = Math.max(start, end - 0.2);
    } else if (nextRange !== undefined) {
      // Cross only an actual hole, after playing the preceding range in full.
      resetAudioRate(element);
      element.currentTime = nextRange;
    } else if (lag > 0.35) {
      if (!catchingUpAudio.has(element)) {
        catchingUpAudio.add(element);
        element.playbackRate = 1.1;
      }
    } else if (lag <= 0.25) resetAudioRate(element);
    return;
  }
  if (lag > 0.6) element.currentTime = Math.max(start, end - 0.35);
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
    resetAudioRate(element);
  };
}
