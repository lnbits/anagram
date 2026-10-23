import { callCaptureTrack } from '#src/services/callSharedCapture.ts';
import { createCallRoomRuntime } from '#src/stores/nostr/callRoomRuntime.svelte.ts';
import {
  type CallRoomLink,
  type CallRoomMember,
  type CallRoomSignal,
  ROOM_PROTOCOL,
} from '#src/types/callRoom.ts';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

class Track {
  enabled = true;
  readyState = 'live';
  onended: (() => void) | null = null;
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(public kind: string) {}
  clone() {
    const copy = new Track(this.kind);
    copy.enabled = this.enabled;
    return copy;
  }
  getSettings() {
    return { deviceId: this.kind };
  }
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  clone() {
    return new Stream(this.tracks.map((track) => track.clone()));
  }
}
vi.stubGlobal('MediaStream', Stream);
const runtimes: ReturnType<typeof createCallRoomRuntime>[] = [];
function setup(own = 'a'.repeat(64)) {
  const microphone = new Track('audio');
  const stream = new MediaStream([microphone] as unknown as MediaStreamTrack[]);
  const deps = {
    getOwnPubkey: () => own,
    getIdentity: async () => ({ name: 'Alice', relays: ['wss://relay.example'] }),
    isBlocked: vi.fn(() => false),
    otherCallBusy: vi.fn(() => false),
    send: vi.fn().mockResolvedValue(undefined),
    media: {
      supported: () => true,
      getScreen: vi.fn<() => Promise<MediaStream>>(),
      getMedia: vi.fn().mockResolvedValue(stream),
      acquireAudioRoute: vi.fn<() => Promise<() => void>>().mockResolvedValue(vi.fn()),
      getMicrophone: vi.fn().mockResolvedValue(stream),
      getCamera: vi
        .fn()
        .mockResolvedValue(new MediaStream([new Track('video')] as unknown as MediaStreamTrack[])),
      createEndpoint: vi.fn(async () => ({
        id: () => 'a'.repeat(64),
        relay_url: () => 'https://relay.example/',
        online: async () => {},
        close: vi.fn().mockResolvedValue(undefined),
        connect: () => new Promise<never>(() => {}),
        accept: () => new Promise<never>(() => {}),
      })),
      createReceiver: () => ({ url: 'blob:media', append: vi.fn(), close: vi.fn() }),
      record: vi.fn(() => vi.fn()),
    },
  };
  const runtime = createCallRoomRuntime(deps);
  runtimes.push(runtime);
  return { runtime, deps, microphone, stream };
}
function signal(link: CallRoomLink, body: Partial<CallRoomSignal>): CallRoomSignal {
  return {
    protocol: ROOM_PROTOCOL,
    action: 'leave',
    roomId: link.id,
    senderSession: link.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...body,
  };
}
function join(link: CallRoomLink, pubkey = 'b'.repeat(64)): CallRoomSignal {
  const member: CallRoomMember = {
    pubkey,
    sessionId: crypto.randomUUID(),
    name: 'Guest',
    relays: ['wss://guest.example'],
  };
  return signal(link, {
    action: 'join',
    senderSession: member.sessionId,
    member,
    secret: link.secret,
  });
}
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => {
    runtime.reset();
  });
  vi.useRealTimers();
});

describe('link-based Iroh call rooms', () => {
  it('owns one audio route for the room and releases a late setup after leave', async () => {
    const h = setup(),
      release = vi.fn();
    h.deps.media.acquireAudioRoute.mockResolvedValueOnce(release);
    await h.runtime.create();
    await h.runtime.receive('b'.repeat(64), join(h.runtime.session!.link));
    expect(h.deps.media.acquireAudioRoute).toHaveBeenCalledTimes(1);
    h.runtime.leave();
    h.runtime.reset();
    expect(release).toHaveBeenCalledTimes(1);
    let finish!: (release: () => void) => void;
    h.deps.media.acquireAudioRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const starting = h.runtime.create();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    h.runtime.leave();
    const lateRelease = vi.fn();
    finish(lateRelease);
    await starting;
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(h.runtime.localStream).toBeNull();
  });
  it.each(['stop', 'leave'])(
    'discards a pending screen picker after %s and allows another share',
    async (action) => {
      const h = setup();
      await h.runtime.create();
      let resolve!: (stream: MediaStream) => void;
      h.deps.media.getScreen.mockImplementationOnce(
        () =>
          new Promise((yes) => {
            resolve = yes;
          }),
      );
      const pending = h.runtime.startScreenSharing();
      if (action === 'leave') {
        h.runtime.leave();
        await h.runtime.create();
      } else await h.runtime.stopScreenSharing();
      const newTrack = new Track('video');
      const current = new MediaStream([newTrack] as unknown as MediaStreamTrack[]);
      h.deps.media.getScreen.mockResolvedValueOnce(current);
      await h.runtime.startScreenSharing();
      const oldTrack = new Track('video');
      resolve(new MediaStream([oldTrack] as unknown as MediaStreamTrack[]));
      await pending;
      expect(h.runtime.localScreenStream).toBe(current);
      expect(oldTrack.stop).toHaveBeenCalledOnce();
      expect(newTrack.stop).not.toHaveBeenCalled();
    },
  );
  it('selects cameras without unmuting and replaces capture without stopping the microphone', async () => {
    const h = setup();
    await h.runtime.create();
    await h.runtime.selectCamera('camera-2');
    expect(h.deps.media.getCamera).not.toHaveBeenCalled();
    expect(h.runtime.cameraMuted).toBe(true);
    await h.runtime.toggleCamera();
    expect(h.deps.media.getCamera).toHaveBeenLastCalledWith('camera-2');
    const previous = h.runtime.localStream?.getVideoTracks()[0];
    h.deps.media.getCamera.mockRejectedValueOnce(new DOMException('Busy', 'NotReadableError'));
    await h.runtime.selectCamera('busy');
    expect(previous?.stop).not.toHaveBeenCalled();
    const camera = new Track('video');
    camera.getSettings = () => ({ deviceId: 'camera-3' });
    h.deps.media.getCamera.mockResolvedValueOnce(
      new MediaStream([camera] as unknown as MediaStreamTrack[]),
    );
    await h.runtime.selectCamera('camera-3');
    expect(previous?.stop).toHaveBeenCalledOnce();
    expect(h.runtime.cameraDeviceId).toBe('camera-3');
    expect(h.microphone.stop).not.toHaveBeenCalled();
    expect(h.runtime.busy).toBe(true);
  });
  it('reserves one room and captures input only once, then closes all tracks', async () => {
    const h = setup();
    await Promise.all([h.runtime.create(), h.runtime.create()]);
    expect(h.deps.media.getMedia).toHaveBeenCalledOnce();
    expect(h.runtime.session?.phase).toBe('active');
    expect(h.runtime.session?.link.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.runtime.session?.members).toHaveLength(1);
    h.runtime.leave();
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.runtime.localStream).toBeNull();
  });
  it('shares each participant’s own chosen name through join and roster controls', async () => {
    const host = setup();
    const guest = setup('b'.repeat(64));
    host.deps.getIdentity = async () => ({
      name: 'Host chosen name',
      relays: ['wss://relay.example'],
    });
    guest.deps.getIdentity = async () => ({
      name: 'Guest chosen name',
      relays: ['wss://relay.example'],
    });
    await host.runtime.create();
    const link = host.runtime.session!.link;
    await guest.runtime.join(link);
    const request = guest.deps.send.mock.calls.find(([, body]) => body.action === 'join')![1];
    expect(request.member.name).toBe('Guest chosen name');
    expect(Object.keys(request.member).sort()).toEqual(['name', 'pubkey', 'relays', 'sessionId']);
    await host.runtime.receive('b'.repeat(64), request);
    const roster = host.deps.send.mock.calls.find(([, body]) => body.action === 'roster')![1];
    await guest.runtime.receive(link.host, roster);
    expect(host.runtime.session!.members.map((member) => member.name)).toEqual([
      'Host chosen name',
      'Guest chosen name',
    ]);
    expect(guest.runtime.session!.members).toEqual(host.runtime.session!.members);
    expect(JSON.stringify(roster)).not.toContain('css');
  });
  it.each([false, true])(
    'creates a unique room after leaving (dismiss: %s) and rejects old invitations',
    async (dismiss) => {
      const h = setup();
      await h.runtime.create();
      const first = h.runtime.session!.link;
      const oldJoin = join(first);
      h.runtime.leave();
      if (dismiss) h.runtime.dismiss();
      // A new getUserMedia request returns fresh tracks, not the stopped first stream.
      h.deps.media.getMedia.mockResolvedValueOnce(
        new MediaStream([new Track('audio')] as unknown as MediaStreamTrack[]),
      );
      await h.runtime.create();
      expect(h.runtime.session!.phase).toBe('active');
      const second = h.runtime.session!.link;
      expect(second.id).not.toBe(first.id);
      expect(second.secret).not.toBe(first.secret);
      expect(h.runtime.session!.own.sessionId).not.toBe(first.id);
      await h.runtime.receive('b'.repeat(64), oldJoin);
      expect(h.runtime.session!.members).toHaveLength(1);
      await h.runtime.receive('b'.repeat(64), { ...join(second), secret: first.secret });
      expect(h.runtime.session!.members).toHaveLength(1);
      await h.runtime.receive('b'.repeat(64), join(second));
      expect(h.runtime.session!.members).toHaveLength(2);
    },
  );
  it('shares live host and guest name edits without restarting media or accepting stale/spoofed edits', async () => {
    const host = setup(),
      guest = setup('b'.repeat(64)),
      observer = setup('c'.repeat(64));
    await host.runtime.create();
    const link = host.runtime.session!.link;
    for (const user of [guest, observer]) {
      await user.runtime.join(link);
      await host.runtime.receive(
        user.deps.getOwnPubkey(),
        user.deps.send.mock.calls.find(([, body]) => body.action === 'join')![1],
      );
    }
    const deliverRosters = async () => {
      for (const user of [guest, observer]) {
        const call = host.deps.send.mock.calls
          .filter(([to, body]) => to === user.deps.getOwnPubkey() && body.action === 'roster')
          .at(-1)!;
        await user.runtime.receive(link.host, call[1]);
      }
    };
    await deliverRosters();
    await vi.waitFor(() => expect(host.deps.media.createEndpoint).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(guest.deps.media.createEndpoint).toHaveBeenCalledTimes(1));
    const endpointCounts = [host, guest, observer].map(
      (user) => user.deps.media.createEndpoint.mock.calls.length,
    );
    const streams = [host, guest, observer].map((user) => user.runtime.localStream);
    const latestJoin = () =>
      guest.deps.send.mock.calls.filter(([, body]) => body.action === 'join').at(-1)![1];
    await guest.runtime.updateName('Guest first');
    const older = latestJoin();
    await guest.runtime.updateName('Guest latest');
    const latest = latestJoin();
    await host.runtime.receive(guest.deps.getOwnPubkey(), latest);
    await deliverRosters();
    for (const user of [host, observer])
      expect(
        user.runtime.participants.find((member) => member.pubkey === guest.deps.getOwnPubkey())
          ?.name,
      ).toBe('Guest latest');
    expect(guest.runtime.session!.own.name).toBe('Guest latest');
    await host.runtime.receive(guest.deps.getOwnPubkey(), older);
    await host.runtime.receive(observer.deps.getOwnPubkey(), {
      ...latest,
      member: { ...latest.member!, name: 'Spoofed', nameRevision: 100 },
    });
    expect(
      host.runtime.participants.find((member) => member.pubkey === guest.deps.getOwnPubkey())?.name,
    ).toBe('Guest latest');
    await host.runtime.updateName('Host changed');
    await deliverRosters();
    for (const user of [guest, observer])
      expect(user.runtime.participants.find((member) => member.pubkey === link.host)?.name).toBe(
        'Host changed',
      );
    for (const [index, user] of [host, guest, observer].entries()) {
      expect(user.runtime.localStream).toBe(streams[index]);
      expect(user.deps.media.createEndpoint).toHaveBeenCalledTimes(endpointCounts[index]);
      expect(user.deps.media.getMedia).toHaveBeenCalledOnce();
      expect(user.microphone.stop).not.toHaveBeenCalled();
      expect(user.runtime.session!.phase).toBe('active');
    }
  });
  it('ignores a delayed name lookup after leaving the call', async () => {
    const h = setup();
    await h.runtime.create();
    let finish!: (identity: { name: string; relays: string[] }) => void;
    h.deps.getIdentity = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.runtime.updateName('');
    h.runtime.leave();
    finish({ name: 'Too late', relays: ['wss://relay.example'] });
    await pending;
    expect(h.runtime.session!.own.name).toBe('Alice');
    expect(h.runtime.session!.phase).toBe('ended');
  });
  it('requires the link secret and authenticated joining identity', async () => {
    const h = setup();
    await h.runtime.create();
    const link = h.runtime.session?.link;
    const request = join(link);
    await h.runtime.receive('b'.repeat(64), { ...request, secret: 'f'.repeat(64) });
    await h.runtime.receive('c'.repeat(64), request);
    expect(h.runtime.session?.members).toHaveLength(1);
    await h.runtime.receive('b'.repeat(64), request);
    expect(h.runtime.session?.members).toHaveLength(2);
    expect(h.deps.send).toHaveBeenCalledWith(
      'b'.repeat(64),
      expect.objectContaining({ action: 'roster', revision: 2 }),
      ['wss://guest.example'],
    );
  });
  it('caps rooms at six members and ignores blocked users even with the link', async () => {
    const h = setup();
    await h.runtime.create();
    const link = h.runtime.session?.link;
    h.deps.isBlocked.mockReturnValueOnce(true);
    await h.runtime.receive('b'.repeat(64), join(link));
    expect(h.runtime.session?.members).toHaveLength(1);
    for (const digit of ['b', 'c', 'd', 'e', 'f'])
      await h.runtime.receive(digit.repeat(64), join(link, digit.repeat(64)));
    const extra = '1'.repeat(64);
    await h.runtime.receive(extra, join(link, extra));
    expect(h.runtime.session?.members).toHaveLength(6);
    expect(h.deps.send).toHaveBeenCalledWith(
      extra,
      expect.objectContaining({ action: 'rejected', reason: 'full' }),
      ['wss://guest.example'],
    );
  });
  it('accepts membership only from the host and ignores older roster revisions', async () => {
    const h = setup('b'.repeat(64));
    const link = {
      id: crypto.randomUUID(),
      host: 'a'.repeat(64),
      secret: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      relays: ['wss://relay.example'],
    };
    await h.runtime.join(link);
    const own = h.runtime.session?.own;
    const host = { pubkey: link.host, sessionId: link.id, name: 'Host', relays: link.relays };
    const roster = signal(link, { action: 'roster', members: [host, own], revision: 2 });
    await h.runtime.receive('d'.repeat(64), roster);
    expect(h.runtime.session?.phase).toBe('joining');
    await h.runtime.receive(link.host, roster);
    expect(h.runtime.session?.phase).toBe('active');
    await h.runtime.receive(link.host, { ...roster, revision: 1, members: [host] });
    expect(h.runtime.session?.phase).toBe('active');
    expect(h.runtime.session?.members).toHaveLength(2);
    await h.runtime.receive(link.host, signal(link, { action: 'closed' }));
    expect(h.runtime.session?.phase).toBe('ended');
    expect(h.microphone.stop).toHaveBeenCalled();
  });
  it('ignores stale joins and departures after a participant rejoins', async () => {
    const h = setup();
    await h.runtime.create();
    const link = h.runtime.session?.link;
    const first = join(link);
    const second = join(link);
    await h.runtime.receive('b'.repeat(64), first);
    await h.runtime.receive('b'.repeat(64), second);
    await h.runtime.receive('b'.repeat(64), first);
    expect(h.runtime.session?.members[1]?.sessionId).toBe(second.senderSession);
    await h.runtime.receive(
      'b'.repeat(64),
      signal(link, { action: 'leave', senderSession: first.senderSession }),
    );
    expect(h.runtime.session?.members).toHaveLength(2);
    await h.runtime.receive(
      'b'.repeat(64),
      signal(link, { action: 'leave', senderSession: second.senderSession }),
    );
    expect(h.runtime.session?.members).toHaveLength(1);
    await h.runtime.receive('b'.repeat(64), second);
    expect(h.runtime.session?.members).toHaveLength(1);
    expect(h.microphone.stop).not.toHaveBeenCalled();
  });
  it('cleans up capture which completes after cancellation', async () => {
    const h = setup();
    let complete: (stream: MediaStream) => void = () => {};
    h.deps.media.getMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const starting = h.runtime.create();
    h.runtime.leave();
    complete(h.stream);
    await starting;
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.runtime.localStream).toBeNull();
    expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('times out joining an offline host and releases media', async () => {
    vi.useFakeTimers();
    const h = setup('b'.repeat(64));
    await h.runtime.join({
      id: crypto.randomUUID(),
      host: 'a'.repeat(64),
      secret: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      relays: ['wss://relay.example'],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runtime.error).toBe('room.error.timeout');
    expect(h.microphone.stop).toHaveBeenCalled();
    expect(h.runtime.busy).toBe(false);
  });
  it('refuses starting a room during another call', async () => {
    const h = setup();
    h.deps.otherCallBusy.mockReturnValue(true);
    await h.runtime.create();
    expect(h.runtime.error).toBe('room.error.busy');
    expect(h.deps.media.getMedia).not.toHaveBeenCalled();
  });
});

it('keeps the room roster while a peer reconnects, and lowers video bitrate as the room grows', async () => {
  const h = setup();
  const connections: Array<{
    send: ReturnType<typeof vi.fn>;
    recv: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  h.deps.media.createEndpoint.mockImplementation(
    async () =>
      ({
        id: () => 'a'.repeat(64),
        relay_url: () => 'https://relay.example/',
        online: async () => {},
        close: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn(async () => {
          const connection = {
            send: vi.fn().mockResolvedValue(undefined),
            close: vi.fn(),
            recv: vi
              .fn()
              .mockResolvedValueOnce(new Uint8Array([2]))
              .mockImplementation(() => new Promise(() => {})),
          };
          connections.push(connection);
          return connection;
        }),
        accept: () => new Promise<never>(() => {}),
      }) as never,
  );
  h.deps.media.getMedia.mockResolvedValueOnce(
    new MediaStream([h.microphone, new Track('video')] as unknown as MediaStreamTrack[]),
  );
  await h.runtime.create('video');
  const link = h.runtime.session!.link;
  for (const pubkey of ['b', 'c', 'd'].map((value) => value.repeat(64))) {
    const request = join(link, pubkey);
    await h.runtime.receive(pubkey, request);
    await vi.waitFor(() =>
      expect(
        h.deps.send.mock.calls.some(
          ([to, body]) => to === pubkey && body.signal?.action === 'invite',
        ),
      ).toBe(true),
    );
    const outgoing = h.deps.send.mock.calls.find(
      ([to, body]) => to === pubkey && body.signal?.action === 'invite',
    )![1];
    await h.runtime.receive(
      pubkey,
      signal(link, {
        action: 'signal',
        senderSession: request.senderSession,
        recipientSession: link.id,
        signal: {
          ...outgoing.signal!,
          action: 'accept',
          mediaVersion: 2,
          reconnectSupported: true,
          videoSupported: true,
        },
      }),
    );
    await vi.waitFor(() =>
      expect(h.runtime.participants.find((item) => item.pubkey === pubkey)?.phase).toBe('active'),
    );
  }
  await vi.waitFor(() =>
    expect(
      h.deps.media.record.mock.calls.filter(
        (args: any[]) => args[4]?.videoBitsPerSecond === 400_000,
      ).length,
    ).toBe(3),
  );
  const roster = h.runtime.session!.members;
  connections[0].send.mockRejectedValue(new Error('Network changed'));
  h.runtime.toggleMicrophone();
  await vi.waitFor(() =>
    expect(h.runtime.participants.some((item) => item.phase === 'reconnecting')).toBe(true),
  );
  expect(h.runtime.session!.members).toEqual(roster);
  expect(h.runtime.session!.phase).toBe('active');
  expect(h.microphone.stop).not.toHaveBeenCalled();
});
describe('room controls while a peer link is down', () => {
  const peer = 'b'.repeat(64);
  async function activeRoom(beforeConfirm?: (h: ReturnType<typeof setup>) => Promise<void>) {
    const h = setup();
    const links: Array<{ send: ReturnType<typeof vi.fn>; drop: () => void }> = [];
    // Holding the camera start frame keeps a peer link busy mid camera change.
    let cameraStart = Promise.resolve();
    h.deps.media.createEndpoint.mockImplementation(
      async () =>
        ({
          id: () => 'a'.repeat(64),
          relay_url: () => 'https://relay.example/',
          online: async () => {},
          close: vi.fn().mockResolvedValue(undefined),
          connect: vi.fn(async () => {
            let fail: (cause: Error) => void = () => {};
            const connection = {
              send: vi.fn(async (frame: Uint8Array) => {
                if (frame[0] === 5 && frame[1] === 1) await cameraStart;
              }),
              close: vi.fn(),
              recv: vi
                .fn()
                .mockResolvedValueOnce(new Uint8Array([2]))
                .mockImplementationOnce(
                  () =>
                    new Promise((_, reject) => {
                      fail = reject;
                    }),
                )
                .mockImplementation(() => new Promise(() => {})),
            };
            links.push({ send: connection.send, drop: () => fail(new Error('Network changed')) });
            return connection;
          }),
          accept: () => new Promise<never>(() => {}),
        }) as never,
    );
    h.deps.media.getCamera.mockImplementation(
      async () => new MediaStream([new Track('video')] as unknown as MediaStreamTrack[]),
    );
    h.deps.media.getMedia.mockResolvedValueOnce(
      new MediaStream([h.microphone, new Track('video')] as unknown as MediaStreamTrack[]),
    );
    await h.runtime.create('video');
    const link = h.runtime.session!.link;
    const request = join(link, peer);
    await h.runtime.receive(peer, request);
    const answer = async (action: string) => {
      let sent: any;
      await vi.waitFor(() => {
        sent = h.deps.send.mock.calls.findLast(
          ([to, body]) => to === peer && body.signal?.action === action,
        )?.[1];
        expect(sent).toBeDefined();
      });
      await h.runtime.receive(
        peer,
        signal(link, {
          action: 'signal',
          senderSession: request.senderSession,
          recipientSession: link.id,
          signal: {
            ...sent.signal,
            action: 'accept',
            mediaVersion: 2,
            reconnectSupported: true,
            videoSupported: true,
          },
        }),
      );
      await vi.waitFor(() => expect(h.runtime.participants[0]?.phase).toBe('active'));
    };
    if (beforeConfirm) {
      await vi.waitFor(() =>
        expect(h.deps.send.mock.calls.some(([, body]) => body.signal?.action === 'invite')).toBe(
          true,
        ),
      );
      await beforeConfirm(h);
    }
    await answer('invite');
    const recorded = (kind: 'audio' | 'video') =>
      h.deps.media.record.mock.calls
        .map((args: any[]) => (args[0] as MediaStream).getTracks()[0] as unknown as Track)
        .filter((track) => track?.kind === kind);
    await vi.waitFor(() => expect(recorded('video')).toHaveLength(1));
    return {
      h,
      recorded,
      lastSends: () => links.at(-1)!.send.mock.calls.map(([frame]) => [...frame]),
      async drop() {
        links.at(-1)!.drop();
        await vi.waitFor(() => expect(h.runtime.participants[0]?.phase).toBe('reconnecting'));
      },
      restore: () => answer('reconnect'),
      holdCameraStart() {
        let release!: () => void;
        cameraStart = new Promise((resolve) => {
          release = resolve;
        });
        return release;
      },
    };
  }
  // Reconnects with the room camera on while the link's own camera is off, and holds
  // the link inside the camera-on it applies on reactivation.
  async function reactivatingWithCamera() {
    const room = await activeRoom();
    await room.drop();
    await room.h.runtime.toggleCamera();
    await room.h.runtime.toggleCamera();
    expect(room.h.runtime.cameraMuted).toBe(false);
    const release = room.holdCameraStart();
    await room.restore();
    await vi.waitFor(() => expect(room.lastSends()).toContainEqual([5, 1]));
    return { ...room, release };
  }

  it('stops the camera clone at once, keeps it off after reconnecting, and can turn it on again', async () => {
    const room = await activeRoom();
    const clone = room.recorded('video')[0];
    await room.drop();
    await room.h.runtime.toggleCamera();
    expect(room.h.runtime.cameraMuted).toBe(true);
    expect(clone.stop).toHaveBeenCalled();
    await room.restore();
    await vi.waitFor(() => expect(room.lastSends()).toContainEqual([2]));
    expect(room.lastSends()).not.toContainEqual([5, 1]);
    expect(room.recorded('video')).toHaveLength(1);
    await room.h.runtime.toggleCamera();
    await vi.waitFor(() => expect(room.recorded('video')).toHaveLength(2));
    expect(room.recorded('video')[1].readyState).toBe('live');
    expect(room.lastSends()).toContainEqual([5, 1]);
  });

  it('applies a camera turned off before the link dropped, and one turned on while it was down', async () => {
    const room = await activeRoom();
    await room.h.runtime.toggleCamera();
    expect(room.lastSends()).toContainEqual([5, 0]);
    await room.drop();
    await room.restore();
    await vi.waitFor(() => expect(room.lastSends()).toContainEqual([2]));
    expect(room.recorded('video')).toHaveLength(1);
    await room.drop();
    await room.h.runtime.toggleCamera();
    expect(room.recorded('video')).toHaveLength(1);
    await room.restore();
    await vi.waitFor(() => expect(room.recorded('video')).toHaveLength(2));
    expect(room.lastSends()).toContainEqual([5, 1]);
  });

  it.each([
    ['while the link is down', true],
    ['before the link drops', false],
  ])('keeps the microphone muted when muted %s, then unmutes normally', async (_, down) => {
    const room = await activeRoom();
    const clone = room.recorded('audio')[0];
    if (down) await room.drop();
    room.h.runtime.toggleMicrophone();
    if (!down) await room.drop();
    expect(room.h.microphone.enabled).toBe(false);
    expect(clone.enabled).toBe(false);
    await room.restore();
    await vi.waitFor(() => expect(room.lastSends()).toContainEqual([8, 1]));
    expect(room.recorded('audio').every((track) => !track.enabled)).toBe(true);
    room.h.runtime.toggleMicrophone();
    expect(clone.enabled).toBe(true);
    expect(room.lastSends()).toContainEqual([8, 0]);
  });

  it('switches the microphone of a link that is down instead of reusing the old input', async () => {
    const room = await activeRoom();
    const previous = room.recorded('audio')[0];
    const replacement = new Track('audio');
    room.h.deps.media.getMicrophone.mockResolvedValueOnce(
      new MediaStream([replacement] as unknown as MediaStreamTrack[]),
    );
    await room.drop();
    await room.h.runtime.selectMicrophone('headset');
    expect(previous.stop).toHaveBeenCalled();
    await room.restore();
    await vi.waitFor(() => expect(room.recorded('audio').length).toBeGreaterThan(1));
    const current = room.recorded('audio').at(-1)!;
    expect(current).not.toBe(previous);
    expect(current.readyState).toBe('live');
  });

  it('turns off a camera clone that a reconnecting link was still turning on', async () => {
    const room = await reactivatingWithCamera();
    await room.h.runtime.toggleCamera();
    expect(room.h.runtime.cameraMuted).toBe(true);
    room.release();
    await vi.waitFor(() => expect(room.recorded('video')).toHaveLength(2));
    await vi.waitFor(() => expect(room.recorded('video')[1].stop).toHaveBeenCalled());
    expect(room.lastSends().findLast(([kind]) => kind === 5)).toEqual([5, 0]);
  });

  it('turns off a camera clone that a link was restarting for a new video quality', async () => {
    const room = await activeRoom();
    const screen = new Track('video');
    room.h.deps.media.getScreen.mockResolvedValue(
      new MediaStream([screen] as unknown as MediaStreamTrack[]),
    );
    const cameras = () =>
      room.recorded('video').filter((track) => callCaptureTrack(track as never) !== screen);
    // Sharing a screen lowers the camera bitrate, so the link restarts its camera.
    const release = room.holdCameraStart();
    const sharing = room.h.runtime.startScreenSharing();
    await vi.waitFor(() => expect(room.lastSends().filter(([kind]) => kind === 5)).toHaveLength(2));
    await room.h.runtime.toggleCamera();
    expect(room.h.runtime.cameraMuted).toBe(true);
    release();
    await sharing;
    await vi.waitFor(() =>
      expect(cameras().every((track) => track.readyState === 'ended')).toBe(true),
    );
    expect(room.lastSends().findLast(([kind]) => kind === 5)).toEqual([5, 0]);
  });

  it('switches the microphone of a link that was busy turning its camera on', async () => {
    const room = await reactivatingWithCamera();
    const previous = room.recorded('audio').at(-1)!;
    const replacement = new Track('audio');
    room.h.deps.media.getMicrophone.mockResolvedValueOnce(
      new MediaStream([replacement] as unknown as MediaStreamTrack[]),
    );
    await room.h.runtime.selectMicrophone('headset');
    expect(room.h.microphone.stop).toHaveBeenCalled();
    room.release();
    await vi.waitFor(() => expect(previous.stop).toHaveBeenCalled());
    const current = room.recorded('audio').at(-1)!;
    expect(callCaptureTrack(current as never)).toBe(replacement);
    expect(current.readyState).toBe('live');
  });

  it('switches the microphone of an outgoing link before the peer confirms the call', async () => {
    const clone = vi.spyOn(Track.prototype, 'clone');
    onTestFinished(() => clone.mockRestore());
    const replacement = new Track('audio');
    let original: Track | undefined;
    const room = await activeRoom(async (h) => {
      original = h.microphone;
      h.deps.media.getMicrophone.mockResolvedValueOnce(
        new MediaStream([replacement] as unknown as MediaStreamTrack[]),
      );
      await h.runtime.selectMicrophone('headset');
    });
    const stale = clone.mock.results
      .filter((_, index) => clone.mock.contexts[index] === original)
      .map(({ value }) => value as Track);
    expect(stale).not.toHaveLength(0);
    expect(stale.every((track) => track.readyState === 'ended')).toBe(true);
    const recorded = room.recorded('audio');
    expect(recorded).not.toHaveLength(0);
    expect(recorded.every((track) => callCaptureTrack(track as never) === replacement)).toBe(true);
  });
});
