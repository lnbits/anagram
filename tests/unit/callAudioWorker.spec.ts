import { afterEach, expect, it, vi } from 'vitest';

vi.mock('libopus-wasm', () => ({
  Application: { Voip: 0 },
  loadLibopus: async () => {},
  createEncoder: async () => ({ encodeFloat: () => new Uint8Array([1]), free() {} }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('retains encoded frames in order while the UI is briefly unable to acknowledge them', async () => {
  const sent = vi.fn();
  vi.stubGlobal('postMessage', sent);
  vi.stubGlobal('onmessage', undefined);
  await import('#src/services/callAudio.worker.ts');
  const dispatch = (data: any) => globalThis.onmessage!({ data } as MessageEvent);
  const port = { onmessage: (_event: any) => {}, postMessage: vi.fn(), close: vi.fn() };
  await dispatch({ type: 'encode', id: 1, generation: 1, port });
  for (let sequence = 0; sequence < 10; sequence++)
    port.onmessage({ data: { sequence, pcm: new Float32Array(960) } });
  expect(sent).toHaveBeenCalledTimes(2);
  expect(port.postMessage).toHaveBeenCalledTimes(10); // UI blockage does not stall capture.
  for (let i = 0; i < 10; i++) await dispatch({ type: 'encoded', id: 1 });
  expect(
    sent.mock.calls.map(([message]) => new DataView(message.packet.buffer).getUint32(6)),
  ).toEqual(Array.from({ length: 10 }, (_, i) => i));
  for (let sequence = 10; sequence < 20; sequence++)
    port.onmessage({ data: { sequence, pcm: new Float32Array(960) } });
  await dispatch({ type: 'close', id: 1 });
  const count = sent.mock.calls.length;
  await dispatch({ type: 'encoded', id: 1 });
  expect(sent).toHaveBeenCalledTimes(count);
  expect(port.close).toHaveBeenCalledOnce();
});
