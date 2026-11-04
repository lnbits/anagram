import { expect, it, vi } from 'vitest';
import type NostrClient from '#src/lib/nostr/client.ts';
import type { NostrEvent } from '#src/lib/nostr/client.ts';
import { createRatchetIntegration } from '#src/stores/nostr/ratchetIntegration.ts';

const { createRuntime } = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock('#src/stores/nostr/ratchetRuntime.ts', () => ({ createRatchetRuntime: createRuntime }));
vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: { listLatestMessages: vi.fn(async () => ({ rows: [] })) },
}));
vi.mock('#src/services/nostrEventDataService.ts', () => ({
  nostrEventDataService: { upsertEvent: vi.fn() },
}));

it('keeps an explicit encryption choice after registration fails and retries without fallback', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const owner = 'a'.repeat(64),
    peer = 'b'.repeat(64);
  const publish = vi.fn();
  const signer = vi.fn();
  const integration = createRatchetIntegration({
    client: { transport: { publish } } as unknown as NostrClient,
    owner: () => owner,
    signer,
    relays: async () => [],
    receive: async () => {},
  });
  const error = new Error('Device registration conflicted. Try again.');
  createRuntime.mockRejectedValue(error);
  const event: NostrEvent = {
    id: 'c'.repeat(64),
    pubkey: owner,
    kind: 14,
    created_at: 1700000000,
    tags: [['p', peer]],
    content: 'Keep my selected encryption',
  };
  try {
    await expect(integration.setDirectMessageProtocol(peer, 'ndr')).rejects.toThrow(error);
    expect(integration.getDirectMessageProtocol(peer)).toBe('ndr');
    await expect(integration.send(peer, event)).rejects.toThrow(error);
    expect(publish).not.toHaveBeenCalled();
    const runtime = { send: vi.fn(async () => event), close: vi.fn(async () => {}) };
    createRuntime.mockResolvedValue(runtime);
    await expect(integration.send(peer, event)).resolves.toEqual(event);
    expect(runtime.send).toHaveBeenCalledWith(peer, event, expect.any(Function));
    expect(integration.getDirectMessageProtocol(peer)).toBe('ndr');
    expect(publish).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  } finally {
    await integration.close();
    vi.unstubAllGlobals();
  }
});
