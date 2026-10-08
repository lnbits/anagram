import { nearViewport } from '#src/lib/actions/nearViewport.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const node = {} as HTMLElement;

function stubIntersectionObserver() {
  type StubObserver = { callback: IntersectionObserverCallback; disconnect: () => void };
  const observers: StubObserver[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback, disconnect: this.disconnect });
      }
    },
  );
  const intersect = (isIntersecting: boolean) =>
    observers.at(-1)!.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  return { observers, intersect };
}

describe('nearViewport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires once, only when the node comes near the viewport, then stops watching', () => {
    const { observers, intersect } = stubIntersectionObserver();
    const onvisible = vi.fn();
    nearViewport(node, { rootMargin: '200px 0px', onvisible });

    intersect(false);
    expect(onvisible).not.toHaveBeenCalled();
    intersect(true);
    expect(onvisible).toHaveBeenCalledTimes(1);
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('ignores an entry delivered after the observer was stopped or destroyed', () => {
    const { observers, intersect } = stubIntersectionObserver();
    const onvisible = vi.fn();
    const action = nearViewport(node, { rootMargin: '0px', onvisible });

    action.destroy();
    intersect(true);
    expect(observers).toHaveLength(1);
    expect(onvisible).not.toHaveBeenCalled();

    // A restart replaces the observer; a late entry for the replaced one is ignored too.
    const restarted = nearViewport(node, { rootMargin: '0px', onvisible, enabled: true });
    restarted.update({ rootMargin: '100px', onvisible, enabled: true });
    observers[1].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    expect(onvisible).not.toHaveBeenCalled();
    intersect(true);
    expect(onvisible).toHaveBeenCalledTimes(1);
  });

  it('does not watch while disabled and stops watching when destroyed', () => {
    const { observers } = stubIntersectionObserver();
    const onvisible = vi.fn();
    const action = nearViewport(node, { rootMargin: '0px', onvisible, enabled: false });
    expect(observers).toHaveLength(0);

    action.update({ rootMargin: '0px', onvisible, enabled: true });
    expect(observers).toHaveLength(1);
    action.destroy();
    expect(observers[0].disconnect).toHaveBeenCalled();
    expect(onvisible).not.toHaveBeenCalled();
  });
});
