// Keep keyboard navigation inside the foremost expanded call dialog. Compact
// calls release focus back to the chat; hiding controls excludes their buttons.
export function callDialogFocus(node: HTMLElement, enabled = true) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  node.dataset.callDialog = '';
  function visible(element: HTMLElement) {
    return (
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[inert]')
    );
  }
  function topmost() {
    return (
      [...document.querySelectorAll<HTMLElement>('[data-call-dialog]')].filter(visible).at(-1) ===
      node
    );
  }
  function candidates() {
    return [
      ...node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
      ),
    ].filter(visible);
  }
  function enter() {
    queueMicrotask(() => {
      if (enabled && topmost()) (candidates()[0] ?? node).focus();
    });
  }
  function keydown(event: KeyboardEvent) {
    if (!enabled || !topmost() || event.key !== 'Tab') return;
    const items = candidates(),
      first = items[0],
      last = items.at(-1),
      current = document.activeElement;
    if (!first) {
      event.preventDefault();
      node.focus();
    } else if (!node.contains(current) || (!event.shiftKey && current === last)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (current === first || current === node)) {
      event.preventDefault();
      last?.focus();
    }
  }
  document.addEventListener('keydown', keydown);
  enter();
  return {
    update(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      if (next) enter();
      else previous?.focus();
    },
    destroy() {
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    },
  };
}
