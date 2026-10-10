export const ACCENT_STORAGE_KEY = 'ui-accent-color';
export const THEME_ACCENTS = [
  { id: 'default', swatch: '#5a9bd5', light: '#4fa9e6', dark: '#64b5f6' },
  { id: 'cyan', swatch: '#50bfdf', light: '#087e9b', dark: '#50bfdf' },
  { id: 'green', swatch: '#477346', light: '#39733f', dark: '#80bd83' },
  { id: 'pink', swatch: '#ad6484', light: '#a24372', dark: '#dc91b5' },
  { id: 'orange', swatch: '#aa733b', light: '#99601e', dark: '#dca365' },
  { id: 'purple', swatch: '#9580ba', light: '#7955a5', dark: '#b49bd9' },
  { id: 'red', swatch: '#b2554c', light: '#ae493e', dark: '#e68c82' },
  { id: 'slate', swatch: '#7086a3', light: '#566e8c', dark: '#9bb0cc' },
  { id: 'gold', swatch: '#a28b50', light: '#856c21', dark: '#cdb771' },
] as const;
export type ThemeAccent = (typeof THEME_ACCENTS)[number]['id'];

export function readThemeAccent(): ThemeAccent {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    return THEME_ACCENTS.find((accent) => accent.id === stored)?.id ?? 'default';
  } catch {
    return 'default';
  }
}

export function applyThemeAccent(value: ThemeAccent): void {
  if (typeof document === 'undefined') return;
  const accent = THEME_ACCENTS.find((accent) => accent.id === value) ?? THEME_ACCENTS[0];
  // No overrides for the original theme: keep both existing palettes exactly intact.
  if (accent.id === 'default') {
    delete document.body.dataset.accent;
    document.body.style.removeProperty('--theme-accent-light');
    document.body.style.removeProperty('--theme-accent-dark');
    return;
  }
  document.body.style.setProperty('--theme-accent-light', accent.light);
  document.body.style.setProperty('--theme-accent-dark', accent.dark);
  document.body.dataset.accent = accent.id;
}

export function saveThemeAccent(value: ThemeAccent): void {
  try {
    if (value === 'default') localStorage.removeItem(ACCENT_STORAGE_KEY);
    else localStorage.setItem(ACCENT_STORAGE_KEY, value);
  } catch {
    // The selection still works when browser storage is unavailable.
  }
  applyThemeAccent(value);
}
