interface HistoryPullOptions {
  chatId: string;
  canLoad: () => boolean;
  loading: () => boolean;
  load: () => void;
}

// Match the original thread gestures: a NEW wheel gesture must start at the
// top. Momentum from scrolling up through the thread must not request a page.
export function threadHistoryPull(node: HTMLElement, options: HistoryPullOptions) {
  let wheelAt = -Infinity,
    wheelDistance = 0,
    wheelEligible = false;
  let touch: { id: number; x: number; y: number } | null = null;
  const atTop = () => node.scrollTop <= 1;
  function reset() {
    wheelAt = -Infinity;
    wheelDistance = 0;
    wheelEligible = false;
    touch = null;
  }
  function wheel(event: WheelEvent) {
    if (event.ctrlKey) return;
    if (options.loading()) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    const fresh = event.timeStamp < wheelAt || event.timeStamp - wheelAt > 180;
    wheelAt = event.timeStamp;
    if (fresh) {
      wheelEligible = event.deltaY < 0 && atTop() && options.canLoad();
      wheelDistance = 0;
    }
    if (!atTop() || event.deltaY >= 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      wheelEligible = false;
      wheelDistance = 0;
      return;
    }
    if (!wheelEligible || !options.canLoad()) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
    wheelDistance += Math.abs(event.deltaY) * scale;
    if (wheelDistance < 36) return;
    if (event.cancelable) event.preventDefault();
    // Keep the timestamp: remaining momentum from this gesture cannot load again.
    wheelEligible = false;
    wheelDistance = 0;
    options.load();
  }
  function touchEnd() {
    touch = null;
  }
  function touchStart(event: TouchEvent) {
    touch = null;
    if (
      event.touches.length !== 1 ||
      !atTop() ||
      !options.canLoad() ||
      (event.target instanceof Element &&
        event.target.closest('button, a, input, textarea, [contenteditable=true]'))
    )
      return;
    const first = event.touches[0];
    touch = { id: first.identifier, x: first.clientX, y: first.clientY };
  }
  function touchMove(event: TouchEvent) {
    if (options.loading()) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!touch) return;
    const point = event.touches[0];
    if (
      event.touches.length !== 1 ||
      point.identifier !== touch.id ||
      !atTop() ||
      !options.canLoad()
    ) {
      touch = null;
      return;
    }
    const distance = point.clientY - touch.y;
    if (distance < 0 || Math.abs(point.clientX - touch.x) > Math.abs(distance)) {
      touch = null;
      return;
    }
    if (distance < 48) return;
    if (event.cancelable) event.preventDefault();
    touch = null;
    options.load();
  }
  node.addEventListener('wheel', wheel, { passive: false });
  node.addEventListener('touchstart', touchStart, { passive: true });
  node.addEventListener('touchmove', touchMove, { passive: false });
  node.addEventListener('touchend', touchEnd);
  node.addEventListener('touchcancel', touchEnd);
  return {
    update(next: HistoryPullOptions) {
      if (options.chatId !== next.chatId) reset();
      options = next;
    },
    destroy() {
      reset();
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('touchstart', touchStart);
      node.removeEventListener('touchmove', touchMove);
      node.removeEventListener('touchend', touchEnd);
      node.removeEventListener('touchcancel', touchEnd);
    },
  };
}
