export interface IrohRelayEntry {
  url: string;
  enabled: boolean;
}
export const PUBLIC_IROH_RELAYS = [
  'https://use1-1.relay.n0.iroh.link/',
  'https://usw1-1.relay.n0.iroh.link/',
  'https://euc1-1.relay.n0.iroh.link/',
  'https://aps1-1.relay.n0.iroh.link/',
];
export function normalizeIrohRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.hostname.endsWith('.')
    )
      return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}
export function normalizeIrohRelays(value: unknown): IrohRelayEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 21) return null;
  const result: IrohRelayEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.enabled !== 'boolean') return null;
    const url = normalizeIrohRelayUrl(entry.url);
    if (!url || seen.has(url)) return null;
    seen.add(url);
    result.push({ url, enabled: entry.enabled });
  }
  return result.some((entry) => entry.enabled) ? result : null;
}
export const SHARED_IROH_RELAYS = ['https://iroh.nostr.com/', ...PUBLIC_IROH_RELAYS];
export type IrohRelayMode = 'pool' | 'pool-custom' | 'custom';
export interface IrohRelaySettings {
  mode: IrohRelayMode;
  customRelays: string[];
}

export function defaultIrohRelays(): IrohRelayEntry[] {
  // Deployments and local tests may explicitly replace the entire built-in pool.
  const configured = process.env.APP_IROH_RELAY_URL?.trim();
  if (!configured) return SHARED_IROH_RELAYS.map((url) => ({ url, enabled: true }));
  const url = normalizeIrohRelayUrl(configured);
  if (!url) throw new Error('Iroh calls require a valid HTTPS relay URL');
  return [{ url, enabled: true }];
}
export function isSharedIrohRelay(value: string): boolean {
  const normalized = normalizeIrohRelayUrl(value);
  if (!normalized) return false;
  const host = new URL(normalized).hostname;
  return [...SHARED_IROH_RELAYS, ...defaultIrohRelays().map((entry) => entry.url)].some(
    (url) => new URL(url).hostname === host
  );
}
export function normalizeIrohRelaySettings(value: unknown): IrohRelaySettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as IrohRelaySettings;
  if (
    !['pool', 'pool-custom', 'custom'].includes(v.mode) ||
    !Array.isArray(v.customRelays) ||
    v.customRelays.length > 16
  )
    return null;
  const urls = v.customRelays.map(normalizeIrohRelayUrl);
  if (
    urls.some((url) => !url || isSharedIrohRelay(url)) ||
    new Set(urls).size !== urls.length ||
    (v.mode !== 'pool' && urls.length === 0)
  )
    return null;
  return { mode: v.mode, customRelays: urls as string[] };
}
export function migrateIrohRelaySettings(value: unknown): IrohRelaySettings {
  const entries = normalizeIrohRelays(value);
  if (!entries) return { mode: 'pool', customRelays: [] };
  const active = entries.filter((entry) => entry.enabled);
  const customRelays = active
    .filter((entry) => !isSharedIrohRelay(entry.url))
    .map((entry) => entry.url);
  const pool = active.some((entry) => isSharedIrohRelay(entry.url));
  return { mode: customRelays.length ? (pool ? 'pool-custom' : 'custom') : 'pool', customRelays };
}
export function resolveIrohRelays(settings: IrohRelaySettings): IrohRelayEntry[] {
  const valid = normalizeIrohRelaySettings(settings);
  if (!valid) throw new Error('Invalid call relay settings');
  return [
    ...(valid.mode === 'custom' ? [] : defaultIrohRelays()),
    ...(valid.mode === 'pool' ? [] : valid.customRelays.map((url) => ({ url, enabled: true }))),
  ];
}
