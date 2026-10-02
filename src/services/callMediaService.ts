import type { CallMode } from 'src/types/call';
import { CALL_MIME_TYPES } from 'src/utils/callSignal';

export function callMediaSupported(mode: CallMode): boolean {
  const mime = CALL_MIME_TYPES[mode === 'video' ? 0 : 1];
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaSource !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(mime) &&
    MediaRecorder.isTypeSupported(mime) &&
    MediaSource.isTypeSupported(mime)
  );
}

export function getCallMedia(mode: CallMode): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video:
      mode === 'video'
        ? {
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 24, max: 24 },
            facingMode: 'user',
          }
        : false,
  });
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
  const pump = () => {
    if (closed || !buffer || buffer.updating) return;
    try {
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end > 12 && buffer.buffered.start(0) < end - 8) {
          buffer.remove(0, end - 8);
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
  onError: () => void
): () => void {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    audioBitsPerSecond: 32_000,
    videoBitsPerSecond: 600_000,
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
