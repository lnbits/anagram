import { isPackagedAppRuntime } from 'src/utils/runtimePlatform';

const THEME_MODE_STORAGE_KEY = 'ui-theme-mode';
const PANEL_OPACITY_STORAGE_KEY = 'ui-panel-opacity';
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'ui-desktop-sidebar-width';
export const DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY = 'ui-desktop-message-layout';
export const DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT = 'anagram:desktop-message-layout-changed';
const DEFAULT_PANEL_OPACITY = 75;
export const DEFAULT_DESKTOP_SIDEBAR_WIDTH = 360;
export const MIN_DESKTOP_SIDEBAR_WIDTH = 280;
export const MAX_DESKTOP_SIDEBAR_WIDTH = 4096;
export const DEFAULT_DESKTOP_MESSAGE_LAYOUT = 'text';
export const DEFAULT_APP_MESSAGE_LAYOUT = 'bubbles';

export type DesktopMessageLayoutPreference = 'text' | 'bubbles';

export interface DesktopMessageLayoutPreferenceChangedDetail {
  layout: DesktopMessageLayoutPreference;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function canUseDocument(): boolean {
  return typeof document !== 'undefined';
}

function normalizePanelOpacityPreference(value: unknown): number {
  const parsedValue = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_PANEL_OPACITY;
  }

  return Math.min(100, Math.max(0, Math.round(parsedValue)));
}

function normalizeDesktopSidebarWidthPreference(value: unknown): number {
  const parsedValue = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_DESKTOP_SIDEBAR_WIDTH;
  }

  return Math.min(
    MAX_DESKTOP_SIDEBAR_WIDTH,
    Math.max(MIN_DESKTOP_SIDEBAR_WIDTH, Math.round(parsedValue))
  );
}

export function normalizeDesktopMessageLayoutPreference(
  value: unknown
): DesktopMessageLayoutPreference {
  return typeof value === 'string' && value.trim().toLowerCase() === 'bubbles'
    ? 'bubbles'
    : DEFAULT_DESKTOP_MESSAGE_LAYOUT;
}

export function readDarkModePreference(): boolean | null {
  if (!canUseStorage()) {
    return null;
  }

  try {
    const value = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (value === 'dark') {
      return true;
    }

    if (value === 'light') {
      return false;
    }
  } catch (error) {
    console.error('Failed to read saved theme mode.', error);
  }

  return null;
}

export function saveDarkModePreference(isDark: boolean): void {
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, isDark ? 'dark' : 'light');
  } catch (error) {
    console.error('Failed to persist theme mode.', error);
  }
}

export function clearDarkModePreference(): void {
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(THEME_MODE_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear saved theme mode.', error);
  }
}

export function readPanelOpacityPreference(): number {
  if (!canUseStorage()) {
    return DEFAULT_PANEL_OPACITY;
  }

  try {
    const value = window.localStorage.getItem(PANEL_OPACITY_STORAGE_KEY);
    if (value === null) {
      return DEFAULT_PANEL_OPACITY;
    }

    return normalizePanelOpacityPreference(value);
  } catch (error) {
    console.error('Failed to read saved panel opacity.', error);
  }

  return DEFAULT_PANEL_OPACITY;
}

export function applyPanelOpacityPreference(opacity: number): void {
  if (!canUseDocument()) {
    return;
  }

  document.documentElement.style.setProperty(
    '--nc-panel-opacity',
    String(normalizePanelOpacityPreference(opacity))
  );
}

export function savePanelOpacityPreference(opacity: number): void {
  const normalizedOpacity = normalizePanelOpacityPreference(opacity);

  if (!canUseStorage()) {
    applyPanelOpacityPreference(normalizedOpacity);
    return;
  }

  try {
    window.localStorage.setItem(PANEL_OPACITY_STORAGE_KEY, String(normalizedOpacity));
  } catch (error) {
    console.error('Failed to persist panel opacity.', error);
  }

  applyPanelOpacityPreference(normalizedOpacity);
}

export function clearPanelOpacityPreference(): void {
  if (canUseStorage()) {
    try {
      window.localStorage.removeItem(PANEL_OPACITY_STORAGE_KEY);
    } catch (error) {
      console.error('Failed to clear saved panel opacity.', error);
    }
  }

  applyPanelOpacityPreference(DEFAULT_PANEL_OPACITY);
}

export function readDesktopSidebarWidthPreference(): number {
  if (!canUseStorage()) {
    return DEFAULT_DESKTOP_SIDEBAR_WIDTH;
  }

  try {
    const value = window.localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY);
    if (value === null) {
      return DEFAULT_DESKTOP_SIDEBAR_WIDTH;
    }

    return normalizeDesktopSidebarWidthPreference(value);
  } catch (error) {
    console.error('Failed to read saved desktop sidebar width.', error);
  }

  return DEFAULT_DESKTOP_SIDEBAR_WIDTH;
}

export function saveDesktopSidebarWidthPreference(width: number): void {
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(
      DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY,
      String(normalizeDesktopSidebarWidthPreference(width))
    );
  } catch (error) {
    console.error('Failed to persist desktop sidebar width.', error);
  }
}

export function readDesktopMessageLayoutPreference(): DesktopMessageLayoutPreference {
  const defaultLayout = isPackagedAppRuntime()
    ? DEFAULT_APP_MESSAGE_LAYOUT
    : DEFAULT_DESKTOP_MESSAGE_LAYOUT;
  if (!canUseStorage()) {
    return defaultLayout;
  }

  try {
    const storedLayout = window.localStorage.getItem(DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY);
    return storedLayout === null
      ? defaultLayout
      : normalizeDesktopMessageLayoutPreference(storedLayout);
  } catch (error) {
    console.error('Failed to read saved desktop message layout.', error);
  }

  return defaultLayout;
}

export function saveDesktopMessageLayoutPreference(layout: DesktopMessageLayoutPreference): void {
  const normalizedLayout = normalizeDesktopMessageLayoutPreference(layout);

  if (canUseStorage()) {
    try {
      window.localStorage.setItem(DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY, normalizedLayout);
    } catch (error) {
      console.error('Failed to persist desktop message layout.', error);
    }
  }

  dispatchDesktopMessageLayoutPreferenceChanged(normalizedLayout);
}

function dispatchDesktopMessageLayoutPreferenceChanged(
  layout: DesktopMessageLayoutPreference
): void {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function' ||
    typeof CustomEvent === 'undefined'
  ) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DesktopMessageLayoutPreferenceChangedDetail>(
      DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT,
      {
        detail: { layout },
      }
    )
  );
}
