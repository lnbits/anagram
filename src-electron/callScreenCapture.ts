import { desktopCapturer, ipcMain, type BrowserWindow, type DesktopCapturerSource, type Streams, type Session } from 'electron';
import { randomUUID } from 'node:crypto';

type DisplayHandler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>;
const captureWindows = new WeakMap<Session, Map<BrowserWindow, DisplayHandler>>();

// Bind every selection to the requesting app frame and a short-lived source list.
export function installCallScreenCapture(window: BrowserWindow): void {
  let pending: { id: string; sources: DesktopCapturerSource[]; done: (streams: Streams) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancel = () => {
    const current = pending;
    pending = null;
    if (current) { clearTimeout(current.timer); current.done({}); if (!window.isDestroyed()) window.webContents.send('desktop:call-screen-picker', null); }
  };
  const handleRequest: DisplayHandler = (request, callback) => {
    if (!request.userGesture || !request.videoRequested || request.frame !== window.webContents.mainFrame || window.isDestroyed()) { callback({}); return; }
    cancel();
    const id = randomUUID();
    pending = { id, sources: [], done: callback, timer: setTimeout(cancel, 60_000) };
    void desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 280, height: 180 } }).then((sources) => {
      if (pending?.id !== id) return;
      if (window.isDestroyed() || request.frame !== window.webContents.mainFrame) { cancel(); return; }
      pending.sources = sources.slice(0, 100);
      window.webContents.send('desktop:call-screen-picker', { id, sources: pending.sources.map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) });
    }).catch(cancel);
  };
  const session = window.webContents.session;
  let handlers = captureWindows.get(session);
  if (!handlers) {
    handlers = new Map();
    captureWindows.set(session, handlers);
    const registered = handlers;
    session.setDisplayMediaRequestHandler((request, callback) => {
      for (const [owner, handler] of registered) {
        if (!owner.isDestroyed() && owner.webContents.mainFrame === request.frame) {
          handler(request, callback);
          return;
        }
      }
      callback({});
    }, { useSystemPicker: true });
  }
  handlers.set(window, handleRequest);
  const selected = (event: Electron.IpcMainEvent, value: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !pending || !value || typeof value !== 'object') return;
    const payload = value as { id?: unknown; sourceId?: unknown };
    if (payload.id !== pending.id) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    const source = current.sources.find((item) => item.id === payload.sourceId);
    current.done(source ? { video: source } : {});
  };
  ipcMain.on('desktop:call-screen-selected', selected);
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); });
  window.on('closed', () => { handlers.delete(window); cancel(); ipcMain.removeListener('desktop:call-screen-selected', selected); });
}
