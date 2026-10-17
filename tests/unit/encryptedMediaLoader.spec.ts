import {
  createEncryptedMediaLoader,
  type EncryptedMediaLoadState,
} from '#src/services/encryptedMediaLoader.ts';
import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import { describe, expect, it, vi } from 'vitest';

const encrypted: MessageAttachmentMetadata = {
  type: 'media',
  url: `https://blossom.example.com/${'a'.repeat(64)}`,
  mimeType: 'video/mp4',
  size: 100,
  sha256: 'a'.repeat(64),
  encryption: { algorithm: 'aes-gcm', key: 'b'.repeat(64), nonce: 'c'.repeat(24) },
};

function createHarness(acquire: () => Promise<string> = async () => 'blob:anagram/1') {
  const states: EncryptedMediaLoadState[] = [];
  const source = {
    acquireDecryptedObjectUrl: vi.fn(acquire),
    releaseDecryptedObjectUrl: vi.fn(),
  };
  const loader = createEncryptedMediaLoader(source, (state) => states.push(state));
  return { loader, source, states };
}

describe('encrypted media loader', () => {
  it('does nothing until load() is called', () => {
    const { source, states } = createHarness();

    expect(source.acquireDecryptedObjectUrl).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('acquires the object URL once on an explicit load', async () => {
    const { loader, source, states } = createHarness();

    await loader.load(encrypted);
    await loader.load(encrypted);

    expect(source.acquireDecryptedObjectUrl).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.status)).toEqual(['loading', 'ready']);
    expect(states.at(-1)?.objectUrl).toBe('blob:anagram/1');
  });

  it('releases the object URL on dispose', async () => {
    const { loader, source } = createHarness();

    await loader.load(encrypted);
    loader.dispose();

    expect(source.releaseDecryptedObjectUrl).toHaveBeenCalledTimes(1);
    expect(source.releaseDecryptedObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: encrypted.url })
    );
  });

  it('releases and ignores a load that resolves after dispose', async () => {
    let resolveAcquire: (url: string) => void = () => undefined;
    const { loader, source, states } = createHarness(
      () => new Promise<string>((resolve) => (resolveAcquire = resolve))
    );

    const pending = loader.load(encrypted);
    loader.dispose();
    resolveAcquire('blob:anagram/late');
    await pending;

    expect(source.releaseDecryptedObjectUrl).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.status)).toEqual(['loading']);
  });

  it('reports failure without a playable URL, releases nothing, and allows retry', async () => {
    const acquire = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Encrypted media hash does not match the message.'))
      .mockResolvedValueOnce('blob:anagram/2');
    const { loader, source, states } = createHarness(acquire);

    await loader.load(encrypted);
    expect(states.at(-1)).toEqual({ status: 'failed', objectUrl: '' });
    loader.dispose();
    expect(source.releaseDecryptedObjectUrl).not.toHaveBeenCalled();

    await loader.load(encrypted);
    expect(states.at(-1)).toEqual({ status: 'ready', objectUrl: 'blob:anagram/2' });
  });

  it('refuses plaintext attachments without touching the service', async () => {
    const { loader, source, states } = createHarness();
    const { encryption: _encryption, ...plain } = encrypted;

    await loader.load(plain);

    expect(source.acquireDecryptedObjectUrl).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ status: 'failed', objectUrl: '' });
  });
});
