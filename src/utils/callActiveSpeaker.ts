/** Quietest meter level treated as speech rather than background noise. */
const SPEECH_LEVEL = 0.025;

/** Hold the current speaker through pauses; require sustained, clearly louder speech to switch. */
export function createActiveSpeakerSelector() {
  let current = 'local';
  let candidate = '';
  let since = 0;
  let switchedAt = -Infinity;
  return (levels: ReadonlyMap<string, number>, now: number): string => {
    if (!levels.has(current)) current = levels.keys().next().value ?? 'local';
    const loudest = [...levels].sort((a, b) => b[1] - a[1])[0];
    if (
      !loudest ||
      loudest[1] < SPEECH_LEVEL ||
      loudest[0] === current ||
      loudest[1] < (levels.get(current) ?? 0) * 1.5
    ) {
      candidate = '';
      return current;
    }
    if (candidate !== loudest[0]) {
      candidate = loudest[0];
      since = now;
    }
    if (now - since >= 600 && now - switchedAt >= 1500) {
      current = candidate;
      switchedAt = now;
      candidate = '';
    }
    return current;
  };
}

/**
 * Who is speaking now, updated as one participant's level is reported. Speech
 * must last two consecutive meter samples to start and holds through the gaps
 * between words. The same set is returned until its membership changes.
 */
export function createSpeakingTracker(hold = 700, sample = 100) {
  const bursts = new Map<string, { since: number; last: number }>();
  let speaking: ReadonlySet<string> = new Set();
  // Meter timers fire a little early or late; allow half a sample either way.
  const started = (burst: { since: number; last: number }) =>
    burst.last - burst.since >= sample / 2;
  return (levels: ReadonlyMap<string, number>, id: string, now: number) => {
    for (const key of bursts.keys()) if (!levels.has(key)) bursts.delete(key);
    if ((levels.get(id) ?? 0) >= SPEECH_LEVEL) {
      const burst = bursts.get(id);
      if (burst && now - burst.last < (started(burst) ? hold : sample * 1.5)) burst.last = now;
      else bursts.set(id, { since: now, last: now });
    }
    const next = new Set(
      [...bursts]
        .filter(([, burst]) => now - burst.last < hold && started(burst))
        .map(([key]) => key),
    );
    if (next.size !== speaking.size || [...next].some((key) => !speaking.has(key))) speaking = next;
    return speaking;
  };
}
