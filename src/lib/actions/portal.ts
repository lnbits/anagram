// Keep overlays outside message containment and scrolling ancestors.
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}
