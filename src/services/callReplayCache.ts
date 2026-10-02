// Per-account, short-lived control IDs survive a reload. No media or Iroh addresses are saved.
const PREFIX = 'anagram:call-controls:';
function read(owner: string): Record<string, number> {
  try {
    const value = JSON.parse(sessionStorage.getItem(PREFIX + owner) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && entry[1] > Date.now()
        )
        .slice(-256)
    );
  } catch {
    return {};
  }
}
export function hasSeenCallControl(owner: string, peer: string, id: string): boolean {
  return Boolean(read(owner)[`${peer}:${id}`]);
}
export function rememberCallControl(owner: string, peer: string, id: string): void {
  try {
    const entries = read(owner);
    entries[`${peer}:${id}`] = Date.now() + 120_000;
    sessionStorage.setItem(
      PREFIX + owner,
      JSON.stringify(Object.fromEntries(Object.entries(entries).slice(-256)))
    );
  } catch {
    /* Memory-only replay checks still apply when storage is unavailable. */
  }
}
