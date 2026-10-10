// Use on a backdrop container or a native dialog. Only a full outside click
// dismisses it, so selecting text or dragging out of the panel stays safe.
export function dismissOnBackdrop(node: HTMLElement, dismiss: () => void) {
  let startedOutside = false;
  function outside(event: MouseEvent) {
    if (event.target !== node) return false;
    if (!(node instanceof HTMLDialogElement))
      return node.ownerDocument.elementFromPoint(event.clientX, event.clientY) === node;
    const bounds = node.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  }
  function down(event: PointerEvent) {
    startedOutside = event.isPrimary && event.button === 0 && outside(event);
  }
  function cancel() {
    startedOutside = false;
  }
  function click(event: MouseEvent) {
    const shouldDismiss = startedOutside && outside(event);
    startedOutside = false;
    if (shouldDismiss) {
      event.stopPropagation();
      dismiss();
    }
  }
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click);
  return {
    update(next: () => void) {
      dismiss = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', click);
    },
  };
}
