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
  const microphone = { stop: vi.fn(), enabled: true, onended: null };
  const camera = { stop: vi.fn(), enabled: true, onended: null };
  const stream = {
    getTracks: () => [microphone, camera],
    getAudioTracks: () => [microphone],
    getVideoTracks: () => [camera],
  } as unknown as MediaStream;
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
    createEndpoint: vi.fn().mockResolvedValue(endpoint),
    getMedia: vi.fn().mockResolvedValue(stream),
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
});
