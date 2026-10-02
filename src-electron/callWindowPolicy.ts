// A call tab gets the app preload only when it is the same app document.
export function isCallLobbyWindow(target: string, current: string): boolean {
  try {
    const next = new URL(target);
    const app = new URL(current);
    return ['http:', 'https:', 'file:'].includes(app.protocol) &&
      next.protocol === app.protocol && next.host === app.host &&
      next.pathname === app.pathname && next.search === app.search &&
      next.username === app.username && next.password === app.password &&
      next.hash === '#/call';
  } catch { return false; }
}
