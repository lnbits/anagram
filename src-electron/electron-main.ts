import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  shell,
} from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.platform || os.platform();
const appId = 'com.nostr.chat';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const MAX_UNREAD_CHAT_BADGE_COUNT = 99;
const PRIVATE_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/;

let mainWindow: BrowserWindow | null = null;
let unreadChatBadgeState = {
  count: 0,
  label: '',
};
const notificationIconPath = path.resolve(currentDir, 'icons/icon.png');

function shouldToggleDevTools(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') {
    return false;
  }

  const key = input.key.toLowerCase();
  const isMacShortcut = input.meta && input.alt && key === 'i';
  const isCrossPlatformShortcut = input.control && input.shift && key === 'i';

  return key === 'f12' || isMacShortcut || isCrossPlatformShortcut;
}

function isSafeExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function normalizeUnreadChatBadgeCount(count: unknown): number {
  const numericCount = typeof count === 'number' ? count : Number(count);
  if (!Number.isFinite(numericCount)) {
    return 0;
  }

  return Math.max(0, Math.floor(numericCount));
}

function formatUnreadChatBadgeLabel(count: number): string {
  return count > MAX_UNREAD_CHAT_BADGE_COUNT ? `${MAX_UNREAD_CHAT_BADGE_COUNT}+` : String(count);
}

function sanitizeUnreadChatBadgeLabel(label: unknown, count: number): string {
  if (count <= 0) {
    return '';
  }

  if (typeof label !== 'string') {
    return formatUnreadChatBadgeLabel(count);
  }

  const trimmedLabel = label.trim();
  if (!trimmedLabel || trimmedLabel.length > 4 || /^[0-9+]+$/.test(trimmedLabel) === false) {
    return formatUnreadChatBadgeLabel(count);
  }

  return trimmedLabel;
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createWindowsUnreadBadgeIcon(label: string): Electron.NativeImage {
  const fontSize = label.length > 2 ? 26 : 30;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="28" fill="#e53935" />
      <text
        x="32"
        y="40"
        text-anchor="middle"
        font-family="'Segoe UI', system-ui, sans-serif"
        font-size="${fontSize}"
        font-weight="700"
        fill="#ffffff"
      >${escapeSvgText(label)}</text>
    </svg>
  `.trim();
  const svgBase64 = Buffer.from(svg).toString('base64');

  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${svgBase64}`)
    .resize({ width: 16, height: 16, quality: 'best' });
}

function applyUnreadChatBadge(): void {
  const count = unreadChatBadgeState.count;
  const label = unreadChatBadgeState.label;

  if (platform === 'darwin') {
    app.dock.setBadge(count > 0 ? label : '');
    return;
  }

  if (platform === 'win32') {
    mainWindow?.setOverlayIcon(
      count > 0 ? createWindowsUnreadBadgeIcon(label) : null,
      count > 0 ? `${label} unread chats` : ''
    );
    return;
  }

  app.setBadgeCount(count > 0 ? Math.min(count, MAX_UNREAD_CHAT_BADGE_COUNT) : 0);
}

function getPreloadPath(): string {
  return path.resolve(
    currentDir,
    path.join(
      process.env.QUASAR_ELECTRON_PRELOAD_FOLDER,
      `electron-preload${process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION}`
    )
  );
}

function normalizeNotificationText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return fallback;
  }

  return trimmedValue.length > 280 ? `${trimmedValue.slice(0, 277)}...` : trimmedValue;
}

function normalizeNotificationChatPubkey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmedValue) ? trimmedValue : null;
}

function normalizePrivateKeyHex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim().toLowerCase();
  return PRIVATE_KEY_HEX_PATTERN.test(trimmedValue) ? trimmedValue : null;
}

function isSecureStorageEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function focusMainWindow(): Promise<BrowserWindow | null> {
  if (!mainWindow) {
    await createWindow();
  }

  if (!mainWindow) {
    return null;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
  return mainWindow;
}

async function openChatFromNotification(chatPubkey: string): Promise<void> {
  const windowInstance = await focusMainWindow();
  if (!windowInstance) {
    return;
  }

  const dispatchOpenChat = () => {
    windowInstance.webContents.send('desktop:open-chat-from-notification', {
      chatPubkey,
    });
  };

  if (windowInstance.webContents.isLoadingMainFrame()) {
    windowInstance.webContents.once('did-finish-load', dispatchOpenChat);
    return;
  }

  dispatchOpenChat();
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'Nostr Chat',
    icon: notificationIconPath,
    width: 1440,
    height: 960,
    minWidth: 360,
    minHeight: 640,
    useContentSize: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b141a' : '#f6f8fb',
    webPreferences: {
      contextIsolation: true,
      preload: getPreloadPath(),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!shouldToggleDevTools(input)) {
      return;
    }

    event.preventDefault();
    mainWindow?.webContents.toggleDevTools();
  });

  if (process.env.DEV) {
    await mainWindow.loadURL(process.env.APP_URL);
  } else {
    await mainWindow.loadFile('index.html');
  }

  if (process.env.DEBUGGING) {
    mainWindow.webContents.openDevTools();
  }

  applyUnreadChatBadge();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.on('desktop:set-unread-chat-badge', (_event, payload: unknown) => {
  const payloadObject =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const count = normalizeUnreadChatBadgeCount(payloadObject.count);
  const label = sanitizeUnreadChatBadgeLabel(payloadObject.label, count);

  unreadChatBadgeState = {
    count,
    label,
  };
  applyUnreadChatBadge();
});

ipcMain.on('desktop:show-incoming-message-notification', (_event, payload: unknown) => {
  const payloadObject =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const chatPubkey = normalizeNotificationChatPubkey(payloadObject.chatPubkey);
  const title = normalizeNotificationText(payloadObject.title, 'New message');
  const body = normalizeNotificationText(payloadObject.body, 'New message');

  if (!chatPubkey || !Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title,
    body,
    icon: notificationIconPath,
  });

  notification.on('click', () => {
    void openChatFromNotification(chatPubkey);
  });

  notification.show();
});

ipcMain.handle('desktop:secure-storage:is-available', () => isSecureStorageEncryptionAvailable());

ipcMain.handle('desktop:secure-storage:encrypt-private-key', (_event, payload: unknown) => {
  if (!isSecureStorageEncryptionAvailable()) {
    throw new Error('Electron secure storage is not available.');
  }

  const privateKeyHex = normalizePrivateKeyHex(payload);
  if (!privateKeyHex) {
    throw new Error('A valid private key is required.');
  }

  return safeStorage.encryptString(privateKeyHex).toString('base64');
});

ipcMain.handle('desktop:secure-storage:decrypt-private-key', (_event, payload: unknown) => {
  if (!isSecureStorageEncryptionAvailable() || typeof payload !== 'string') {
    return null;
  }

  try {
    const decryptedValue = safeStorage.decryptString(Buffer.from(payload, 'base64'));
    return normalizePrivateKeyHex(decryptedValue);
  } catch {
    return null;
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(appId);

  app.on('second-instance', () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  void app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  if (platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    void createWindow();
  }
});
