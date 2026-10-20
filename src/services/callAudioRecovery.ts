// Resume only in response to lifecycle events, never with a polling loop. A
// gesture can retry even if an earlier resume is waiting for autoplay permission.
export function watchCallAudioContext(context: AudioContext) {
  let closed = false;
  let pending = false;
  let attempt = 0;
  const resume = (gesture = false) => {
    if (closed || context.state === 'closed' || context.state === 'running') return;
    if (pending && !gesture) return;
    pending = true;
    const current = ++attempt;
    void context
      .resume()
      .catch(() => {})
      .finally(() => {
        if (attempt === current) pending = false;
      });
  };
  const changed = () => resume();
  const visible = () => {
    if (document.visibilityState === 'visible') resume();
  };
  const gesture = () => resume(true);
  context.addEventListener('statechange', changed);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pageshow', changed);
  window.addEventListener('focus', changed);
  document.addEventListener('pointerdown', gesture, true);
  document.addEventListener('keydown', gesture, true);
  return {
    resume: changed,
    close() {
      closed = true;
      context.removeEventListener('statechange', changed);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', changed);
      window.removeEventListener('focus', changed);
      document.removeEventListener('pointerdown', gesture, true);
      document.removeEventListener('keydown', gesture, true);
    },
  };
}
