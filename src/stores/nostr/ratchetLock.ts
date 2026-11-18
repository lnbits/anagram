// One tab owns this browser's ratchet checkpoints at a time.
export async function acquireRatchetLock(owner: string): Promise<() => void> {
  if (!globalThis.navigator?.locks)
    throw new Error('Double-ratchet messaging needs a browser with Web Locks support.');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(`anagram:ratchet:${owner}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(new Error('Double-ratchet messaging is already open in another tab.'));
          return;
        }
        resolve();
        await held;
      })
      .catch(reject);
  });
  return release;
}
