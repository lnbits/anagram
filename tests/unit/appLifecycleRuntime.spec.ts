import { createAppLifecycleRuntime } from '#src/stores/nostr/appLifecycleRuntime.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHAT_PUBLIC_KEY = 'a'.repeat(64);

describe('appLifecycleRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      hasFocus: vi.fn(() => true),
      visibilityState: 'visible',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('tracks foreground state, visible chat state, and reconnect-healing lifecycle notifications', () => {
    const notifyReconnectHealingBrowserOnline = vi.fn();
    const notifyReconnectHealingVisibilityHidden = vi.fn();
    const notifyReconnectHealingVisibilityRegain = vi.fn();
    const notifyReconnectHealingWindowBlur = vi.fn();
    const notifyReconnectHealingWindowFocus = vi.fn();
    const setIsAppForeground = vi.fn();
    const setVisibleChatId = vi.fn();

    const runtime = createAppLifecycleRuntime({
      notifyReconnectHealingBrowserOnline,
      notifyReconnectHealingVisibilityHidden,
      notifyReconnectHealingVisibilityRegain,
      notifyReconnectHealingWindowBlur,
      notifyReconnectHealingWindowFocus,
      setIsAppForeground,
      setVisibleChatId,
    });

    runtime.setRouteChatId(CHAT_PUBLIC_KEY);
    runtime.startAppLifecycleRuntime();

    expect(setIsAppForeground).toHaveBeenLastCalledWith(true);
    expect(setVisibleChatId).toHaveBeenLastCalledWith(CHAT_PUBLIC_KEY);
    expect(window.addEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(window.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(window.addEventListener).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(document.addEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );

    const onlineHandler = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === 'online')?.[1] as (() => void) | undefined;
    const focusHandler = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === 'focus')?.[1] as (() => void) | undefined;
    const blurHandler = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === 'blur')?.[1] as (() => void) | undefined;
    const visibilityHandler = vi
      .mocked(document.addEventListener)
      .mock.calls.find(([eventName]) => eventName === 'visibilitychange')?.[1] as
      | (() => void)
      | undefined;

    blurHandler?.();
    expect(setIsAppForeground).toHaveBeenLastCalledWith(false);
    expect(setVisibleChatId).toHaveBeenLastCalledWith(null);
    expect(notifyReconnectHealingWindowBlur).toHaveBeenCalledTimes(1);

    focusHandler?.();
    expect(setIsAppForeground).toHaveBeenLastCalledWith(true);
    expect(setVisibleChatId).toHaveBeenLastCalledWith(CHAT_PUBLIC_KEY);
    expect(notifyReconnectHealingWindowFocus).toHaveBeenCalledTimes(1);

    (
      document as {
        visibilityState: 'hidden' | 'visible';
      }
    ).visibilityState = 'hidden';
    visibilityHandler?.();
    expect(setIsAppForeground).toHaveBeenLastCalledWith(false);
    expect(setVisibleChatId).toHaveBeenLastCalledWith(null);
    expect(notifyReconnectHealingVisibilityHidden).toHaveBeenCalledTimes(1);

    (
      document as {
        visibilityState: 'hidden' | 'visible';
      }
    ).visibilityState = 'visible';
    visibilityHandler?.();
    expect(setIsAppForeground).toHaveBeenLastCalledWith(true);
    expect(setVisibleChatId).toHaveBeenLastCalledWith(CHAT_PUBLIC_KEY);
    expect(notifyReconnectHealingVisibilityRegain).toHaveBeenCalledTimes(1);

    onlineHandler?.();
    expect(notifyReconnectHealingBrowserOnline).toHaveBeenCalledTimes(1);

    runtime.resetAppLifecycleRuntimeState();
    expect(setIsAppForeground).toHaveBeenLastCalledWith(false);
    expect(setVisibleChatId).toHaveBeenLastCalledWith(null);
    expect(window.removeEventListener).toHaveBeenCalledWith('online', onlineHandler);
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', focusHandler);
    expect(window.removeEventListener).toHaveBeenCalledWith('blur', blurHandler);
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      visibilityHandler
    );
  });
});
