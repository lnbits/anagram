// The sidebar sits at the inline start: the left edge in LTR, the right edge in RTL.
export function isRtlDocument(): boolean {
  return getComputedStyle(document.documentElement).direction === 'rtl';
}

export function sidebarWidthFromPointer(clientX: number, viewportWidth: number, rtl: boolean) {
  return rtl ? viewportWidth - clientX : clientX;
}

/** Arrow toward the content panel grows the sidebar; the other arrow shrinks it. */
export function sidebarKeyDelta(key: string, rtl: boolean, step = 16): number {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return 0;
  return (key === 'ArrowRight') !== rtl ? step : -step;
}
