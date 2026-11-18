import { MAX_AUDIO_PACKET_BYTES, MAX_NATIVE_AUDIO_BATCH } from './callAudioPackets.ts';
import { invoke } from '@tauri-apps/api/core';
import { mergeCallLanes, type RawConnection } from './callTransportLanes.ts';
import type { CallEndpoint, CallEndReason } from '#src/types/call.ts';

// Fresh per WebView load. The native side clears orphaned handles after reload.
let clientSession: string;
const command = <T>(operation: string, args: object): Promise<T> =>
  invoke<T>('iroh_call', {
    session: (clientSession ??= crypto.randomUUID()),
    operation,
    args,
  });
function connection(handle: number): RawConnection {
  let reason: string | undefined;
  let closed = false;
  let audio: Uint8Array[] = [];
  let burst = false;
  const send = (data: Uint8Array, lane: '0' | '1' | 'batch') =>
    invoke<void>('iroh_call_send', data, {
      headers: {
        'x-call-session': clientSession,
        'x-call-connection': String(handle),
        'x-call-audio': lane,
      },
    });
  const receive = async (operation: string, args = {}) => {
    try {
      return new Uint8Array(await command<ArrayBuffer>(operation, { connection: handle, ...args }));
    } catch (error) {
      reason = await command<string>('reason', { connection: handle }).catch(() => undefined);
      throw error;
    }
  };
  return {
    transportStats: () => command('stats', { connection: handle }),
    send: (data) => send(data, '0'),
    send_audio: (data) => send(data, '1'),
    async sendAudioBatch(packets) {
      if (
        !packets.length ||
        packets.length > MAX_NATIVE_AUDIO_BATCH ||
        packets.some((p) => p.length <= 14 || p.length > MAX_AUDIO_PACKET_BYTES)
      )
        throw new Error('Invalid audio batch');
      const bytes = new Uint8Array(packets.reduce((n, p) => n + 2 + p.length, 0));
      const view = new DataView(bytes.buffer);
      let offset = 0;
      for (const packet of packets) {
        view.setUint16(offset, packet.length);
        bytes.set(packet, offset + 2);
        offset += 2 + packet.length;
      }
      await send(bytes, 'batch');
    },
    async recv_audio() {
      if (closed) throw new Error('Call connection closed');
      if (!audio.length) {
        // A full read signals a backlog. Drain more available datagrams on the next IPC round trip.
        const limit = burst ? MAX_NATIVE_AUDIO_BATCH : 4;
        const bytes = await receive('recvAudio', { burst });
        if (closed) throw new Error('Call connection closed');
        if (!bytes.length || bytes.length > limit * (MAX_AUDIO_PACKET_BYTES + 2))
          throw new Error('Invalid audio batch');
        const frames: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.length;) {
          if (offset + 2 > bytes.length || frames.length === limit)
            throw new Error('Invalid audio batch');
          const size = (bytes[offset] << 8) | bytes[offset + 1];
          offset += 2;
          if (
            size <= 14 ||
            size > 1100 ||
            offset + size > bytes.length ||
            bytes[offset] !== 9 ||
            bytes[offset + 1] !== 1
          )
            throw new Error('Invalid audio packet');
          frames.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
        burst = frames.length >= 4;
        audio = frames;
      }
      return audio.shift()!;
    },
    recv: () => receive('recv', { lane: 0 }),
    recv_lane: (lane) => receive('recv', { lane }),
    end_reason: () => reason,
    close(value: CallEndReason = 'hangup') {
      closed = true;
      audio = [];
      void command('close', { connection: handle, reason: value }).catch(() => {});
    },
  };
}
export async function createNativeCallEndpoint(relays: string[]): Promise<CallEndpoint> {
  const result = await command<{ handle: number; id: string }>('create', { relays });
  let relay = '';
  const link = async (operation: string, args: object, lanes: boolean) => {
    const result2 = await command<{ handle: number }>(operation, {
      endpoint: result.handle,
      ...args,
      lanes,
    });
    const raw = connection(result2.handle);
    return lanes ? mergeCallLanes(raw) : raw;
  };
  return {
    multiplexed: true,
    datagrams: true,
    id: () => result.id,
    relay_url: () => relay,
    async online() {
      relay = (await command<{ relay: string }>('online', { endpoint: result.handle })).relay;
    },
    connect: (peer, relay, call, lanes = false) => link('connect', { peer, relay, call }, lanes),
    accept: (peer, call, lanes = false) => link('accept', { peer, call }, lanes),
    async close() {
      await command('closeEndpoint', { endpoint: result.handle }).catch(() => {});
    },
  };
}
