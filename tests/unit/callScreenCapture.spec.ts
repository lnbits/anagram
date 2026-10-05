import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCallScreenCapture } from '../../src-electron/callScreenCapture';

const mocked = vi.hoisted(() => ({
  getSources: vi.fn(),
  listeners: new Map<string, (...args: any[]) => void>(),
}));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocked.getSources },
  ipcMain: {
    on: (name: string, callback: (...args: any[]) => void) => mocked.listeners.set(name, callback),
    removeListener: (name: string) => mocked.listeners.delete(name),
  },
}));
const windows: EventEmitter[] = [];
function createSession() {
  const session = {
    handler: (_request: any, _callback: any) => {},
    setDisplayMediaRequestHandler: vi.fn((next: (request: any, callback: any) => void) => {
      session.handler = next;
    }),
  };
  return session;
}
function setup(session = createSession()) {
  const frame = {};
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    send: vi.fn(),
    session,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  mocked.getSources.mockResolvedValue([
    {
      id: 'screen:1',
      name: 'Screen 1',
      thumbnail: { toDataURL: () => 'data:image/png;base64,AA==' },
    },
  ]);
  installCallScreenCapture(window as unknown as BrowserWindow);
  windows.push(window);
  return {
    contents,
    window,
    frame,
    request: (done: any, values: any = {}) =>
      session.handler({ frame, userGesture: true, videoRequested: true, ...values }, done),
  };
}
afterEach(() => {
  windows.splice(0).forEach((window) => {
    window.emit('closed');
  });
  mocked.listeners.clear();
  vi.clearAllMocks();
});
describe('Electron screen capture consent', () => {
  it('routes a shared session to the requesting window and retains the main window after the call window closes', async () => {
    const session = createSession();
    const main = setup(session);
    const call = setup(session);
    expect(session.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
    main.request(vi.fn());
    await Promise.resolve();
    expect(main.contents.send).toHaveBeenCalledWith(
      'desktop:call-screen-picker',
      expect.objectContaining({ sources: expect.any(Array) })
    );
    expect(call.contents.send).not.toHaveBeenCalled();
    call.request(vi.fn());
    await Promise.resolve();
    expect(call.contents.send).toHaveBeenCalled();
    call.window.emit('closed');
    main.contents.send.mockClear();
    main.request(vi.fn());
    await Promise.resolve();
    expect(main.contents.send).toHaveBeenLastCalledWith(
      'desktop:call-screen-picker',
      expect.objectContaining({ sources: expect.any(Array) })
    );
  });
  it('rejects a different frame or a request without a user gesture', () => {
    const h = setup();
    const done = vi.fn();
    h.request(done, { frame: {} });
    h.request(done, { userGesture: false });
    expect(done.mock.calls).toEqual([[{}], [{}]]);
    expect(mocked.getSources).not.toHaveBeenCalled();
  });
  it('grants only a listed source after selection by the requesting app frame', async () => {
    const h = setup();
    const done = vi.fn();
    h.request(done);
    await Promise.resolve();
    const payload = h.contents.send.mock.calls[0]?.[1];
    const select = mocked.listeners.get('desktop:call-screen-selected');
    if (!select) throw new Error('Missing screen selection handler');
    select({ sender: {}, senderFrame: h.frame }, { id: payload.id, sourceId: 'screen:1' });
    select(
      { sender: h.contents, senderFrame: h.frame },
      { id: 'old-request', sourceId: 'screen:1' }
    );
    expect(done).not.toHaveBeenCalled();
    select({ sender: h.contents, senderFrame: h.frame }, { id: payload.id, sourceId: 'screen:1' });
    expect(done).toHaveBeenCalledWith({ video: expect.objectContaining({ id: 'screen:1' }) });
  });
  it('cancels pending capture when the main frame navigates', async () => {
    const h = setup();
    const done = vi.fn();
    h.request(done);
    await Promise.resolve();
    h.contents.emit('did-start-navigation', {}, 'https://elsewhere.example', false, true);
    expect(done).toHaveBeenCalledWith({});
    expect(h.contents.send).toHaveBeenLastCalledWith('desktop:call-screen-picker', null);
  });
});
