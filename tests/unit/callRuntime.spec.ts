import { createCallRuntime } from 'src/stores/nostr/callRuntime';
import {
  CALL_PROTOCOL,
  type CallConnection,
  type CallEndpoint,
  type CallSignal,
} from 'src/types/call';
import { afterEach, describe, expect, it, vi } from 'vitest';

const own = 'b'.repeat(64);
const peer = 'a'.repeat(64);
class TestMediaStream {
  constructor(private tracks: Array<{ kind: string }> = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}
vi.stubGlobal('MediaStream', TestMediaStream);
function invite(overrides: Partial<CallSignal> = {}): CallSignal {
  return {
    protocol: CALL_PROTOCOL,
    action: 'invite',
    callId: crypto.randomUUID(),
    mode: 'video',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    address: { id: 'c'.repeat(64), relayUrl: 'https://relay.example/' },
    mimeType: 'video/webm;codecs=vp8,opus',
    ...overrides,
  };
}
function harness() {
  const microphone = {
    kind: 'audio',
    stop: vi.fn(),
    enabled: true,
    onended: null,
    getSettings: () => ({ deviceId: 'mic-1' }),
  };
  const camera = {
    kind: 'video',
    stop: vi.fn(),
    enabled: true,
    onended: null,
    getSettings: () => ({}),
  };
  const stream = new MediaStream([microphone, camera] as unknown as MediaStreamTrack[]);
  const connection: CallConnection = {
    send: vi.fn().mockResolvedValue(undefined),
    recv: vi
      .fn()
      .mockResolvedValueOnce(new Uint8Array([2]))
      .mockImplementation(() => new Promise(() => {})),
    close: vi.fn(),
  };
  const endpoint: CallEndpoint = {
    online: vi.fn().mockResolvedValue(undefined),
    id: () => 'd'.repeat(64),
    relay_url: () => 'https://relay.example/',
    connect: vi.fn().mockResolvedValue(connection),
    accept: vi.fn().mockResolvedValue(connection),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const stopRecording = vi.fn();
  const receiver = { url: 'blob:remote', append: vi.fn(), close: vi.fn() };
  const deps = {
    sendSignal: vi.fn().mockResolvedValue(undefined),
    getOwnPubkey: () => own,
    resolvePeer: vi.fn().mockResolvedValue({ name: 'Alice' }),
    supported: vi.fn(() => true),
    otherCallBusy: vi.fn(() => false),
    createEndpoint: vi.fn().mockResolvedValue(endpoint),
    getMedia: vi
      .fn()
      .mockImplementation(async (mode: string) =>
        mode === 'video' ? stream : new MediaStream([microphone] as unknown as MediaStreamTrack[])
      ),
    getMicrophone: vi
      .fn()
      .mockResolvedValue(new MediaStream([microphone] as unknown as MediaStreamTrack[])),
    getCamera: vi
      .fn()
      .mockResolvedValue(new MediaStream([camera] as unknown as MediaStreamTrack[])),
    getScreen: vi
      .fn()
      .mockResolvedValue(new MediaStream([camera] as unknown as MediaStreamTrack[])),
    unlockPlayback: vi.fn(),
    createReceiver: vi.fn(() => receiver),
    record: vi.fn(() => stopRecording),
  };
  const runtime = createCallRuntime(deps);
  return {
    runtime,
    deps,
    endpoint,
    connection,
    microphone,
    camera,
    stream,
    receiver,
    stopRecording,
  };
}
const runtimes: ReturnType<typeof createCallRuntime>[] = [];
function setup() {
  const h = harness();
  runtimes.push(h.runtime);
  return h;
}
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => {
    runtime.reset();
  });
  vi.useRealTimers();
});

describe('call negotiation and lifetime', () => {
  it('reports busy during a room only to eligible contacts and deduplicates the invitation', async () => {
    const h = setup();
    h.deps.otherCallBusy.mockReturnValue(true);
    h.deps.resolvePeer.mockResolvedValueOnce(null);
    await h.runtime.receiveSignal(peer, invite());
    expect(h.deps.sendSignal).not.toHaveBeenCalled();
    const offer = invite();
    await h.runtime.receiveSignal(peer, offer);
    await h.runtime.receiveSignal(peer, offer);
    expect(h.deps.sendSignal).toHaveBeenCalledOnce();
    expect(h.deps.sendSignal).toHaveBeenCalledWith(
      peer,
      expect.objectContaining({ reason: 'busy', action: 'end' })
    );
    expect(h.deps.getMedia).not.toHaveBeenCalled();
  });
  it('waits for peer acceptance and a confirmed Iroh connection before sending media', async () => {
    const h = setup();
    await h.runtime.start(peer, 'video');
    const sent = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    expect(sent.action).toBe('invite');
    expect(h.runtime.session.value?.phase).toBe('outgoing');
    expect(h.deps.record).not.toHaveBeenCalled();
    const acceptance = {
      ...sent,
      action: 'accept' as const,
      mediaVersion: undefined,
      address: { id: 'c'.repeat(64), relayUrl: 'https://relay.example/' },
    };
    await h.runtime.receiveSignal('f'.repeat(64), acceptance);
    await h.runtime.receiveSignal(peer, { ...acceptance, callId: crypto.randomUUID() });
    await h.runtime.receiveSignal(peer, { ...acceptance, mode: 'audio' });
    expect(h.endpoint.connect).not.toHaveBeenCalled();
    await h.runtime.receiveSignal(peer, acceptance);
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    expect(h.endpoint.connect).toHaveBeenCalledWith(
      'c'.repeat(64),
      'https://relay.example/',
      sent.callId
    );
    expect(h.connection.send).toHaveBeenCalledWith(new Uint8Array([2]));
    expect(h.deps.record).toHaveBeenCalledOnce();
    h.runtime.toggleMicrophone();
    h.runtime.toggleCamera();
    expect(h.microphone.enabled).toBe(false);
    expect(h.camera.enabled).toBe(false);
    h.runtime.toggleMicrophone();
    h.runtime.toggleCamera();
    expect(h.microphone.enabled).toBe(true);
    expect(h.camera.enabled).toBe(true);
    h.runtime.end();
    expect(h.stopRecording).toHaveBeenCalledOnce();
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.receiver.close).toHaveBeenCalledOnce();
    expect(h.runtime.localStream.value).toBeNull();
    expect(h.runtime.session.value?.endReason).toBe('hangup');
  });
  it('declines incoming calls without opening devices, and ignores a replay', async () => {
    const h = setup();
    const offer = invite();
    await Promise.all([h.runtime.receiveSignal(peer, offer), h.runtime.receiveSignal(peer, offer)]);
    expect(h.runtime.session.value?.phase).toBe('incoming');
    expect(h.deps.getMedia).not.toHaveBeenCalled();
    h.runtime.end();
    expect(h.deps.sendSignal).toHaveBeenCalledWith(
      peer,
      expect.objectContaining({ action: 'end', reason: 'declined' })
    );
    h.runtime.dismiss();
    await h.runtime.receiveSignal(peer, offer);
    expect(h.runtime.session.value).toBeNull();
  });
  it('accepts exactly once and pins the caller endpoint', async () => {
    const h = setup();
    const offer = invite();
    await h.runtime.receiveSignal(peer, offer);
    await Promise.all([h.runtime.accept(), h.runtime.accept()]);
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    expect(h.deps.getMedia).toHaveBeenCalledOnce();
    expect(h.endpoint.accept).toHaveBeenCalledWith(offer.address?.id, offer.callId);
    expect(h.deps.sendSignal).toHaveBeenCalledWith(
      peer,
      expect.objectContaining({ action: 'accept' })
    );
  });
  it('returns busy for a second caller without replacing the existing call', async () => {
    const h = setup();
    const first = invite();
    const second = invite();
    await h.runtime.receiveSignal(peer, first);
    await h.runtime.receiveSignal('c'.repeat(64), second);
    expect(h.runtime.session.value?.id).toBe(first.callId);
    expect(h.deps.sendSignal).toHaveBeenCalledWith(
      'c'.repeat(64),
      expect.objectContaining({ callId: second.callId, reason: 'busy' })
    );
  });
  it('times out unanswered calls and closes devices and endpoints', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.runtime.start(peer, 'video');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'ringing' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.runtime.session.value?.endReason).toBe('timeout');
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.endpoint.close).toHaveBeenCalledOnce();
  });
  it('closes a late permission result after cancellation and reserves rapid clicks', async () => {
    const h = setup();
    let complete: (stream: MediaStream) => void = () => {};
    h.deps.getMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = h.runtime.start(peer, 'video');
    await Promise.resolve();
    await h.runtime.start(peer, 'video');
    h.runtime.end();
    complete(h.stream);
    await pending;
    expect(h.deps.getMedia).toHaveBeenCalledOnce();
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.deps.createEndpoint).not.toHaveBeenCalled();
  });
  it('never revives an incoming call after logout during contact lookup', async () => {
    const h = setup();
    let complete: (value: { name: string }) => void = () => {};
    h.deps.resolvePeer.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = h.runtime.receiveSignal(peer, invite());
    h.runtime.reset();
    complete({ name: 'Alice' });
    await pending;
    expect(h.runtime.session.value).toBeNull();
  });
  it('uses a fresh call ID and endpoint for each attempt', async () => {
    const h = setup();
    await h.runtime.start(peer, 'audio');
    const first = h.runtime.session.value?.id;
    h.runtime.end();
    await h.runtime.start(peer, 'audio');
    expect(h.runtime.session.value?.id).not.toBe(first);
    expect(h.deps.createEndpoint).toHaveBeenCalledTimes(2);
  });

  it('uses the graceful QUIC reason when the peer hangs up before its Nostr end arrives', async () => {
    const h = setup();
    h.connection.end_reason = () => 'hangup';
    vi.mocked(h.connection.recv).mockReset().mockRejectedValue(new Error('Connection closed'));
    await h.runtime.start(peer, 'video');
    const sent = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...sent, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.endReason).toBe('hangup'));
    expect(h.runtime.error.value).toBe('');
    expect(h.microphone.stop).toHaveBeenCalledOnce();
  });

  it('aborts malformed media frames and releases devices', async () => {
    const h = setup();
    vi.mocked(h.connection.recv)
      .mockReset()
      .mockResolvedValue(new Uint8Array([9]));
    await h.runtime.start(peer, 'video');
    const sent = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...sent, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.endReason).toBe('failed'));
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.deps.record).not.toHaveBeenCalled();
  });
  it('ignores an invite delivered after its cancellation', async () => {
    const h = setup();
    const offer = invite();
    await h.runtime.receiveSignal(peer, { ...offer, action: 'end', reason: 'cancelled' });
    await h.runtime.receiveSignal(peer, offer);
    expect(h.runtime.session.value).toBeNull();
  });
  it('does not capture media for unsupported targets, self calls or untrusted contacts', async () => {
    const h = setup();
    await h.runtime.start(own, 'audio');
    expect(h.deps.getMedia).not.toHaveBeenCalled();
    h.deps.supported.mockReturnValue(false);
    await h.runtime.start(peer, 'video');
    expect(h.runtime.error.value).toBe('call.error.unsupported');
    h.deps.supported.mockReturnValue(true);
    h.deps.resolvePeer.mockResolvedValue(null);
    await h.runtime.start(peer, 'video');
    expect(h.deps.getMedia).not.toHaveBeenCalled();
  });
  it('ends negotiation after ten seconds without a matching custom DM', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal('f'.repeat(64), { ...offer, action: 'ringing' });
    await h.runtime.receiveSignal(peer, {
      ...offer,
      action: 'ringing',
      callId: crypto.randomUUID(),
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.runtime.session.value?.phase).toBe('outgoing');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.runtime.session.value?.endReason).toBe('unsupported');
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.endpoint.close).toHaveBeenCalledOnce();
    await h.runtime.receiveSignal(peer, { ...offer, action: 'ringing' });
    expect(h.runtime.session.value?.phase).toBe('ended');
  });
  it('acknowledges an incoming invite before any device permission request', async () => {
    const h = setup();
    await h.runtime.receiveSignal(peer, invite({ mediaVersion: 2, videoSupported: true }));
    expect(h.deps.sendSignal).toHaveBeenCalledWith(
      peer,
      expect.objectContaining({ action: 'ringing', mediaVersion: 2 })
    );
    expect(h.deps.sendSignal.mock.calls[0]?.[1].address).toBeUndefined();
    expect(h.deps.getMedia).not.toHaveBeenCalled();
    expect(h.deps.createEndpoint).not.toHaveBeenCalled();
  });
  it('keeps ringing after a timely acknowledgement without requiring an answer within ten seconds', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'ringing' });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(h.runtime.session.value?.phase).toBe('outgoing');
    expect(h.runtime.session.value?.peerConfirmed).toBe(true);
  });
  it('reports actual capture denial without sending an invitation or implying a codec failure', async () => {
    const h = setup();
    h.deps.getMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await h.runtime.start(peer, 'audio');
    expect(h.runtime.error.value).toBe('call.error.permission');
    expect(h.deps.sendSignal).not.toHaveBeenCalled();
    expect(h.deps.createEndpoint).not.toHaveBeenCalled();
  });
  it('switches microphone while preserving mute and video, with an ordered audio reset', async () => {
    const h = setup();
    await h.runtime.start(peer, 'video');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    const microphone = {
      kind: 'audio',
      enabled: true,
      stop: vi.fn(),
      onended: null,
      getSettings: () => ({ deviceId: 'mic-2' }),
    };
    h.deps.getMicrophone.mockResolvedValue(
      new MediaStream([microphone] as unknown as MediaStreamTrack[])
    );
    h.runtime.toggleMicrophone();
    await h.runtime.selectMicrophone('mic-2');
    expect(h.deps.getMicrophone).toHaveBeenCalledWith('mic-2');
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(microphone.enabled).toBe(false);
    expect(h.camera.stop).not.toHaveBeenCalled();
    expect(h.runtime.localStream.value?.getVideoTracks()).toEqual([h.camera]);
    expect(h.runtime.microphoneDeviceId.value).toBe('mic-2');
    expect(h.connection.send).toHaveBeenCalledWith(new Uint8Array([4]));
    expect(h.runtime.session.value?.phase).toBe('active');
  });
  it('keeps the original microphone when a new input cannot be opened', async () => {
    const h = setup();
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    h.deps.getMicrophone.mockRejectedValue(new DOMException('Busy', 'NotReadableError'));
    await h.runtime.selectMicrophone('busy-device');
    expect(h.runtime.deviceError.value).toBe('call.error.deviceBusy');
    expect(h.runtime.error.value).toBe('');
    expect(h.microphone.stop).not.toHaveBeenCalled();
    expect(h.runtime.session.value?.phase).toBe('active');
  });
  it('adds and removes video in an audio call without stopping its audio recorder', async () => {
    const h = setup();
    const audioStop = vi.fn(),
      videoStop = vi.fn();
    h.deps.record.mockReturnValueOnce(audioStop).mockReturnValue(videoStop);
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    const url = h.runtime.remoteMediaUrl.value;
    await h.runtime.toggleCamera();
    expect(h.runtime.localStream.value?.getVideoTracks()).toEqual([h.camera]);
    expect(h.runtime.session.value?.cameraMuted).toBe(false);
    expect(h.deps.getCamera).toHaveBeenCalledOnce();
    expect(h.connection.send).toHaveBeenCalledWith(new Uint8Array([5, 1]));
    await h.runtime.toggleCamera();
    expect(h.camera.stop).toHaveBeenCalledOnce();
    expect(h.runtime.localStream.value?.getVideoTracks()).toEqual([]);
    expect(h.connection.send).toHaveBeenCalledWith(new Uint8Array([5, 0]));
    expect(videoStop).toHaveBeenCalledOnce();
    expect(audioStop).not.toHaveBeenCalled();
    expect(h.runtime.remoteMediaUrl.value).toBe(url);
    expect(h.runtime.session.value?.phase).toBe('active');
  });
  it('leaves audio working when camera permission is rejected', async () => {
    const h = setup();
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    h.deps.getCamera.mockRejectedValue(new DOMException('Camera denied', 'NotAllowedError'));
    await h.runtime.toggleCamera();
    expect(h.runtime.session.value?.phase).toBe('active');
    expect(h.runtime.deviceError.value).toBe('call.error.permission');
    expect(h.microphone.stop).not.toHaveBeenCalled();
    expect(h.runtime.localStream.value?.getVideoTracks()).toEqual([]);
  });
  it('stops a late camera acquisition after hangup', async () => {
    const h = setup();
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'accept' });
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    let complete: (value: MediaStream) => void = () => {};
    h.deps.getCamera.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = h.runtime.toggleCamera();
    h.runtime.end();
    complete(new MediaStream([h.camera] as unknown as MediaStreamTrack[]));
    await pending;
    expect(h.camera.stop).toHaveBeenCalledOnce();
    expect(h.runtime.localStream.value).toBeNull();
    expect(h.runtime.session.value?.phase).toBe('ended');
  });
  it('receives independent audio resets and video state without resetting the call', async () => {
    const h = setup();
    h.deps.createReceiver.mockImplementation(() => ({
      url: `blob:${crypto.randomUUID()}`,
      append: vi.fn(),
      close: vi.fn(),
    }));
    vi.mocked(h.connection.recv)
      .mockReset()
      .mockResolvedValueOnce(new Uint8Array([2]))
      .mockResolvedValueOnce(new Uint8Array([4]))
      .mockResolvedValueOnce(new Uint8Array([5, 1]))
      .mockResolvedValueOnce(new Uint8Array([3, 12]))
      .mockResolvedValueOnce(new Uint8Array([5, 0]))
      .mockImplementation(() => new Promise(() => {}));
    await h.runtime.start(peer, 'audio');
    const offer = h.deps.sendSignal.mock.calls[0]?.[1] as CallSignal;
    await h.runtime.receiveSignal(peer, { ...offer, action: 'accept' });
    await vi.waitFor(() => expect(h.deps.createReceiver).toHaveBeenCalledTimes(3));
    const original = h.deps.createReceiver.mock.results[0]?.value;
    const audio = h.deps.createReceiver.mock.results[1]?.value;
    const video = h.deps.createReceiver.mock.results[2]?.value;
    expect(original.close).toHaveBeenCalledOnce();
    expect(audio.close).not.toHaveBeenCalled();
    expect(video.append).toHaveBeenCalledWith(new Uint8Array([12]));
    expect(video.close).toHaveBeenCalledOnce();
    expect(h.runtime.remoteMediaUrl.value).toBe(audio.url);
    expect(h.runtime.remoteVideoUrl.value).toBe('');
    expect(h.runtime.session.value?.phase).toBe('active');
  });
});

describe('answer mode and independent screen sharing', () => {
  it('answers a video invitation without opening a camera when audio is chosen', async () => {
    const h = setup();
    await h.runtime.receiveSignal(peer, invite({ mediaVersion: 2, videoSupported: true }));
    await h.runtime.accept('audio');
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    expect(h.deps.getMedia).toHaveBeenCalledWith('audio', '');
    expect(h.runtime.localStream.value?.getVideoTracks()).toHaveLength(0);
    expect(h.runtime.session.value?.cameraMuted).toBe(true);
    expect(h.runtime.session.value?.mode).toBe('video');
  });
  it('shares a separate screen container and stops it without ending audio', async () => {
    const h = setup();
    await h.runtime.receiveSignal(
      peer,
      invite({ mediaVersion: 2, videoSupported: true, screenSupported: true })
    );
    await h.runtime.accept('audio');
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    await h.runtime.startScreenSharing();
    expect(h.runtime.localScreenStream.value?.getVideoTracks()).toHaveLength(1);
    expect(h.connection.send).toHaveBeenCalledWith(new Uint8Array([7, 1]));
    expect(h.deps.record).toHaveBeenCalledTimes(2);
    await h.runtime.stopScreenSharing();
    expect(h.connection.send).toHaveBeenCalledWith(new Uint8Array([7, 0]));
    expect(h.runtime.session.value?.phase).toBe('active');
    expect(h.microphone.stop).not.toHaveBeenCalled();
    expect(h.runtime.localScreenStream.value).toBeNull();
  });
  it('does not send screen frames to a peer without the screen capability', async () => {
    const h = setup();
    await h.runtime.receiveSignal(peer, invite({ mediaVersion: 2, videoSupported: true }));
    await h.runtime.accept('audio');
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    await h.runtime.startScreenSharing();
    expect(h.deps.getScreen).not.toHaveBeenCalled();
  });
  it('stops screen capture that resolves after a hangup', async () => {
    const h = setup();
    let finishCapture: (stream: MediaStream) => void = () => {};
    h.deps.getScreen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        })
    );
    await h.runtime.receiveSignal(
      peer,
      invite({ mediaVersion: 2, videoSupported: true, screenSupported: true })
    );
    await h.runtime.accept('audio');
    await vi.waitFor(() => expect(h.runtime.session.value?.phase).toBe('active'));
    const acquiring = h.runtime.startScreenSharing();
    h.runtime.end();
    finishCapture(new MediaStream([h.camera] as unknown as MediaStreamTrack[]));
    await acquiring;
    expect(h.camera.stop).toHaveBeenCalled();
    expect(h.runtime.localScreenStream.value).toBeNull();
  });
});
