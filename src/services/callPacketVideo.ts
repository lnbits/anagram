import { registerCallStream } from './callStreamRegistry.ts';
import { callCaptureTrack } from './callSharedCapture.ts';
import type { CallMediaReceiver, CallRecordingOptions } from './callMediaService.ts';

export const PACKET_VIDEO_MIME = 'video/vp8;anagram=1';
const MAX_FRAME = 524288;
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
type ProcessorConstructor = new (options: {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}) => TrackProcessor;
function processor(): ProcessorConstructor | undefined {
  return (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: ProcessorConstructor })
    .MediaStreamTrackProcessor;
}

// Reuse a previously played element when a link restarts: WebKit can deny a
// fresh MediaStream player after the initial user gesture. Idle elements are
// detached and hold no stream; the weak key follows the camera/screen lifetime.
const idleCaptureVideos = new WeakMap<MediaStreamTrack, HTMLVideoElement>();

function videoFrames(
  track: MediaStreamTrack,
  frameRate: number,
  sourceTrack: MediaStreamTrack,
  maxWidth = 1920,
  maxHeight = 1080,
): ReadableStreamDefaultReader<VideoFrame> {
  const Processor = processor();
  if (Processor) return new Processor({ track, maxBufferSize: 1 }).readable.getReader();
  // Hidden WebKit videos can stop presentation callbacks even while their live
  // source advances. Sample only on demand at the encoder's bounded frame rate.
  const video = idleCaptureVideos.get(sourceTrack) ?? document.createElement('video');
  idleCaptureVideos.delete(sourceTrack);
  const canvas = document.createElement('canvas');
  const paint = canvas.getContext('2d', { alpha: false });
  if (!paint) throw new Error('Video capture unavailable');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(video);
  const interval = Math.ceil(1000 / Math.max(1, Math.min(24, frameRate))) + 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    finish?.();
    finish = undefined;
    video.pause();
    video.srcObject = null;
    // Reset WebKit's retained frame before this element is reused for a new
    // quality profile or connection. Keep the element's playback permission.
    video.load();
    video.remove();
    canvas.width = canvas.height = 0;
    idleCaptureVideos.set(sourceTrack, video);
  };
  return new ReadableStream<VideoFrame>(
    {
      start(controller) {
        video.srcObject = new MediaStream([track]);
        void video.play().catch((error) => {
          if (closed) return;
          controller.error(error);
          close();
        });
      },
      pull(controller) {
        return new Promise<void>((resolve) => {
          finish = resolve;
          const capture = () => {
            if (video.readyState < 2) {
              timer = setTimeout(capture, interval);
              return;
            }
            finish = undefined;
            try {
              const scale = Math.min(1, maxWidth / video.videoWidth, maxHeight / video.videoHeight);
              const width = Math.max(2, Math.floor(video.videoWidth * scale));
              const height = Math.max(2, Math.floor(video.videoHeight * scale));
              if (canvas.width !== width) canvas.width = width;
              if (canvas.height !== height) canvas.height = height;
              paint.drawImage(video, 0, 0, canvas.width, canvas.height);
              controller.enqueue(
                new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) }),
              );
            } catch (error) {
              controller.error(error);
              close();
            }
            resolve();
          };
          timer = setTimeout(capture, interval);
        });
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  ).getReader();
}
export async function callPacketVideoSupported(): Promise<boolean> {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoDecoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined' ||
    typeof HTMLVideoElement === 'undefined' ||
    !HTMLCanvasElement.prototype.captureStream
  )
    return false;
  try {
    const [encoder, decoder] = await Promise.all([
      VideoEncoder.isConfigSupported({
        codec: 'vp8',
        width: 640,
        height: 360,
        bitrate: 600000,
        latencyMode: 'realtime',
      }),
      VideoDecoder.isConfigSupported({ codec: 'vp8', optimizeForLatency: true }),
    ]);
    return encoder.supported && decoder.supported;
  } catch {
    return false;
  }
}

export function createPacketVideoReceiver(onError: () => void): CallMediaReceiver {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const paint = canvas.getContext('2d', { alpha: false });
  if (!paint) throw new Error('Video renderer unavailable');
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?(): void };
  // Some engines expose canvas capture without manual frame requests. A zero
  // rate freezes after the initial image there; use bounded automatic capture.
  if (!track.requestFrame) {
    track.stop();
    stream = canvas.captureStream(24);
    track = stream.getVideoTracks()[0];
  }
  const handle = registerCallStream(stream);
  let closed = false,
    waitingKey = true;
  let latestTimestamp = -1;
  let decoder: VideoDecoder;
  try {
    decoder = new VideoDecoder({
      output(frame) {
        try {
          if (closed || frame.timestamp < latestTimestamp) return;
          latestTimestamp = frame.timestamp;
          if (frame.displayWidth > 1920 || frame.displayHeight > 1080)
            throw new Error('Video frame too large');
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          paint.drawImage(frame, 0, 0);
          track.requestFrame?.();
        } catch {
          if (!closed) onError();
        } finally {
          frame.close();
        }
      },
      error() {
        if (!closed) onError();
      },
    });
    decoder.configure({ codec: 'vp8', optimizeForLatency: true });
  } catch (error) {
    decoder?.close();
    handle.close();
    throw error;
  }
  return {
    url: handle.url,
    append(bytes) {
      if (closed) return;
      try {
        if (bytes.length <= 10 || bytes.length > MAX_FRAME || bytes[0] !== 1 || bytes[1] > 1)
          throw new Error('Invalid video packet');
        const timestamp = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(
          2,
        );
        if (!Number.isSafeInteger(timestamp) || timestamp < 0)
          throw new Error('Invalid video timestamp');
        if (Boolean(bytes[1]) !== ((bytes[10] & 1) === 0))
          throw new Error('Incorrect VP8 frame type');
        if (bytes[1]) {
          // Check VP8's uncompressed keyframe header before allocating a decoder
          // surface. A small encoded packet can otherwise request a huge image.
          const vp8 = bytes.subarray(10);
          if (
            vp8.length < 10 ||
            vp8[0] & 1 ||
            vp8[3] !== 0x9d ||
            vp8[4] !== 0x01 ||
            vp8[5] !== 0x2a
          )
            throw new Error('Invalid VP8 keyframe');
          const width = (vp8[6] | (vp8[7] << 8)) & 0x3fff;
          const height = (vp8[8] | (vp8[9] << 8)) & 0x3fff;
          if (!width || !height || width > 1920 || height > 1080)
            throw new Error('Video dimensions exceed call limits');
        }
        if (decoder.decodeQueueSize >= 3) {
          waitingKey = true;
          // Let the bounded queue drain, then resume on a keyframe. Resetting an
          // active native decoder adds pipeline churn and can block GStreamer.
          return;
        }
        if (waitingKey && bytes[1] !== 1) return;
        if (waitingKey) latestTimestamp = timestamp;
        waitingKey = false;
        decoder.decode(
          new EncodedVideoChunk({
            type: bytes[1] ? 'key' : 'delta',
            timestamp,
            data: bytes.subarray(10),
          }),
        );
      } catch {
        onError();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      decoder.close();
      handle.close();
    },
  };
}

type Consumer = {
  send(data: Uint8Array): Promise<void>;
  error(): void;
  options?: CallRecordingOptions;
  busy: boolean;
  needsKey: boolean;
  stopped: boolean;
  since: number;
  slowUntil: number;
};
type SharedEncoder = { consumers: Set<Consumer>; stop(): void };
const encoders = new WeakMap<MediaStreamTrack, Map<string, SharedEncoder>>();

export function recordPacketVideo(
  stream: MediaStream,
  send: (frame: Uint8Array) => Promise<void>,
  onError: () => void,
  options?: CallRecordingOptions,
): () => void {
  const track = callCaptureTrack(stream.getVideoTracks()[0]);
  const bitrate = options?.videoBitsPerSecond ?? 600000;
  const maxWidth = options?.videoMaxWidth ?? 1920,
    maxHeight = options?.videoMaxHeight ?? 1080;
  const profileKey = `${bitrate}:${options?.videoFrameRate ?? 24}:${maxWidth}:${maxHeight}`;
  let profiles = encoders.get(track);
  if (!profiles) {
    profiles = new Map();
    encoders.set(track, profiles);
  }
  const consumer: Consumer = {
    send,
    error: onError,
    options,
    busy: false,
    needsKey: true,
    stopped: false,
    since: 0,
    slowUntil: 0,
  };
  let shared = profiles.get(profileKey);
  if (!shared) {
    const consumers = new Set<Consumer>();
    const captured = track.clone();
    const processorCapture = Boolean(processor());
    let reader: ReadableStreamDefaultReader<VideoFrame>;
    try {
      reader = videoFrames(captured, options?.videoFrameRate ?? 24, track, maxWidth, maxHeight);
    } catch (error) {
      captured.stop();
      throw error;
    }
    let stopped = false,
      lastKey = -Infinity,
      lastFrame = -Infinity;
    let currentBitrate = bitrate,
      congestedAt = 0;
    const dimensions = (width: number, height: number) => {
      const scale = Math.min(1, maxWidth / width, maxHeight / height);
      return [
        Math.max(2, Math.floor((width * scale) / 2) * 2),
        Math.max(2, Math.floor((height * scale) / 2) * 2),
      ];
    };
    const settings = track.getSettings();
    let [width, height] = dimensions(settings.width || 640, settings.height || 360);
    const config = () => ({
      codec: 'vp8',
      width,
      height,
      bitrate: currentBitrate,
      latencyMode: 'realtime' as const,
    });
    const fail = () => {
      for (const c of [...consumers]) if (!c.stopped) c.error();
    };
    let encoder: VideoEncoder;
    try {
      encoder = new VideoEncoder({
        error: fail,
        output(chunk) {
          if (stopped || chunk.byteLength > MAX_FRAME - 11) return;
          const frame = new Uint8Array(11 + chunk.byteLength);
          frame[1] = 1;
          frame[2] = chunk.type === 'key' ? 1 : 0;
          new DataView(frame.buffer).setFloat64(3, chunk.timestamp);
          chunk.copyTo(frame.subarray(11));
          for (const c of consumers) {
            if (c.stopped) continue;
            if (c.busy) {
              c.needsKey = true;
              continue;
            }
            if (c.needsKey && chunk.type !== 'key') continue;
            c.needsKey = false;
            c.busy = true;
            c.since = performance.now();
            // Runtime adds the camera/screen type; never let one peer mutate another's frame.
            void c
              .send(frame.slice())
              .then(() => {
                if (stopped || c.stopped) return;
                const now = performance.now();
                c.slowUntil = now - c.since > 180 ? now + 2000 : 0;
                // A single slow peer must not lower the shared encoder for
                // everyone. Adapt at most once a second when all peers lag.
                if (
                  now - congestedAt >= 1000 &&
                  [...consumers].every(
                    (peer) =>
                      peer.stopped || peer.slowUntil > now || (peer.busy && now - peer.since > 180),
                  )
                ) {
                  congestedAt = now;
                  currentBitrate = Math.max(
                    Math.min(bitrate, 200000),
                    Math.floor(currentBitrate * 0.8),
                  );
                }
              })
              .catch((error) => {
                if (!c.stopped) (c.options?.onSendError ?? c.error)(error);
              })
              .finally(() => {
                c.busy = false;
              });
          }
        },
      });
      encoder.configure(config());
    } catch (error) {
      encoder?.close();
      void reader.cancel().catch(() => {});
      captured.stop();
      throw error;
    }
    shared = {
      consumers,
      stop() {
        stopped = true;
        // The on-demand element path has no queued frames. Release its element
        // synchronously so a replacement link can reuse its playback permission.
        if (!processorCapture) {
          void reader.cancel().catch(() => {});
          captured.stop();
        }
        // Drain the processor's queued VideoFrame before cancelling its generic
        // ReadableStream: discarding that queue leaves native frames to GC.
        if (processorCapture)
          void (async () => {
            let timeout: ReturnType<typeof setTimeout>;
            try {
              const pending = reader.read().then((result) => {
                result.value?.close();
              });
              await Promise.race([
                pending,
                new Promise<void>((resolve) => {
                  timeout = setTimeout(resolve, 250);
                }),
              ]);
            } catch {
              /* The input may already have ended. */
            } finally {
              clearTimeout(timeout);
              await reader.cancel().catch(() => {});
              captured.stop();
            }
          })();
        encoder.close();
        profiles!.delete(profileKey);
      },
    };
    profiles.set(profileKey, shared);
    void (async () => {
      let configuredBitrate = currentBitrate;
      try {
        while (!stopped) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          try {
            if (stopped) break;
            const now = performance.now();
            // Bounded encode queue and capture rate; stale frames are independently droppable.
            const fps = options?.videoFrameRate ?? 24;
            if (encoder.encodeQueueSize >= 2 || now - lastFrame < (1000 / fps) * 0.9) continue;
            // If nobody can accept a frame, skip encoding it. Besides wasting
            // CPU, encoding unseen deltas would force another costly keyframe.
            if (![...consumers].some((c) => !c.stopped && !c.busy)) continue;
            if (now - congestedAt > 5000 && currentBitrate < bitrate) {
              currentBitrate = Math.min(bitrate, Math.floor(currentBitrate * 1.1));
              congestedAt = now;
            }
            // Startup track settings can be missing or stale; cameras and
            // shared screens can also change shape while capture stays live.
            // Encoding every frame at the initial size stretches its pixels.
            const [nextWidth, nextHeight] = dimensions(frame.displayWidth, frame.displayHeight);
            const resized = nextWidth !== width || nextHeight !== height;
            if (resized || currentBitrate !== configuredBitrate) {
              width = nextWidth;
              height = nextHeight;
              encoder.configure(config());
              configuredBitrate = currentBitrate;
            }
            const keyFrame =
              resized ||
              now - lastKey >= 1000 ||
              (now - lastKey >= 500 && [...consumers].some((c) => c.needsKey && !c.busy));
            if (keyFrame) lastKey = now;
            lastFrame = now;
            encoder.encode(frame, { keyFrame });
          } finally {
            frame.close();
          }
        }
      } catch {
        if (!stopped) fail();
      }
    })();
  }
  shared.consumers.add(consumer);
  const active = shared;
  return () => {
    if (consumer.stopped) return;
    consumer.stopped = true;
    active.consumers.delete(consumer);
    if (!active.consumers.size) active.stop();
  };
}
