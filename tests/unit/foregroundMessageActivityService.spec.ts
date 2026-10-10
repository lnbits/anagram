import {
  emitForegroundMessageActivity,
  FOREGROUND_MESSAGE_ACTIVITY_EVENT,
  readForegroundMessageActivityDetail,
} from '#src/services/foregroundMessageActivityService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

class TestCustomEvent<T = unknown> extends Event {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

describe('foregroundMessageActivityService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits normalized foreground message activity details', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('window', { dispatchEvent });

    emitForegroundMessageActivity({
      chatPubkey: 'A'.repeat(64),
      iconUrl: '  https://example.test/alice.png  ',
      messageText: '  Hello   there  ',
      title: '  Alice   Chat  ',
      showBanner: true,
    });

    const event = dispatchEvent.mock.calls[0]?.[0] as Event;
    expect(event.type).toBe(FOREGROUND_MESSAGE_ACTIVITY_EVENT);
    expect(readForegroundMessageActivityDetail(event)).toEqual({
      chatPubkey: 'a'.repeat(64),
      iconUrl: 'https://example.test/alice.png',
      messageText: 'Hello there',
      title: 'Alice Chat',
      showBanner: true,
    });
  });

  it('ignores invalid foreground message activity details', () => {
    vi.stubGlobal('CustomEvent', TestCustomEvent);

    const event = new CustomEvent(FOREGROUND_MESSAGE_ACTIVITY_EVENT, {
      detail: {
        chatPubkey: 'not-a-pubkey',
        messageText: 'Hello',
        title: 'Alice',
        showBanner: true,
      },
    });

    expect(readForegroundMessageActivityDetail(event)).toBeNull();
  });
});
