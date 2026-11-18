import type { CallConnection, CallEndpoint } from '#src/types/call.ts';

export interface RawConnection extends CallConnection {
  stats_json?(): string;
  send_audio?(data: Uint8Array): Promise<void> | void;
  recv_audio?(): Promise<Uint8Array>;
  recv_lane(lane: number): Promise<Uint8Array>;
}
export interface RawCallEndpoint extends CallEndpoint {
  audio_datagrams?(): boolean;
  connect_lanes?(peer: string, relay: string, call: string): Promise<RawConnection>;
  accept_lanes?(peer: string, call: string): Promise<RawConnection>;
}

// Keep one outstanding read per lane. Never cancel a partial length-prefixed read,
// and never drain an unbounded backlog into JavaScript while another lane waits.
export function mergeCallLanes(connection: RawConnection): CallConnection {
  type Result = { lane: number; data?: Uint8Array; error?: unknown };
  const pending: Array<Promise<Result> | undefined> = [];
  let ready = false;
  let closed = false;
  return {
    ...(connection.stats_json
      ? { transportStats: async () => JSON.parse(connection.stats_json!()) }
      : {}),
    ...(connection.transportStats ? { transportStats: () => connection.transportStats!() } : {}),
    ...(connection.send_audio && connection.recv_audio
      ? {
          sendAudio: async (data: Uint8Array) => {
            await connection.send_audio!(data);
          },
          recvAudio: () => connection.recv_audio!(),
        }
      : {}),
    ...(connection.sendAudioBatch ? { sendAudioBatch: connection.sendAudioBatch } : {}),
    send: (data) => connection.send(data),
    async recv() {
      if (closed) throw new Error('Call connection closed');
      const count = ready ? 4 : 1;
      for (let lane = 0; lane < count; lane++) {
        pending[lane] ??= connection.recv_lane(lane).then(
          (data) => ({ lane, data }),
          (error) => ({ lane, error }),
        );
      }
      const result = await Promise.race(pending.slice(0, count));
      if (!result || closed) throw new Error('Call connection closed');
      pending[result.lane] = undefined;
      if (!result.data) throw result.error;
      if (result.lane === 0 && result.data.length === 1 && result.data[0] === 2) ready = true;
      return result.data;
    },
    close(reason) {
      closed = true;
      connection.close(reason);
    },
    end_reason: () => connection.end_reason?.(),
  };
}

export function adaptCallEndpoint(endpoint: RawCallEndpoint): CallEndpoint {
  const multiplexed = Boolean(endpoint.connect_lanes && endpoint.accept_lanes);
  return {
    multiplexed,
    datagrams: endpoint.audio_datagrams?.() === true,
    online: () => endpoint.online(),
    id: () => endpoint.id(),
    relay_url: () => endpoint.relay_url(),
    close: () => endpoint.close(),
    connect: async (peer, relay, call, lanes) =>
      lanes && multiplexed
        ? mergeCallLanes(await endpoint.connect_lanes!(peer, relay, call))
        : endpoint.connect(peer, relay, call),
    accept: async (peer, call, lanes) =>
      lanes && multiplexed
        ? mergeCallLanes(await endpoint.accept_lanes!(peer, call))
        : endpoint.accept(peer, call),
  };
}
