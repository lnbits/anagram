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
      loudest[1] < 0.025 ||
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
