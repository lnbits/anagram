// Calls onvisible once, when the node first comes within rootMargin of the viewport, so media
// is only fetched when the user is about to see it. Disabled options stop watching.
export interface NearViewportOptions {
  rootMargin: string;
  onvisible: () => void;
  enabled?: boolean;
}

export function nearViewport(node: HTMLElement, options: NearViewportOptions) {
  let current = options;
  let observer: IntersectionObserver | null = null;
  function stop() {
    observer?.disconnect();
    observer = null;
  }
  function start() {
    stop();
    if (current.enabled === false) return;
    if (typeof IntersectionObserver === 'undefined') {
      current.onvisible();
      return;
    }
    const active = new IntersectionObserver(
      (entries) => {
        // Entries queued before disconnect() may still be delivered; ignore stopped observers.
        if (observer !== active || !entries.some((entry) => entry.isIntersecting)) return;
        stop();
        current.onvisible();
      },
      { rootMargin: current.rootMargin },
    );
    observer = active;
    active.observe(node);
  }
  start();
  return {
    update(next: NearViewportOptions) {
      const restart = next.enabled !== current.enabled || next.rootMargin !== current.rootMargin;
      current = next;
      if (restart) start();
    },
    destroy: stop,
  };
}
