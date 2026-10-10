/** Untrusted profile metadata and relay errors can contain credentials or keys. */
export function diagnosticText(value: string): string {
  return value
    .replace(/nsec1[023456789acdefghjklmnpqrstuvwxyz]+/gi, '[redacted-nsec]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-key]')
    .replace(/\b(?:https?|wss?|bunker|nostrconnect):\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        const credentials = Boolean(url.username || url.password);
        const parameters = Boolean(url.search || url.hash);
        if (!credentials && !parameters) return value;
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return `${url.protocol}//${credentials ? '[redacted]@' : ''}${url.host}${url.pathname}${parameters ? '?[redacted]' : ''}`;
      } catch {
        return '[redacted-url]';
      }
    });
}
/** Redact at the display/export boundary, including arbitrary object field names. */
export function diagnosticJson(value: unknown): string {
  const parents = new WeakSet<object>();
  function sanitize(item: unknown, depth = 0): unknown {
    if (typeof item === 'string') return diagnosticText(item);
    if (!item || typeof item !== 'object') return item;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return '[redacted-bytes]';
    if (item instanceof SyntaxError)
      return { name: 'SyntaxError', message: '[redacted-parser-error]' };
    if (item instanceof Error)
      return { name: diagnosticText(item.name), message: diagnosticText(item.message) };
    if (item instanceof Date) return item.toISOString();
    if (parents.has(item)) return '[circular]';
    if (depth > 12) return '[max-depth]';
    parents.add(item);
    const result = Array.isArray(item)
      ? item.map((entry) => sanitize(entry, depth + 1))
      : Object.fromEntries(
          Object.entries(item).map(([key, entry]) => [
            diagnosticText(key),
            /private.?key|secret|nsec|password|token|credential|seed|payload|^(content|tags|lastMessage|messageText)$/i.test(
              key,
            )
              ? '[redacted]'
              : sanitize(entry, depth + 1),
          ]),
        );
    parents.delete(item);
    return result;
  }
  return JSON.stringify(sanitize(value), null, 2);
}
