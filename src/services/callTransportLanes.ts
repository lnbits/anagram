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
  const pending = new Set<number>();
  const received: Array<Result | undefined> = [];
  let waiting: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let ready = false;
  let closed = false;
  function notify() {
    waiting = undefined;
    wake?.();
    wake = undefined;
  }
  async function readLane(lane: number) {
    pending.add(lane);
    let result: Result;
    try {
      result = { lane, data: await connection.recv_lane(lane) };
    } catch (error) {
      result = { lane, error };
    }
    if (closed) return;
    received[lane] = result;
    notify();
  }
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
      while (!closed) {
        const count = ready ? 4 : 1;
        for (let lane = 0; lane < count; lane++) if (!pending.has(lane)) void readLane(lane);
        // Prefer ready control frames. Each lane keeps just its own read and result.
        // Repeatedly racing media against an idle lane retains every winning frame
        // until that lane settles; packet audio can leave its reliable lane idle forever.
        const result = received.find((entry) => entry !== undefined);
        if (result) {
          received[result.lane] = undefined;
          pending.delete(result.lane);
          if (!result.data) throw result.error;
          if (result.lane === 0 && result.data.length === 1 && result.data[0] === 2) ready = true;
          return result.data;
        }
        waiting ??= new Promise<void>((resolve) => {
          wake = resolve;
        });
        await waiting;
      }
      throw new Error('Call connection closed');
    },
    close(reason) {
      closed = true;
      received.length = 0;
      notify();
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
