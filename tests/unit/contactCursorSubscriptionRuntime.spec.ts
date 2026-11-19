import { beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import NostrClient, { ClientEvent, type NostrSubscriptionOptions } from '#src/lib/nostr/client.ts';
import { createContactCursorSubscriptionRuntime } from '#src/stores/nostr/contactCursorSubscriptionRuntime.ts';
import { PRIVATE_PREFERENCES_KIND } from '#src/stores/nostr/constants.ts';
import type { ContactRecord } from '#src/types/contact.ts';
import type { ContactCursorContent } from '#src/stores/nostr/types.ts';

const contacts = vi.hoisted(() => ({ listContacts: vi.fn(), getContactByPublicKey: vi.fn() }));
vi.mock('#src/services/contactsService.ts', () => ({ contactsService: contacts }));
const peer = 'b'.repeat(64);
const contact = { public_key: peer, meta: {} } as ContactRecord;
const cursor = (day: number): ContactCursorContent => ({
  version: '0.1',
  last_seen_incoming_activity_at: `2026-11-${day}T00:00:00.000Z`,
  last_seen_incoming_activity_event_id: null,
});

function setup() {
  const key = generateSecretKey();
  let account: string | null = getPublicKey(key);
  const ndk = new NostrClient();
  const listeners: NostrSubscriptionOptions[] = [];
  const stop = vi.fn();
  const subscribe = vi.spyOn(ndk, 'subscribe').mockImplementation((_filters, options) => {
    listeners.push(options!);
    return { stop } as ReturnType<NostrClient['subscribe']>;
  });
  const deps = {
    ndk,
    getLoggedInPublicKeyHex: () => account,
    deriveContactCursorDTag: vi.fn(async (key: string) => `secret-${key}`),
    resolveLoggedInReadRelayUrls: vi.fn(async () => ['wss://example.test/']),
    ensureRelayConnections: vi.fn(async () => {}),
    decryptContactCursorContent: vi.fn(
      async (content: string) => JSON.parse(content) as ContactCursorContent,
    ),
    compareContactCursorState: (a: ContactCursorContent, b: ContactCursorContent) =>
      a.last_seen_incoming_activity_at.localeCompare(b.last_seen_incoming_activity_at),
    observeContactCursorEvent: vi.fn(),
    applyContactCursorStateToContact: vi.fn(async () => true),
    reloadReadState: vi.fn(async () => {}),
  };
  const runtime = createContactCursorSubscriptionRuntime(deps);
  function event(day = 18, dTag = `secret-${peer}`, signingKey = key) {
    return new ClientEvent(
      ndk,
      finalizeEvent(
        {
          kind: PRIVATE_PREFERENCES_KIND,
          created_at: day,
          tags: [['d', dTag]],
          content: JSON.stringify(cursor(day)),
        },
        signingKey,
      ),
    );
  }
  return {
    deps,
    runtime,
    subscribe,
    listeners,
    stop,
    event,
    account: (value: string | null) => {
      account = value;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  contacts.listContacts.mockResolvedValue([contact]);
  contacts.getContactByPublicKey.mockResolvedValue(contact);
});

it('keeps scoped cursors live, applies newer state, and ignores replayed or older boundaries', async () => {
  const s = setup();
  await s.runtime.subscribe();
  await s.runtime.subscribe();
  expect(s.subscribe).toHaveBeenCalledTimes(1);
  expect(s.subscribe.mock.calls[0][0]).toEqual([
    {
      kinds: [PRIVATE_PREFERENCES_KIND],
      authors: [s.event().pubkey],
      '#d': [`secret-${peer}`],
    },
  ]);
  s.listeners[0].onEvent!(s.event(18));
  await vi.waitFor(() => expect(s.deps.reloadReadState).toHaveBeenCalledTimes(1));
  s.listeners[0].onEvent!(s.event(17));
  s.listeners[0].onEvent!(s.event(18));
  s.listeners[0].onEvent!(s.event(19));
  await vi.waitFor(() => expect(s.deps.reloadReadState).toHaveBeenCalledTimes(2));
  expect(s.deps.applyContactCursorStateToContact).toHaveBeenLastCalledWith(
    contact,
    cursor(19),
    expect.any(Function),
  );
  s.runtime.reset();
});

it('rejects other authors, unknown addresses, and invalid signatures before decryption', async () => {
  const s = setup();
  await s.runtime.subscribe();
  s.listeners[0].onEvent!(s.event(18, 'unknown'));
  s.listeners[0].onEvent!(s.event(18, `secret-${peer}`, generateSecretKey()));
  const invalid = s.event();
  invalid.sig = '0'.repeat(128);
  s.listeners[0].onEvent!(invalid);
  expect(s.deps.decryptContactCursorContent).not.toHaveBeenCalled();
  s.runtime.reset();
});

it('cancels in-flight decryption and isolates the next account queue on reset', async () => {
  const s = setup();
  let finish!: (value: ContactCursorContent) => void;
  s.deps.decryptContactCursorContent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await s.runtime.subscribe();
  s.listeners[0].onEvent!(s.event());
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  s.runtime.reset();
  expect(s.stop).toHaveBeenCalledOnce();
  const nextKey = generateSecretKey();
  s.account(getPublicKey(nextKey));
  await s.runtime.subscribe();
  s.listeners[1].onEvent!(s.event(19, `secret-${peer}`, nextKey));
  await vi.waitFor(() => expect(s.deps.reloadReadState).toHaveBeenCalledOnce());
  finish(cursor(18));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.deps.applyContactCursorStateToContact).toHaveBeenCalledTimes(1);
  s.runtime.reset();
});

it('bounds contact filters and stops old subscriptions when the contact scope changes', async () => {
  const s = setup();
  contacts.listContacts.mockResolvedValue(
    Array.from({ length: 205 }, (_, i) => ({ ...contact, public_key: `${i}` })),
  );
  await s.runtime.subscribe();
  expect(
    s.subscribe.mock.calls.map(([filters]) => (filters as { '#d': string[] }[])[0]['#d'].length),
  ).toEqual([100, 100, 5]);
  contacts.listContacts.mockResolvedValue([]);
  await s.runtime.subscribe();
  expect(s.stop).toHaveBeenCalledTimes(3);
  s.runtime.reset();
});
