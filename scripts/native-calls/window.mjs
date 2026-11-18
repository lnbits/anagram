import { setTimeout as delay } from 'node:timers/promises';

// xdotool traverses every X11 window, including short-lived WebKit windows from
// other clients. A window disappearing during that traversal raises BadWindow.
export async function findLinuxProbeWindow(pid, command, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const window = command('xdotool', ['search', '--pid', String(pid)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
      })
        .trim()
        .split('\n')
        .at(-1);
      if (/^\d+$/.test(window)) return window;
    } catch (error) {
      // A plain exit 1 means that the app has not mapped its window yet. Keep
      // missing commands, display errors and other genuine setup failures fatal.
      const stderr = String(error.stderr ?? '');
      if (!stderr.includes('BadWindow') && !(error.status === 1 && !stderr.trim())) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    // Yield so other clients and the probe HTTP server can continue starting.
    await delay(Math.min(100, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error(`Timed out finding native window for pid ${pid}`, { cause: lastError });
}
