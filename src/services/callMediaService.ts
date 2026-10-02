import type { CallMode } from 'src/types/call';
import { CALL_MIME_TYPES, CALL_VIDEO_MIME_TYPE } from 'src/utils/callSignal';

export function callMediaSupported(mode: CallMode): boolean {
  const mime = CALL_MIME_TYPES[1];
  return (
    globalThis.isSecureContext === true &&
    typeof WebAssembly !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    typeof crypto.randomUUID === 'function' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaSource !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(mime) &&
    MediaRecorder.isTypeSupported(mime) &&
    MediaSource.isTypeSupported(mime) &&
    (mode === 'audio' ||
      (MediaRecorder.isTypeSupported(CALL_VIDEO_MIME_TYPE) &&
        MediaSource.isTypeSupported(CALL_VIDEO_MIME_TYPE)))
  );
}

export function callCaptureErrorKey(cause: unknown): string {
  const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'call.error.permission';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'call.error.deviceMissing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'call.error.deviceBusy';
  return 'call.error.capture';
}

function audioConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}
const videoConstraints: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 24 },
  facingMode: 'user',
};
export function getCallMicrophone(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId), video: false });
}
export function getCallCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { ...videoConstraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
  });
}
export function canShareCallScreen(): boolean {
  return (
    callMediaSupported('video') && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}
export function getCallScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 15, max: 15 },
    },
  });
}
export async function getCallMedia(mode: CallMode, deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(deviceId),
      video: mode === 'video' ? videoConstraints : false,
    });
  } catch (cause) {
    // A disconnected preference must not prevent starting the next call.
    if (
      deviceId &&
      cause instanceof DOMException &&
      (cause.name === 'NotFoundError' ||
        (cause.name === 'OverconstrainedError' &&
          'constraint' in cause &&
          cause.constraint === 'deviceId'))
    ) {
      return getCallMedia(mode);
    }
    throw cause;
  }
}

export interface CallMediaReceiver {
  url: string;
  append(data: Uint8Array): void;
  close(): void;
}

// Each peer produces a continuous WebM stream; preserve every segment and bound buffering.
export function createCallMediaReceiver(mimeType: string, onError: () => void): CallMediaReceiver {
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  let buffer: SourceBuffer | null = null;
  const pending: Uint8Array<ArrayBuffer>[] = [];
  let queuedBytes = 0;
  let closed = false;
  let lastPrunedUntil = 0;
  const pump = () => {
    if (closed || !buffer || buffer.updating) return;
    try {
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end > 12 && end - 8 > lastPrunedUntil + 1 && buffer.buffered.start(0) < end - 8) {
          lastPrunedUntil = end - 8;
          buffer.remove(0, lastPrunedUntil);
          return;
        }
      }
      const segment = pending.shift();
      if (segment) {
        queuedBytes -= segment.byteLength;
        buffer.appendBuffer(segment);
      }
    } catch {
      onError();
    }
  };
  const open = () => {
    if (closed) return;
    try {
      buffer = source.addSourceBuffer(mimeType);
      source.duration = Number.POSITIVE_INFINITY;
      buffer.addEventListener('updateend', pump);
      buffer.addEventListener('error', onError);
      pump();
    } catch {
      onError();
    }
  };
  source.addEventListener('sourceopen', open, { once: true });
  return {
    url,
    append(data) {
      if (closed) return;
      queuedBytes += data.byteLength;
      if (queuedBytes > 2_097_152) {
        onError();
        return;
      }
      pending.push(new Uint8Array(data));
      pump();
    },
    close() {
      closed = true;
      source.removeEventListener('sourceopen', open);
      buffer?.removeEventListener('updateend', pump);
      buffer?.removeEventListener('error', onError);
      pending.length = 0;
      URL.revokeObjectURL(url);
    },
  };
}

export function recordCallMedia(
  stream: MediaStream,
  mimeType: string,
  send: (bytes: Uint8Array) => Promise<void>,
  onError: () => void,
  options?: { videoBitsPerSecond?: number }
): () => void {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    audioBitsPerSecond: 32_000,
    videoBitsPerSecond: options?.videoBitsPerSecond ?? 600_000,
  });
  let stopped = false;
  let queuedBytes = 0;
  let queue = Promise.resolve();
  recorder.onerror = onError;
  recorder.ondataavailable = (event) => {
    if (stopped || !event.data.size) return;
    queuedBytes += event.data.size;
    if (queuedBytes > 1_048_576 || event.data.size > 1_048_575) {
      onError();
      return;
    }
    queue = queue
      .then(async () => {
        if (stopped) return;
        const data = new Uint8Array(await event.data.arrayBuffer());
        if (stopped) return;
        const frame = new Uint8Array(data.length + 1);
        frame.set(data, 1);
        await send(frame);
        queuedBytes -= data.length;
      })
      .catch(() => {
        if (!stopped) onError();
      });
  };
  recorder.start(100);
  return () => {
    stopped = true;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    if (recorder.state !== 'inactive') recorder.stop();
  };
}
