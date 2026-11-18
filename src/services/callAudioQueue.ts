// Short scheduling/IPC stalls must not replace speech with the latest frame.
// These are emergency bounds, not a target delay: available frames drain immediately.
export const CALL_AUDIO_BACKLOG_MS = 1500;
export const CALL_AUDIO_QUEUE_FRAMES = CALL_AUDIO_BACKLOG_MS / 20;

export class CallAudioQueue<T> {
  private frames: { value: T; at: number }[] = [];

  private expire(now: number) {
    while (this.frames.length && now - this.frames[0].at > CALL_AUDIO_BACKLOG_MS)
      this.frames.shift();
  }

  get length() {
    return this.frames.length;
  }

  ageMs(now: number) {
    return this.frames.length ? Math.max(0, now - this.frames[0].at) : 0;
  }

  push(value: T, now: number, capturedAt = now) {
    this.expire(now);
    if (this.frames.length === CALL_AUDIO_QUEUE_FRAMES) this.frames.shift();
    if (now - capturedAt > CALL_AUDIO_BACKLOG_MS) return;
    this.frames.push({ value, at: capturedAt });
  }

  shift(now: number): T | undefined {
    this.expire(now);
    return this.frames.shift()?.value;
  }

  clear() {
    this.frames.length = 0;
  }
}
