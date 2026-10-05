import { describe, expect, it } from 'vitest';
import { createActiveSpeakerSelector } from '../../src/utils/callActiveSpeaker';

describe('active speaker selection', () => {
  it('ignores noise and short interruptions, and holds through silence', () => {
    const select = createActiveSpeakerSelector();
    const levels = new Map([
      ['local', 0],
      ['peer', 0.01],
    ]);
    expect(select(levels, 0)).toBe('local');
    levels.set('peer', 0.2);
    expect(select(levels, 100)).toBe('local');
    expect(select(levels, 699)).toBe('local');
    expect(select(levels, 700)).toBe('peer');
    levels.set('peer', 0);
    expect(select(levels, 1000)).toBe('peer');
    levels.set('local', 0.3);
    expect(select(levels, 1100)).toBe('peer');
    expect(select(levels, 1700)).toBe('peer');
    expect(select(levels, 2200)).toBe('local');
  });
  it('falls back when the current participant leaves', () => {
    const select = createActiveSpeakerSelector();
    expect(select(new Map([['peer', 0.2]]), 0)).toBe('peer');
    expect(select(new Map([['local', 0]]), 100)).toBe('local');
  });
});
