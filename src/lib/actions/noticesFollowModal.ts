// A modal <dialog> makes the rest of the page inert: hidden behind the top layer
// and silent to assistive technology. While one is open, move the single aria-live
// notices region inside it so toasts stay visible and announced; move it back on close.
function topmostModal(): HTMLDialogElement | undefined {
  return [...document.querySelectorAll('dialog')].reverse().find((dialog) => {
    try {
      return dialog.matches(':modal');
    } catch {
      return false;
    }
  });
}

export function noticesFollowModal(node: HTMLElement, _count: number) {
  const home = node.parentElement;
  let host: HTMLDialogElement | undefined;
  function returnHome() {
    host?.removeEventListener('close', returnHome);
    host = undefined;
    if (home && node.parentElement !== home) home.append(node);
  }
  function place() {
    const modal = topmostModal();
    if (modal === host) return;
    returnHome();
    if (!modal) return;
    host = modal;
    modal.append(node);
    modal.addEventListener('close', returnHome);
  }
  return { update: place, destroy: returnHome };
}
