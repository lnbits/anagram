import {
  getWrappedThreadSearchIndex,
  resolveThreadSearchNavigationIndex,
} from '#src/utils/threadSearch.ts';
import { describe, expect, it } from 'vitest';

describe('threadSearch utils', () => {
  it('wraps search match indexes within the available result count', () => {
    expect(getWrappedThreadSearchIndex(-1, 3)).toBe(2);
    expect(getWrappedThreadSearchIndex(3, 3)).toBe(0);
    expect(getWrappedThreadSearchIndex(1, 3)).toBe(1);
    expect(getWrappedThreadSearchIndex(0, 0)).toBe(-1);
  });

  it('moves previous to older matches and next to newer matches', () => {
    expect(resolveThreadSearchNavigationIndex(0, 4, 'previous')).toBe(1);
    expect(resolveThreadSearchNavigationIndex(1, 4, 'previous')).toBe(2);
    expect(resolveThreadSearchNavigationIndex(2, 4, 'next')).toBe(1);
    expect(resolveThreadSearchNavigationIndex(0, 4, 'next')).toBe(3);
  });

  it('starts previous at the oldest match and next at the newest match when nothing is active', () => {
    expect(resolveThreadSearchNavigationIndex(-1, 4, 'previous')).toBe(3);
    expect(resolveThreadSearchNavigationIndex(-1, 4, 'next')).toBe(0);
    expect(resolveThreadSearchNavigationIndex(-1, 0, 'previous')).toBe(-1);
  });
});
