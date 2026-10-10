/** Use the same long-press gesture for every message row. */
export function messagePress(node: HTMLElement, enabled: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin = { x: 0, y: 0 };
  let suppressClickUntil = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const down = (event: PointerEvent) => {
    if (
      !enabled ||
      event.pointerType === 'mouse' ||
      !event.isPrimary ||
      (event.target as HTMLElement).closest('button, a, input, textarea')
    )
      return;
    cancel();
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = undefined;
      suppressClickUntil = Date.now() + 750;
      node.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: origin.x,
          clientY: origin.y,
        }),
      );
    }, 500);
  };
  const move = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel();
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', cancel);
  node.addEventListener('click', click, true);
  window.addEventListener('scroll', cancel, true);
  return {
    update(value: boolean) {
      enabled = value;
      if (!value) cancel();
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('contextmenu', cancel);
      node.removeEventListener('click', click, true);
      window.removeEventListener('scroll', cancel, true);
    },
  };
}
