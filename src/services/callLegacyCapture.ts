import { isTauri } from '@tauri-apps/api/core';
import { callCaptureTrack } from './callSharedCapture.ts';
import type { CallRecordingOptions } from './callMediaService.ts';
import { CALL_MIME_TYPES, CALL_VIDEO_MIME_TYPE } from '#src/utils/callSignal.ts';

type Listener = { chunk(blob: Blob): void; reset(): void; error(): void; ready: boolean };
type Capture = { listeners: Set<Listener>; restart(): void; close(): void };
const captures = new WeakMap<MediaStreamTrack, Map<string, Capture>>();

// Share split video with ordered receiver resets; never replay partial WebM
// headers. Legacy audio stays per peer so late joins cannot interrupt speech or
// spend every peer's media-change budget. Packet audio has its own shared encoder.
export function subscribeLegacyCapture(
  stream: MediaStream,
  mimeType: string,
  options: CallRecordingOptions | undefined,
  callbacks: Omit<Listener, 'ready'>,
): () => void {
  const tracks = stream.getTracks?.() ?? [];
  const original =
    mimeType === CALL_VIDEO_MIME_TYPE && tracks.length === 1 && options?.onStreamRestart
      ? callCaptureTrack(tracks[0])
      : undefined;
  const key = `${mimeType}:${options?.videoBitsPerSecond ?? 600000}:${options?.videoFrameRate ?? 24}:${options?.videoMaxWidth ?? 0}:${options?.videoMaxHeight ?? 0}`;
  let profiles = original ? captures.get(original) : undefined;
  if (original && !profiles) {
    profiles = new Map();
    captures.set(original, profiles);
  }
  let capture = profiles?.get(key);
  const listener: Listener = { ...callbacks, ready: !capture };
  if (!capture) {
    const listeners = new Set([listener]);
    let recorder: MediaRecorder;
    let captured: MediaStreamTrack | undefined;
    let stopping: Promise<void> | undefined;
    let closed = false;
    let started = false;
    let joining: ReturnType<typeof setTimeout> | undefined;
    let keyframe: ReturnType<typeof setTimeout> | undefined;
    const timeslice = mimeType === CALL_MIME_TYPES[1] ? 50 : 100;
    const renewVideo =
      mimeType === CALL_VIDEO_MIME_TYPE &&
      Boolean(options?.onStreamRestart) &&
      isTauri() &&
      /Linux/.test(navigator.userAgent) &&
      !/Android/.test(navigator.userAgent);
    const fail = () => {
      for (const peer of [...listeners]) peer.error();
    };
    const stopRecorder = (): Promise<void> => {
      if (stopping) return stopping;
      if (!recorder) return Promise.resolve();
      const previous = recorder;
      const track = captured;
      captured = undefined;
      previous.ondataavailable = previous.onerror = null;
      // stop() changes state synchronously, but native encoder teardown finishes
      // asynchronously. Do not attach another recorder to the source until then.
      stopping = new Promise<void>((resolve, reject) => {
        const finish = () => {
          previous.onstop = null;
          track?.stop();
          resolve();
        };
        if (previous.state === 'inactive') finish();
        else {
          previous.onstop = finish;
          try {
            previous.stop();
          } catch (error) {
            previous.onstop = null;
            track?.stop();
            reject(error);
          }
        }
      }).finally(() => {
        stopping = undefined;
      });
      return stopping;
    };
    const scheduleKeyframe = () => {
      if (renewVideo)
        keyframe = setTimeout(() => {
          // A restarted recorder may begin its timestamps at zero. Use the
          // same ordered receiver reset as a late join, not another WebM header
          // on a decoder whose playback cursor belongs to the old recording.
          if (!closed) capture!.restart();
        }, 4000);
    };
    const start = () => {
      // Keep recorder lifecycle separate from the room's preview/camera track.
      captured = original?.clone();
      recorder = new MediaRecorder(captured ? new MediaStream([captured]) : stream, {
        mimeType,
        audioBitsPerSecond: 32000,
        videoBitsPerSecond: options?.videoBitsPerSecond ?? 600000,
      });
      recorder.ondataavailable = (event) => {
        if (!closed && event.data.size)
          for (const peer of [...listeners]) if (peer.ready) peer.chunk(event.data);
      };
      recorder.onerror = fail;
      recorder.start(timeslice);
      started = true;
      scheduleKeyframe();
    };
    capture = {
      listeners,
      restart() {
        if (joining !== undefined) return;
        joining = setTimeout(async () => {
          if (closed) return;
          clearTimeout(keyframe);
          try {
            await stopRecorder();
            joining = undefined;
            if (closed) return;
            for (const peer of [...listeners]) {
              // A new subscriber already has an empty receiver. Only peers
              // that received the previous generation need another reset.
              if (started && peer.ready) peer.reset();
              peer.ready = true;
            }
            if (!closed) {
              start();
            }
          } catch {
            joining = undefined;
            fail();
          }
        }, 100);
      },
      close() {
        closed = true;
        clearTimeout(joining);
        clearTimeout(keyframe);
        void stopRecorder().catch(() => {});
        captured?.stop();
        profiles?.delete(key);
      },
    };
    profiles?.set(key, capture);
    try {
      // Batch the first subscribers too: quality changes replace all peer
      // subscriptions together and must not immediately reset a fresh stream.
      if (original) capture.restart();
      else start();
    } catch (error) {
      capture.close();
      throw error;
    }
  } else {
    capture.listeners.add(listener);
    capture.restart();
  }
  const active = capture;
  return () => {
    active.listeners.delete(listener);
    if (!active.listeners.size) active.close();
  };
}
