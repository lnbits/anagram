interface OutsideDismissOptions {
  dismiss: () => void;
  trigger?: HTMLElement;
}

/** Attach only while the popup is mounted; its trigger retains normal toggle behavior. */
export function dismissOnOutside(node: HTMLElement, options: OutsideDismissOptions) {
  const document = node.ownerDocument;
  function click(event: MouseEvent) {
    const path = event.composedPath();
    if (!path.includes(node) && (!options.trigger || !path.includes(options.trigger)))
      options.dismiss();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    options.dismiss();
    options.trigger?.focus({ preventScroll: true });
  }
  // Capture observes clicks even when the clicked control stops propagation.
  // Do not consume the event: the outside control must still perform its action.
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', keydown);
  return {
    update(next: OutsideDismissOptions) {
      options = next;
    },
    destroy() {
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', keydown);
    },
  };
}
