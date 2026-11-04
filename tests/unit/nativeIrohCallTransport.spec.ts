import { beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { createNativeCallEndpoint } from '#src/services/nativeIrohCallTransport.ts';

const packet = (sequence: number) => {
  const bytes = new Uint8Array(15);
  bytes.set([9, 1]);
  bytes[14] = sequence;
  return bytes;
};
const batch = (...packets: Uint8Array[]) => {
  const bytes = new Uint8Array(packets.reduce((n, p) => n + 2 + p.length, 0));
  let offset = 0;
  for (const p of packets) {
    new DataView(bytes.buffer).setUint16(offset, p.length);
    bytes.set(p, offset + 2);
    offset += p.length + 2;
  }
  return bytes.buffer;
};
let receive: () => Promise<ArrayBuffer>;
beforeEach(() => {
  invoke.mockReset();
  receive = async () => batch(packet(1), packet(2), packet(3), packet(4));
  invoke.mockImplementation(async (_command, { operation }) => {
    if (operation === 'create') return { handle: 1, id: 'peer' };
    if (operation === 'connect') return { handle: 2 };
    if (operation === 'recvAudio') return receive();
    if (operation === 'stats') return { relayOnly: true, rttMs: 4, paths: 1 };
  });
});
const connect = async () => {
  const endpoint = await createNativeCallEndpoint(['https://relay.example/']);
  return endpoint.connect('peer', 'https://relay.example/', crypto.randomUUID(), true);
};
it('sends media as binary IPC with the scoped session and handle', async () => {
  const connection = await connect();
  const frame = new Uint8Array([3, 0, 255]);
  await connection.send(frame);
  await connection.sendAudio!(packet(1));
  const sends = invoke.mock.calls.filter(([command]) => command === 'iroh_call_send');
  expect(sends).toHaveLength(2);
  expect(sends[0][1]).toBe(frame);
  expect(sends[0][2].headers).toMatchObject({ 'x-call-connection': '2', 'x-call-audio': '0' });
  expect(sends[0][2].headers['x-call-session']).toHaveLength(36);
  expect(sends[1][2].headers['x-call-audio']).toBe('1');
  connection.close();
});
it('drains a bounded native audio batch without one IPC round trip per packet', async () => {
  const connection = await connect();
  for (let i = 1; i <= 4; i++) await expect(connection.recvAudio!()).resolves.toEqual(packet(i));
  expect(invoke.mock.calls.filter(([, args]) => args.operation === 'recvAudio')).toHaveLength(1);
  await expect(connection.transportStats!()).resolves.toMatchObject({ relayOnly: true });
  connection.close();
  await expect(connection.recvAudio!()).rejects.toThrow('closed');
});
it.each([
  new ArrayBuffer(0),
  new ArrayBuffer(4409),
  batch(packet(1), packet(2), packet(3), packet(4), packet(5)),
  new Uint8Array([0, 15, 9]).buffer,
  batch(new Uint8Array(15)),
])('rejects malformed native audio batches', async (bytes) => {
  receive = async () => bytes;
  const connection = await connect();
  await expect(connection.recvAudio!()).rejects.toThrow('Invalid audio');
  connection.close();
});
it('discards an in-flight audio batch after hangup', async () => {
  let resolve!: (value: ArrayBuffer) => void;
  receive = () =>
    new Promise((yes) => {
      resolve = yes;
    });
  const connection = await connect();
  const pending = connection.recvAudio!();
  connection.close();
  resolve(batch(packet(1)));
  await expect(pending).rejects.toThrow('closed');
});
