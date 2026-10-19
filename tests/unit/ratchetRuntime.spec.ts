import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  matchFilter,
  type Filter,
  type VerifiedEvent,
} from 'nostr-tools';
import type { Rumor } from 'nostr-double-ratchet';
import {
  authenticatedRatchetMessage,
  createRatchetRuntime,
} from '#src/stores/nostr/ratchetRuntime.ts';
import { RatchetStorage } from '#src/stores/nostr/ratchetStorage.ts';

const owners = [generateSecretKey(), generateSecretKey()].map((key) => ({
  key,
  publicKey: getPublicKey(key),
}));
const windowEvents = new EventTarget();
vi.stubGlobal('window', windowEvents);
const heldLocks = new Set<string>();
vi.stubGlobal('navigator', {
  locks: {
    request: async (
      name: string,
      _options: unknown,
      callback: (lock: object | null) => Promise<void>,
    ) => {
      if (heldLocks.has(name)) return callback(null);
      heldLocks.add(name);
      try {
        await callback({ name });
      } finally {
        heldLocks.delete(name);
      }
    },
  },
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
function rumor(author: string, tags: string[][]): Rumor {
  const event = {
    pubkey: author,
    kind: 14,
    content: 'test',
    created_at: Math.floor(Date.now() / 1000),
    tags,
  };
  return { ...event, id: getEventHash(event) };
}

describe('optional double-ratchet transport', () => {
  it('uses authenticated owner and canonical routing, not arbitrary rumor p tags', () => {
    const [owner, peer] = owners.map((entry) => entry.publicKey);
    const event = rumor(peer, [['p', 'c'.repeat(64)]]);
    expect(authenticatedRatchetMessage(event, peer, undefined, owner)).toBeNull();
    expect(
      authenticatedRatchetMessage(event, owner, { senderOwnerPubkey: peer }, owner),
    ).toBeNull();
    expect(
      authenticatedRatchetMessage(event, peer, { senderOwnerPubkey: peer }, owner)?.tags,
    ).toEqual([['p', owner]]);
    expect(
      authenticatedRatchetMessage(
        { ...event, content: 'tampered' },
        peer,
        { senderOwnerPubkey: peer },
        owner,
      ),
    ).toBeNull();
    const group = rumor(peer, [
      ['p', owner],
      ['l', 'group'],
    ]);
    expect(authenticatedRatchetMessage(group, peer, { senderOwnerPubkey: peer }, owner)).toBeNull();
  });
  it('persists structured session values and isolates accounts across reopen', async () => {
    const a = new RatchetStorage('test-a'),
      b = new RatchetStorage('test-b');
    await a.put('session', { bytes: new Uint8Array([1, 2, 3]) });
    await b.put('session', 'other account');
    await a.close();
    const reopened = new RatchetStorage('test-a');
    expect(await reopened.get('session')).toEqual({ bytes: new Uint8Array([1, 2, 3]) });
    expect(await reopened.list()).toEqual(['session']);
    expect(await b.get('session')).toBe('other account');
    await Promise.all([b.close(), reopened.close()]);
  });
  it('closes during a pending signer prompt and rejects its late result', async () => {
    const key = generateSecretKey(),
      owner = getPublicKey(key);
    const controller = new AbortController();
    let finishSigning: (() => void) | undefined;
    let close: (() => Promise<void>) | undefined;
    const publish = vi.fn().mockResolvedValue(undefined);
    const initialized = createRatchetRuntime({
      owner,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      onCloseReady: (value) => {
        close = value;
      },
      sign: (event) =>
        new Promise((resolve) => {
          finishSigning = () => resolve(finalizeEvent(event, key));
        }),
      publish,
      fetch: async () => [],
      registrationRoster: async () => [],
      subscribe: () => () => {},
      receive: async () => {},
    });
    void initialized.catch(() => {});
    await vi.waitFor(() => expect(finishSigning).toBeTypeOf('function'), { timeout: 15000 });
    controller.abort();
    await close!();
    await vi.waitFor(() => expect(heldLocks.has(`anagram:ratchet:${owner}`)).toBe(false));
    finishSigning!();
    await expect(initialized).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  }, 20000);
  it('sends, receives and resumes persisted sessions without changing identity', async () => {
    const events = new Map<string, VerifiedEvent>();
    const subscriptions = new Set<{ filter: Filter; receive: (event: VerifiedEvent) => void }>();
    const received: Rumor[][] = [[], []];
    let blockAcknowledgement = false;
    let releaseAcknowledgement: (() => void) | undefined;

    const start = async (index: number) => {
      const identity = owners[index];
      return createRatchetRuntime({
        owner: identity.publicKey,
        isCurrent: () => true,
        sign: async (event) => finalizeEvent(event, identity.key),
        publish: async (event) => {
          events.set(event.id, event);
          for (const sub of subscriptions)
            if (matchFilter(sub.filter, event)) queueMicrotask(() => sub.receive(event));
        },
        fetch: async (filter) =>
          [...events.values()]
            .filter((event) => matchFilter(filter, event))
            .slice(0, filter.limit ?? 200),
        registrationRoster: async () =>
          [...events.values()].filter(
            (event) => event.kind === 37368 && event.pubkey === identity.publicKey,
          ),
        subscribe: (filter, receive) => {
          const sub = { filter, receive };
          subscriptions.add(sub);
          for (const event of [...events.values()]
            .filter((event) => matchFilter(filter, event))
            .slice(0, filter.limit ?? 200))
            queueMicrotask(() => receive(event));
          return () => {
            subscriptions.delete(sub);
          };
        },
        receive: async (event) => {
          received[index].push(event);
        },
        published: async () => {
          if (index === 0 && blockAcknowledgement)
            await new Promise<void>((resolve) => {
              releaseAcknowledgement = resolve;
            });
        },
      });
    };
    const [a, b] = await Promise.all([start(0), start(1)]);
    cleanups.push(a.close, b.close);
    const sent = await a.send(owners[1].publicKey, { kind: 14, content: 'first' });
    expect(sent.id).toMatch(/^[a-f0-9]{64}$/);
    expect(getEventHash(sent)).toBe(sent.id);
    await expect(start(0)).rejects.toThrow('another tab');
    await vi.waitFor(
      () => expect(received[1].some((event) => event.content === 'first')).toBe(true),
      { timeout: 10000 },
    );
    await b.close();
    cleanups.pop();
    await a.send(owners[1].publicKey, { kind: 14, content: 'offline' });
    const reopened = await start(1);
    cleanups.push(reopened.close);
    await vi.waitFor(
      () => expect(received[1].some((event) => event.content === 'offline')).toBe(true),
      { timeout: 10000 },
    );
    await reopened.send(owners[0].publicKey, { kind: 14, content: 'reply' });
    await vi.waitFor(
      () => expect(received[0].some((event) => event.content === 'reply')).toBe(true),
      { timeout: 10000 },
    );
    expect(received[1].find((event) => event.content === 'first')?.pubkey).toBe(
      owners[0].publicKey,
    );
    expect([...events.values()].some((event) => event.kind === 1060)).toBe(true);
    blockAcknowledgement = true;
    await a.send(owners[1].publicKey, { kind: 14, content: 'Pending acknowledgement' });
    await vi.waitFor(() => expect(releaseAcknowledgement).toBeTypeOf('function'));
    const closing = a.close();
    const closedEarly = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(closedEarly).toBe(false);
    releaseAcknowledgement!();
    await closing;
  }, 45000);
});
