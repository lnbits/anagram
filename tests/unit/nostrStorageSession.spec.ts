import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import {
  CONTACT_CURSOR_VERSION,
  EVENT_FILTER_LOOKBACK_SECONDS,
  EVENT_SINCE_STORAGE_KEY,
  PRIVATE_MESSAGES_BACKFILL_INITIAL_DELAY_MS,
  PRIVATE_MESSAGES_BACKFILL_MAX_AGE_SECONDS,
  PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
  PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY,
  PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY,
  PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS,
  PRIVATE_PREFERENCES_STORAGE_KEY,
} from 'src/stores/nostr/constants';
import { createStorageSessionRuntime } from 'src/stores/nostr/storageSession';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const PUBKEY_A = 'a'.repeat(64);
const EVENT_ID_A = 'b'.repeat(64);

function createMockStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));

  return {
    store,
    api: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  };
}

function createRuntimeHarness() {
  const ndk = new NDK();
  const signer = {
    encrypt: vi.fn(async (_user, content: string) => `enc:${content}`),
    decrypt: vi.fn(async (_user, content: string) =>
      content.startsWith('enc:') ? content.slice(4) : content
    ),
  };
  ndk.assertSigner = vi.fn();
  Object.defineProperty(ndk, 'signer', {
    configurable: true,
    enumerable: true,
    value: signer,
    writable: true,
  });

  const refs = {
    eventSince: ref(0),
    isRestoringStartupState: ref(false),
  };
  const pendingEventSinceState = {
    pendingEventSinceUpdate: 0,
  };

  const runtime = createStorageSessionRuntime({
    eventSince: refs.eventSince,
    getDefaultEventSince: () => 5000,
    getLoggedInSignerUser: async () =>
      ({
        pubkey: PUBKEY_A,
      }) as never,
    isRestoringStartupState: refs.isRestoringStartupState,
    ndk,
    normalizeEventId: (value) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null,
    pendingEventSinceState,
  });

  return {
    ndk,
    pendingEventSinceState,
    refs,
    runtime,
    signer,
  };
}

describe('storageSession runtime', () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });

  it('persists eventSince, message timestamps, and backfill resume state', () => {
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { runtime, refs } = createRuntimeHarness();

    expect(runtime.setStoredEventSince(-10)).toBe(5000);
    expect(localStorage.store.get(EVENT_SINCE_STORAGE_KEY)).toBe('5000');
    refs.eventSince.value = 0;
    localStorage.store.set(EVENT_SINCE_STORAGE_KEY, '7000');
    expect(runtime.ensureStoredEventSince()).toBe(7000);
    expect(runtime.getFilterSince()).toBe(Math.max(0, 7000 - EVENT_FILTER_LOOKBACK_SECONDS));

    runtime.updateStoredPrivateMessagesLastReceivedFromCreatedAt(1200);
    runtime.updateStoredPrivateMessagesLastReceivedFromCreatedAt(1100);
    expect(runtime.readStoredPrivateMessagesLastReceivedCreatedAt()).toBe(1200);
    expect(runtime.getPrivateMessagesStartupFloorSince(10_000)).toBe(
      Math.max(0, 10_000 - PRIVATE_MESSAGES_BACKFILL_MAX_AGE_SECONDS)
    );
    expect(runtime.getPrivateMessagesStartupLiveSince(10_000)).toBe(
      Math.max(
        Math.max(0, 10_000 - PRIVATE_MESSAGES_BACKFILL_MAX_AGE_SECONDS),
        1200 - PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS
      )
    );
    expect(runtime.getPrivateMessagesEpochSwitchSince(10_000)).toBe(
      Math.min(runtime.getFilterSince(), runtime.getPrivateMessagesStartupLiveSince(10_000))
    );

    runtime.writePrivateMessagesBackfillState({
      pubkey: PUBKEY_A,
      nextSince: 10,
      nextUntil: 20,
      floorSince: 5,
      delayMs: PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS * 2,
      completed: false,
    });
    expect(runtime.readPrivateMessagesBackfillState()).toEqual({
      pubkey: PUBKEY_A,
      nextSince: 10,
      nextUntil: 20,
      floorSince: 5,
      delayMs: PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
      completed: false,
    });
    expect(runtime.getPrivateMessagesBackfillResumeState(PUBKEY_A, 40, 15)).toEqual({
      pubkey: PUBKEY_A,
      nextSince: 15,
      nextUntil: 20,
      floorSince: 15,
      delayMs: PRIVATE_MESSAGES_BACKFILL_MAX_DELAY_MS,
      completed: false,
    });

    localStorage.store.set(
      PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY,
      JSON.stringify({
        pubkey: PUBKEY_A,
        nextSince: 2,
        nextUntil: 3,
        floorSince: 1,
        delayMs: 10,
        completed: true,
      })
    );
    expect(runtime.getPrivateMessagesBackfillResumeState(PUBKEY_A, 40, 1)).toBeNull();

    runtime.clearStoredPrivateMessagesLastReceivedCreatedAt();
    runtime.clearPrivateMessagesBackfillState();
    expect(runtime.readStoredPrivateMessagesLastReceivedCreatedAt()).toBeNull();
    expect(runtime.readPrivateMessagesBackfillState()).toBeNull();
  });

  it('bounds the cold-start private-message live window when no event was stored', () => {
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { runtime } = createRuntimeHarness();
    const now = PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS * 2;

    expect(runtime.getPrivateMessagesStartupLiveSince(now)).toBe(
      now - PRIVATE_MESSAGES_STARTUP_LIVE_LOOKBACK_SECONDS
    );
  });

  it('buffers eventSince updates during startup restore and resets storage on fresh login', () => {
    const localStorage = createMockStorage({
      [EVENT_SINCE_STORAGE_KEY]: '100',
      [PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY]: '80',
      [PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY]: JSON.stringify({
        pubkey: PUBKEY_A,
        nextSince: 10,
        nextUntil: 20,
        floorSince: 5,
        delayMs: PRIVATE_MESSAGES_BACKFILL_INITIAL_DELAY_MS,
        completed: false,
      }),
    });
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { pendingEventSinceState, refs, runtime } = createRuntimeHarness();

    refs.isRestoringStartupState.value = true;
    runtime.updateStoredEventSinceFromCreatedAt(120);
    expect(pendingEventSinceState.pendingEventSinceUpdate).toBe(120);
    expect(localStorage.store.get(EVENT_SINCE_STORAGE_KEY)).toBe('100');

    refs.isRestoringStartupState.value = false;
    runtime.flushPendingEventSinceUpdate();
    expect(localStorage.store.get(EVENT_SINCE_STORAGE_KEY)).toBe('120');
    expect(pendingEventSinceState.pendingEventSinceUpdate).toBe(0);

    refs.eventSince.value = 999;
    pendingEventSinceState.pendingEventSinceUpdate = 22;
    runtime.resetEventSinceForFreshLogin();
    expect(refs.eventSince.value).toBe(5000);
    expect(pendingEventSinceState.pendingEventSinceUpdate).toBe(0);
    expect(localStorage.store.get(EVENT_SINCE_STORAGE_KEY)).toBeUndefined();
    expect(
      localStorage.store.get(PRIVATE_MESSAGES_LAST_RECEIVED_EVENT_STORAGE_KEY)
    ).toBeUndefined();
    expect(localStorage.store.get(PRIVATE_MESSAGES_BACKFILL_STATE_STORAGE_KEY)).toBeUndefined();
  });

  it('normalizes, stores, hashes, encrypts, and decrypts private nostr content', async () => {
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { ndk, runtime } = createRuntimeHarness();
    const groupPrivateKey = NDKPrivateKeySigner.generate().privateKey;
    const groupPubkey = new NDKPrivateKeySigner(groupPrivateKey).pubkey;
    const epochPrivateKey = NDKPrivateKeySigner.generate().privateKey;

    expect(runtime.normalizeTimestamp(' 2026-01-01T00:00:00.000Z ')).toBe(
      '2026-01-01T00:00:00.000Z'
    );
    expect(runtime.toComparableTimestamp('2026-01-01T00:00:00.000Z')).toBeGreaterThan(0);

    const freshPreferences = runtime.buildFreshPrivatePreferences({
      theme: 'light',
    });
    expect(freshPreferences).toMatchObject({
      theme: 'light',
      contactSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const preferences = {
      contactSecret: groupPrivateKey,
      notifyOnReply: true,
      blossomServerUrl: 'https://Media.Example.com/',
    } as never;
    runtime.writePrivatePreferencesToStorage(preferences);
    expect(runtime.readPrivatePreferencesFromStorage()).toEqual({
      contactSecret: groupPrivateKey,
      notifyOnReply: true,
      blossomServerUrl: 'https://media.example.com',
    });

    const encryptedPreferences = await runtime.encryptPrivatePreferencesContent(preferences);
    expect(encryptedPreferences).toBe(`enc:${JSON.stringify(preferences)}`);
    expect(await runtime.decryptPrivatePreferencesContent(encryptedPreferences)).toEqual({
      contactSecret: groupPrivateKey,
      notifyOnReply: true,
      blossomServerUrl: 'https://media.example.com',
    });

    localStorage.store.set(
      PRIVATE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        contactSecret: groupPrivateKey,
        blossomServerUrl: 'http://insecure.example.com',
      })
    );
    expect(runtime.readPrivatePreferencesFromStorage()).toEqual({
      contactSecret: groupPrivateKey,
    });

    const cursor = {
      at: '2026-01-02T00:00:00.000Z',
      eventId: EVENT_ID_A,
    };
    const encryptedCursor = await runtime.encryptContactCursorContent(cursor);
    expect(encryptedCursor).toBe(
      `enc:${JSON.stringify({
        version: CONTACT_CURSOR_VERSION,
        last_seen_incoming_activity_at: cursor.at,
        last_seen_incoming_activity_event_id: cursor.eventId,
      })}`
    );
    expect(await runtime.decryptContactCursorContent(encryptedCursor)).toEqual({
      version: CONTACT_CURSOR_VERSION,
      last_seen_incoming_activity_at: cursor.at,
      last_seen_incoming_activity_event_id: EVENT_ID_A,
    });

    const groupSecret = {
      version: 1,
      group_pubkey: groupPubkey,
      group_privkey: groupPrivateKey,
      epoch_number: 2,
      epoch_privkey: epochPrivateKey,
      name: ' Group Name ',
      about: ' Group About ',
    };
    expect(runtime.normalizeGroupIdentitySecretContent(groupSecret)).toEqual({
      version: 1,
      group_pubkey: groupPubkey,
      group_privkey: groupPrivateKey,
      epoch_number: 2,
      epoch_privkey: epochPrivateKey,
      name: 'Group Name',
      about: 'Group About',
    });

    const encryptedGroupSecret = await runtime.encryptGroupIdentitySecretContent({
      version: 1,
      group_pubkey: groupPubkey,
      group_privkey: groupPrivateKey,
    });
    expect(await runtime.decryptGroupIdentitySecretContent(encryptedGroupSecret)).toEqual({
      version: 1,
      group_pubkey: groupPubkey,
      group_privkey: groupPrivateKey,
    });

    const encryptedPrivateString = await runtime.encryptPrivateStringContent(
      ` ${groupPrivateKey} `
    );
    expect(encryptedPrivateString).toBe(`enc:${groupPrivateKey}`);
    expect(await runtime.decryptPrivateStringContent(encryptedPrivateString)).toBe(groupPrivateKey);
    expect(await runtime.decryptPrivateStringContent('')).toBeNull();
    expect(await runtime.sha256Hex('sample')).toBe(
      'af2bdbe1aa9b6ec1e2ade1d694f41fc71a831d0268e9891562113d8a62add1bf'
    );

    runtime.clearPrivatePreferencesStorage();
    expect(localStorage.store.get(PRIVATE_PREFERENCES_STORAGE_KEY)).toBeUndefined();
    expect(ndk.assertSigner).toHaveBeenCalled();
  });
});
