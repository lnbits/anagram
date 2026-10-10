export function buildAvatarText(value: string): string {
  const compactValue = value.replace(/\s+/g, ' ').trim();
  if (!compactValue) {
    return 'NA';
  }

  const parts = compactValue.split(' ');
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  return compactValue.slice(0, 2).toUpperCase();
}

export function avatarColor(value: string): string {
  let hash = 0;
  for (const ch of value.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return [
    '#d65563',
    '#d97706',
    '#7c3aed',
    '#2563eb',
    '#0f766e',
    '#4f46e5',
    '#db2777',
    '#059669',
    '#0284c7',
    '#c2410c',
    '#475569',
    '#b45309',
  ][hash % 12];
}
