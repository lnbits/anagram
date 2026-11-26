import {
  FOREGROUND_MESSAGE_ACTIVITY_EVENT,
  readForegroundMessageActivityDetail,
} from '#src/services/foregroundMessageActivityService.ts';
import { createInboundPresentationRuntime } from '#src/stores/nostr/inboundPresentationRuntime.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

class TestCustomEvent<T = unknown> extends Event {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

function createRuntime(options: {
  foreground: boolean;
  restoring?: boolean;
  visibleChatId?: string | null;
}) {
  return createInboundPresentationRuntime({
    formatSubscriptionLogValue: (value) => value ?? null,
    getLoggedInPublicKeyHex: () => 'f'.repeat(64),
    getVisibleChatId: () => options.visibleChatId ?? null,
    isAppForeground: options.foreground,
    isRestoringStartupState: Boolean(options.restoring),
    logDeveloperTrace: vi.fn(),
    normalizeEventId: (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null,
  });
}

describe('inboundPresentationRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('suppresses notifications for a muted accepted chat and allows them after unmute', async () => {
    const runtime = createRuntime({ foreground: true });
    const key = 'a'.repeat(64);
    expect(
      await runtime.shouldNotifyForAcceptedChatOnly(key, { inbox_state: 'accepted', muted: true }),
    ).toBe(false);
    expect(await runtime.shouldNotifyForAcceptedChatOnly(key, { inbox_state: 'accepted' })).toBe(
      true,
    );
  });

  it('emits a foreground in-app banner activity for another chat', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('window', { dispatchEvent });
    const runtime = createRuntime({
      foreground: true,
      visibleChatId: 'b'.repeat(64),
    });

    runtime.showIncomingMessageBrowserNotification({
      chatPubkey: 'a'.repeat(64),
      iconUrl: 'https://example.test/alice.png',
      title: 'Alice',
      messageText: '  Hello   there  ',
    });

    const event = dispatchEvent.mock.calls[0]?.[0] as Event;
    expect(event.type).toBe(FOREGROUND_MESSAGE_ACTIVITY_EVENT);
    expect(readForegroundMessageActivityDetail(event)).toEqual({
      chatPubkey: 'a'.repeat(64),
      iconUrl: 'https://example.test/alice.png',
      messageText: 'Hello there',
      title: 'Alice',
      showBanner: true,
    });
  });

  it('emits foreground activity without a banner for the visible chat', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('window', { dispatchEvent });
    const runtime = createRuntime({
      foreground: true,
      visibleChatId: 'a'.repeat(64),
    });

    runtime.showIncomingMessageBrowserNotification({
      chatPubkey: 'a'.repeat(64),
      title: 'Alice',
      messageText: 'Hello',
    });

    const event = dispatchEvent.mock.calls[0]?.[0] as Event;
    expect(readForegroundMessageActivityDetail(event)).toEqual({
      chatPubkey: 'a'.repeat(64),
      iconUrl: '',
      messageText: 'Hello',
      title: 'Alice',
      showBanner: false,
    });
  });
});
