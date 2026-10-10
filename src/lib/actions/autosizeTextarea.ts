import { tick } from 'svelte';

/** Measure the rendered value, including programmatic clears and restored drafts. */
export function autosizeTextarea(node: HTMLTextAreaElement, _value: string) {
  let disposed = false;
  let queued = false;
  let frame = 0;
  let width = -1;

  async function schedule() {
    if (disposed || queued) return;
    queued = true;
    // Reactive statements run before bind:value updates the DOM. Measuring there
    // leaves an empty composer at the height of the message that was just sent.
    await tick();
    if (disposed) return;
    frame = requestAnimationFrame(() => {
      queued = false;
      frame = 0;
      if (disposed || !node.isConnected || node.clientWidth === 0) return;
      node.style.height = 'auto';
      // The CSS max-height caps growth and lets longer drafts scroll internally.
      node.style.height = `${node.scrollHeight}px`;
    });
  }

  const observer = new ResizeObserver(([entry]) => {
    if (!entry || entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    // Only width changes require rewrapping. Ignore our own height updates and
    // measure outside the observer callback to avoid resize feedback loops.
    void schedule();
  });
  observer.observe(node);
  void schedule();
  void document.fonts.ready.then(schedule);

  return {
    update(_value: string) {
      void schedule();
    },
    destroy() {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
