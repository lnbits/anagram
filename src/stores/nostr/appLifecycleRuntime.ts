import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';

interface AppLifecycleRuntimeDeps {
  notifyReconnectHealingBrowserOnline: () => void;
  notifyReconnectHealingVisibilityHidden: () => void;
  notifyReconnectHealingVisibilityRegain: () => void;
  notifyReconnectHealingWindowBlur: () => void;
  notifyReconnectHealingWindowFocus: () => void;
  setIsAppForeground: (value: boolean) => void;
  setVisibleChatId: (chatId: string | null) => void;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

function readIsDocumentVisible(): boolean {
  if (!hasDocument()) {
    return false;
  }

  return document.visibilityState === 'visible';
}

function readIsWindowFocused(): boolean {
  if (!hasDocument()) {
    return false;
  }

  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function normalizeRouteChatId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return inputSanitizerService.normalizeHexKey(value);
}

export function createAppLifecycleRuntime({
  notifyReconnectHealingBrowserOnline,
  notifyReconnectHealingVisibilityHidden,
  notifyReconnectHealingVisibilityRegain,
  notifyReconnectHealingWindowBlur,
  notifyReconnectHealingWindowFocus,
  setIsAppForeground,
  setVisibleChatId,
}: AppLifecycleRuntimeDeps) {
  let routeChatId: string | null = null;
  let isDocumentVisible = false;
  let isWindowFocused = false;
  let hasOnlineListener = false;
  let hasVisibilityListener = false;
  let hasFocusListener = false;
  let hasBlurListener = false;

  function syncDerivedLifecycleState(): void {
    const isAppForeground = isDocumentVisible && isWindowFocused;
    setIsAppForeground(isAppForeground);
    setVisibleChatId(isAppForeground ? routeChatId : null);
  }

  function setDocumentVisibility(nextVisible: boolean): void {
    const normalizedValue = Boolean(nextVisible);
    const wasVisible = isDocumentVisible;

    isDocumentVisible = normalizedValue;
    syncDerivedLifecycleState();

    if (normalizedValue === wasVisible) {
      return;
    }

    if (normalizedValue) {
      notifyReconnectHealingVisibilityRegain();
      return;
    }

    notifyReconnectHealingVisibilityHidden();
  }

  function setWindowFocus(nextFocused: boolean): void {
    const normalizedValue = Boolean(nextFocused);
    const wasFocused = isWindowFocused;

    isWindowFocused = normalizedValue;
    syncDerivedLifecycleState();

    if (normalizedValue === wasFocused) {
      return;
    }

    if (normalizedValue) {
      notifyReconnectHealingWindowFocus();
      return;
    }

    notifyReconnectHealingWindowBlur();
  }

  function handleBrowserOnline(): void {
    notifyReconnectHealingBrowserOnline();
  }

  function handleDocumentVisibilityChange(): void {
    setDocumentVisibility(readIsDocumentVisible());
  }

  function handleWindowFocus(): void {
    setWindowFocus(true);
  }

  function handleWindowBlur(): void {
    setWindowFocus(false);
  }

  function setRouteChatId(nextChatId: string | null): void {
    routeChatId = normalizeRouteChatId(nextChatId);
    syncDerivedLifecycleState();
  }

  function startAppLifecycleRuntime(): void {
    isDocumentVisible = readIsDocumentVisible();
    isWindowFocused = readIsWindowFocused();
    syncDerivedLifecycleState();

    if (!hasWindow()) {
      return;
    }

    if (!hasOnlineListener) {
      window.addEventListener('online', handleBrowserOnline);
      hasOnlineListener = true;
    }

    if (!hasFocusListener) {
      window.addEventListener('focus', handleWindowFocus);
      hasFocusListener = true;
    }

    if (!hasBlurListener) {
      window.addEventListener('blur', handleWindowBlur);
      hasBlurListener = true;
    }

    if (hasDocument() && !hasVisibilityListener) {
      document.addEventListener('visibilitychange', handleDocumentVisibilityChange);
      hasVisibilityListener = true;
    }
  }

  function resetAppLifecycleRuntimeState(): void {
    routeChatId = null;
    isDocumentVisible = false;
    isWindowFocused = false;
    syncDerivedLifecycleState();

    if (hasWindow() && hasOnlineListener) {
      window.removeEventListener('online', handleBrowserOnline);
      hasOnlineListener = false;
    }

    if (hasWindow() && hasFocusListener) {
      window.removeEventListener('focus', handleWindowFocus);
      hasFocusListener = false;
    }

    if (hasWindow() && hasBlurListener) {
      window.removeEventListener('blur', handleWindowBlur);
      hasBlurListener = false;
    }

    if (hasDocument() && hasVisibilityListener) {
      document.removeEventListener('visibilitychange', handleDocumentVisibilityChange);
      hasVisibilityListener = false;
    }
  }

  return {
    resetAppLifecycleRuntimeState,
    setDocumentVisibility,
    setRouteChatId,
    setWindowFocus,
    startAppLifecycleRuntime,
  };
}
