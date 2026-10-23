import { sidebarKeyDelta, sidebarWidthFromPointer } from '#src/utils/sidebarResize.ts';
import { describe, expect, it } from 'vitest';

describe('sidebar resize direction', () => {
  it('measures the width from the inline-start edge', () => {
    expect(sidebarWidthFromPointer(320, 1280, false)).toBe(320);
    expect(sidebarWidthFromPointer(960, 1280, true)).toBe(320);
  });

  it('grows the sidebar with the arrow that points toward the content', () => {
    expect(sidebarKeyDelta('ArrowRight', false)).toBe(16);
    expect(sidebarKeyDelta('ArrowLeft', false)).toBe(-16);
    expect(sidebarKeyDelta('ArrowLeft', true)).toBe(16);
    expect(sidebarKeyDelta('ArrowRight', true)).toBe(-16);
    expect(sidebarKeyDelta('Home', false)).toBe(0);
  });
});
