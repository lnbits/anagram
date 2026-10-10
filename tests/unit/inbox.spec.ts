import { describe, it, expect } from 'vitest';
import { MessageInbox } from '#src/lib/nostr/inbox.ts';
describe('durable message hydration inbox', () => {
  it('separates accounts, deduplicates events and prioritizes foreground work', async () => {
    const inbox = new MessageInbox();
    const account = crypto.randomUUID();
    const event = {
      pubkey: 'a'.repeat(64),
      kind: 1059,
      created_at: 1,
      tags: [],
      content: 'ciphertext',
    };
    for (let n = 0; n < 80; n++)
      await inbox.put({ account, id: String(n), event, priority: 1, queuedAt: n, throttle: 0 });
    await inbox.put({ account, id: 'urgent', event, priority: 0, queuedAt: 99, throttle: 0 });
    await inbox.put({
      account: 'other-' + account,
      id: 'foreign',
      event,
      priority: 0,
      queuedAt: 0,
      throttle: 0,
    });
    await inbox.put({ account, id: 'urgent', event, priority: 0, queuedAt: 99, throttle: 0 });
    const page = await inbox.next(account);
    expect(page).toHaveLength(32);
    expect(page[0].id).toBe('urgent');
    expect(page.every((row) => row.account === account)).toBe(true);
    await inbox.remove(account, 'urgent');
    expect((await new MessageInbox().next(account))[0].id).toBe('0');
  });
});

it('batches a burst into bounded transactions and acknowledges only committed ciphertext', async () => {
  const { vi } = await import('vitest');
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  const event = {
    pubkey: 'a'.repeat(64),
    kind: 1059,
    created_at: 1,
    tags: [],
    content: 'ciphertext',
  };
  await inbox.next(account); // Open before counting transactions.
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
  const results = await Promise.all(
    Array.from({ length: 130 }, (_, n) =>
      inbox.put({ account, id: String(n), event, priority: 1, queuedAt: n, throttle: 0 }),
    ),
  );
  expect(results).toHaveLength(130);
  expect(
    transaction.mock.calls.filter((args) => args[0] === 'inbox' && args[1] === 'readwrite'),
  ).toHaveLength(3);
  transaction.mockRestore();
  expect(await inbox.next(account, 200)).toHaveLength(130);
});

it('rejects an aborted batch without acknowledging it and accepts a later retry', async () => {
  const { vi } = await import('vitest');
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  const event = {
    pubkey: 'a'.repeat(64),
    kind: 1059,
    created_at: 1,
    tags: [],
    content: 'ciphertext',
  };
  const record = { account, id: 'retry', event, priority: 1, queuedAt: 1, throttle: 0 };
  await inbox.next(account);
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (...args) {
    const request = original.apply(this, args);
    this.transaction.abort();
    return request;
  });
  await expect(inbox.put(record)).rejects.toBeDefined();
  put.mockRestore();
  expect(await inbox.next(account)).toHaveLength(0);
  await inbox.put(record);
  expect(await inbox.next(account)).toHaveLength(1);
});

it('retains retry ciphertext until completion, and deduplicates completed wrappers across instances per account', async () => {
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  const record = {
    account,
    id: 'wrap',
    event: { pubkey: 'a'.repeat(64), kind: 1059, content: 'ciphertext', tags: [], created_at: 1 },
    priority: 0,
    queuedAt: 1,
    throttle: 0,
  };
  await inbox.put(record);
  expect(await inbox.hasProcessed(account, 'wrap')).toBe(false);
  expect(await new MessageInbox().next(account)).toHaveLength(1);
  await inbox.complete(account, 'wrap');
  const restarted = new MessageInbox();
  expect(await restarted.next(account)).toHaveLength(0);
  expect(await restarted.hasProcessed(account, 'wrap')).toBe(true);
  expect(await restarted.hasProcessed('another-' + account, 'wrap')).toBe(false);
});

it('an aborted completion leaves ciphertext retryable without a completion receipt', async () => {
  const { vi } = await import('vitest');
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  await inbox.put({
    account,
    id: 'wrap',
    event: { kind: 1059, pubkey: '', content: 'ciphertext', tags: [], created_at: 1 },
    priority: 0,
    queuedAt: 1,
    throttle: 0,
  });
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (...args) {
    const request = original.apply(this, args);
    this.transaction.abort();
    return request;
  });
  await expect(inbox.complete(account, 'wrap')).rejects.toBeDefined();
  put.mockRestore();
  expect(await inbox.hasProcessed(account, 'wrap')).toBe(false);
  expect(await inbox.next(account)).toHaveLength(1);
});
