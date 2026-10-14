import { createBlossomMediaRecoveryService } from '#src/services/blossomMediaRecoveryService.ts';
import { describe, expect, it, vi } from 'vitest';

const AUTHOR = 'a'.repeat(64);
const DEAD_SERVER = 'https://dead.example.com';
const GOOD_SERVER = 'https://good.example.com';
const LYING_SERVER = 'https://lying.example.com';
const IMAGE_BYTES = new TextEncoder().encode('the real image bytes');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const HASH = await sha256Hex(IMAGE_BYTES);
const DEAD_URL = `${DEAD_SERVER}/${HASH}.png`;

interface HarnessOptions {
  authorServerUrls?: string[];
  responses?: Record<string, () => Promise<Response>>;
  maxBytes?: number;
  requestTimeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const responder = (url: string): Promise<Response> => {
    const handler = options.responses?.[url];
    return handler ? handler() : Promise.resolve(new Response('', { status: 404 }));
  };
  const fetchResource = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const signal = init?.signal;
      if (!signal) return responder(url);
      // Real fetch rejects when the caller's timeout aborts the request.
      return new Promise<Response>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('Aborted')));
        void responder(url).then(resolve, reject);
      });
    },
  );
  const readAuthorBlossomServerUrls = vi.fn(
    async (_publicKey: string) => options.authorServerUrls ?? [DEAD_SERVER, GOOD_SERVER],
  );
  const service = createBlossomMediaRecoveryService({
    fetchResource: fetchResource as unknown as typeof fetch,
    maxBytes: options.maxBytes,
    readAuthorBlossomServerUrls,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  return { calls, readAuthorBlossomServerUrls, service };
}

function serveBytes(bytes: Uint8Array, init: ResponseInit = {}): Promise<Response> {
  return Promise.resolve(
    new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
      ...init,
    }),
  );
}

describe('Blossom media recovery', () => {
  it('serves the file from another of the author servers and skips the dead one', async () => {
    const { calls, service } = createHarness({
      responses: { [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES) },
    });

    const blob = await service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL });

    expect(await blob?.text()).toBe('the real image bytes');
    expect(calls).toEqual([`${GOOD_SERVER}/${HASH}.png`]);
  });

  it('rejects a server that answers with the wrong bytes and tries the next one', async () => {
    const { calls, service } = createHarness({
      authorServerUrls: [LYING_SERVER, GOOD_SERVER],
      responses: {
        [`${LYING_SERVER}/${HASH}.png`]: () =>
          serveBytes(new TextEncoder().encode('not the file you asked for')),
        [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES),
      },
    });

    const blob = await service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL });

    expect(blob).not.toBeNull();
    expect(calls).toEqual([`${LYING_SERVER}/${HASH}.png`, `${GOOD_SERVER}/${HASH}.png`]);
  });

  it('moves on when a server errors or 404s', async () => {
    const { calls, service } = createHarness({
      authorServerUrls: [LYING_SERVER, GOOD_SERVER],
      responses: {
        [`${LYING_SERVER}/${HASH}.png`]: () => Promise.resolve(new Response('', { status: 404 })),
        [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES),
      },
    });

    await expect(
      service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ).resolves.not.toBeNull();
    expect(calls).toEqual([`${LYING_SERVER}/${HASH}.png`, `${GOOD_SERVER}/${HASH}.png`]);
  });

  it('reaches the author server when the stored link ends without an extension', async () => {
    const { calls, service } = createHarness({
      responses: { [`${GOOD_SERVER}/${HASH}`]: () => serveBytes(IMAGE_BYTES) },
    });

    await service.recoverMedia({ authorPublicKey: AUTHOR, url: `${DEAD_SERVER}/${HASH}` });

    expect(calls).toEqual([`${GOOD_SERVER}/${HASH}`]);
  });

  it('reads the hash out of the stored URL when the message carries none', async () => {
    const { service } = createHarness({
      responses: { [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES) },
    });

    await expect(
      service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ).resolves.not.toBeNull();
  });

  it('leaves a link alone when it carries no hash and asks no one', async () => {
    const { calls, readAuthorBlossomServerUrls, service } = createHarness();

    await expect(
      service.recoverMedia({ authorPublicKey: AUTHOR, url: 'https://dead.example.com/photo.png' }),
    ).resolves.toBeNull();
    expect(readAuthorBlossomServerUrls).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('skips media above the recovery size ceiling without downloading it', async () => {
    const { calls, service } = createHarness({ maxBytes: 4 });

    await expect(
      service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL, size: 5 }),
    ).resolves.toBeNull();

    const { calls: servingCalls, service: servingService } = createHarness({
      maxBytes: 4,
      responses: { [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES) },
    });
    await expect(
      servingService.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ).resolves.toBeNull();

    expect(calls).toEqual([]);
    expect(servingCalls).toEqual([`${GOOD_SERVER}/${HASH}.png`]);
  });

  it('downloads a link once and remembers a link that could not be recovered', async () => {
    const { calls, readAuthorBlossomServerUrls, service } = createHarness({
      responses: { [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES) },
    });

    const first = await service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL });
    const second = await service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL });
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    expect(readAuthorBlossomServerUrls).toHaveBeenCalledTimes(1);

    const { calls: failingCalls, service: failingService } = createHarness({
      authorServerUrls: [GOOD_SERVER],
    });
    await expect(
      failingService.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ).resolves.toBeNull();
    await expect(
      failingService.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ).resolves.toBeNull();
    expect(failingCalls).toHaveLength(1);
  });

  it('shares one download between callers asking for the same link', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, service } = createHarness({
      responses: {
        [`${GOOD_SERVER}/${HASH}.png`]: async () => {
          await gate;
          return serveBytes(IMAGE_BYTES);
        },
      },
    });

    const both = Promise.all([
      service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
      service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ]);
    release();
    const [first, second] = await both;

    expect(first).toBe(second);
    expect(calls).toEqual([`${GOOD_SERVER}/${HASH}.png`]);
  });

  it('gives up on a server that never answers', async () => {
    const { service } = createHarness({
      authorServerUrls: [LYING_SERVER],
      requestTimeoutMs: 10,
      responses: {
        [`${LYING_SERVER}/${HASH}.png`]: () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(serveBytes(IMAGE_BYTES)), 50),
          ),
      },
    });

    await expect(
      service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL }),
    ).resolves.toBeNull();
  });

  it('forgets everything on reset', async () => {
    const { calls, service } = createHarness({
      responses: { [`${GOOD_SERVER}/${HASH}.png`]: () => serveBytes(IMAGE_BYTES) },
    });

    await service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL });
    service.reset();
    await service.recoverMedia({ authorPublicKey: AUTHOR, url: DEAD_URL });

    expect(calls).toHaveLength(2);
  });
});
