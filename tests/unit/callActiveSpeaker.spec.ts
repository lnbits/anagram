import { describe, expect, it } from 'vitest';
import {
  createActiveSpeakerSelector,
  createSpeakingTracker,
} from '../../src/utils/callActiveSpeaker';

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

describe('speaking indicator', () => {
  it('ignores single noise spikes, holds through pauses and clears after silence', () => {
    const track = createSpeakingTracker();
    const levels = new Map([
      ['local', 0],
      ['peer', 0.2],
    ]);
    expect(track(levels, 'peer', 0).size).toBe(0);
    levels.set('peer', 0);
    expect(track(levels, 'peer', 100).size).toBe(0);
    expect(track(levels, 'peer', 800).size).toBe(0);
    levels.set('peer', 0.2);
    track(levels, 'peer', 1000);
    const speaking = track(levels, 'peer', 1100);
    expect([...speaking]).toEqual(['peer']);
    levels.set('peer', 0.01);
    // A pause between words keeps the same set, so the UI does not update.
    expect(track(levels, 'peer', 1500)).toBe(speaking);
    expect(track(levels, 'local', 1700)).toBe(speaking);
    expect(track(levels, 'local', 1800).size).toBe(0);
  });
  it('marks several speakers and forgets participants who leave', () => {
    const track = createSpeakingTracker();
    const levels = new Map([
      ['local', 0.1],
      ['peer', 0.1],
    ]);
    for (const at of [0, 100]) {
      track(levels, 'local', at);
      track(levels, 'peer', at);
    }
    expect([...track(levels, 'peer', 150)].sort()).toEqual(['local', 'peer']);
    levels.delete('peer');
    expect([...track(levels, 'local', 200)]).toEqual(['local']);
  });
  it('starts on two consecutive samples despite timer jitter, not on separate spikes', () => {
    const levels = new Map([['peer', 0.2]]);
    for (const gap of [99, 60, 140]) {
      const track = createSpeakingTracker();
      track(levels, 'peer', 1000);
      expect([...track(levels, 'peer', 1000 + gap)]).toEqual(['peer']);
    }
    const track = createSpeakingTracker();
    track(levels, 'peer', 0);
    levels.set('peer', 0);
    track(levels, 'peer', 100);
    track(levels, 'peer', 200);
    levels.set('peer', 0.2);
    // A second spike after a quiet sample is noise, but it can begin real speech.
    expect(track(levels, 'peer', 300).size).toBe(0);
    expect([...track(levels, 'peer', 400)]).toEqual(['peer']);
  });
  it('clears a speaker whose metering stops at once, and does not restore them', () => {
    const track = createSpeakingTracker();
    const levels = new Map([['remote', 0.2]]);
    track(levels, 'remote', 0);
    expect([...track(levels, 'remote', 100)]).toEqual(['remote']);
    // Metering stops mid-speech, well inside the hold: no later sample is needed.
    levels.delete('remote');
    expect(track(levels, 'remote', 150).size).toBe(0);
    // Resumed metering starts from silence, and one loud sample is not speech.
    levels.set('remote', 0);
    expect(track(levels, 'remote', 200).size).toBe(0);
    levels.set('remote', 0.2);
    expect(track(levels, 'remote', 300).size).toBe(0);
    expect([...track(levels, 'remote', 400)]).toEqual(['remote']);
  });
  it('holds speech for exactly the silence window', () => {
    const track = createSpeakingTracker();
    const levels = new Map([['peer', 0.2]]);
    track(levels, 'peer', 0);
    const speaking = track(levels, 'peer', 100);
    levels.set('peer', 0);
    expect(track(levels, 'peer', 799)).toBe(speaking);
    expect(track(levels, 'peer', 800).size).toBe(0);
    // After the hold ends, speech must start over with two samples.
    levels.set('peer', 0.2);
    expect(track(levels, 'peer', 900).size).toBe(0);
    expect([...track(levels, 'peer', 1000)]).toEqual(['peer']);
  });
});
