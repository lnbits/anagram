export function chatDate(value: string, locale: string): string {
  const date = new Date(value);
  return date.toLocaleDateString(locale, {
    day: '2-digit',
    month: 'long',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}
