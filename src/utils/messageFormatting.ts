import {
  buildMessageTextParts,
  withoutPreviewMediaUrls,
  type MessageTextPart,
} from './messageTextParts.ts';
import type { NostrMentionProfile } from './nostrMentions.ts';

export type MessageFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler';
export type FormattedMessagePart =
  | MessageTextPart
  | {
      type: 'format';
      key: string;
      text: string;
      format: MessageFormat;
      children: FormattedMessagePart[];
    }
  | { type: 'code'; key: string; text: string; block: boolean };
const markers: Record<string, MessageFormat> = {
  '**': 'bold',
  '*': 'italic',
  __: 'underline',
  _: 'italic',
  '~': 'strike',
  '~~': 'strike',
  '||': 'spoiler',
};
const word = (char: string | undefined) => !!char && /[\p{L}\p{N}_]/u.test(char);
const space = (char: string | undefined) => !char || /\s/u.test(char);

/** A small text-only grammar. No HTML parsing, arbitrary attributes or executable URLs. */
export function formatMessage(
  text: string,
  profiles: NostrMentionProfile[] = [],
): FormattedMessagePart[] {
  type Frame = { marker: string; start: number; children: FormattedMessagePart[] };
  const root: Frame = { marker: '', start: 0, children: [] };
  const stack = [root];
  let buffer = '',
    sequence = 0,
    cursor = 0,
    tokens = 0;
  const key = () => `formatted-${sequence++}`;
  const frame = () => stack[stack.length - 1];
  const plain = (value: string) =>
    buildMessageTextParts(value, profiles).map((part) => ({ ...part, key: key() }));
  const flush = () => {
    if (buffer) frame().children.push(...plain(buffer));
    buffer = '';
  };
  const urlPattern = /(?:https?:\/\/|www\.|anagram:\/\/room\/call\/)[^\s<>"'`]+/iy;
  while (cursor < text.length) {
    // Bound component count and nesting even for adversarial delimiter streams.
    if (tokens >= 1000) {
      flush();
      frame().children.push({ type: 'text', key: key(), text: text.slice(cursor) });
      break;
    }
    const rest = text.slice(cursor);
    if (text[cursor] === '\\' && /[\\*_~|`\[\]()]/.test(text[cursor + 1] ?? '')) {
      buffer += text[cursor + 1];
      cursor += 2;
      continue;
    }
    if ((cursor === 0 || text[cursor - 1] === '\n') && /^[*-] +(?=\S)/.test(rest)) {
      buffer += '• ';
      cursor += rest.match(/^[*-] +/)![0].length;
      continue;
    }
    urlPattern.lastIndex = cursor;
    const url = !word(text[cursor - 1]) && urlPattern.exec(text);
    if (url) {
      let value = url[0];
      const marker = frame().marker;
      if (marker) {
        let end = value.indexOf(marker);
        while (end > 0 && marker.includes('_') && word(value[end + marker.length]))
          end = value.indexOf(marker, end + marker.length);
        if (end > 0) value = value.slice(0, end);
      }
      flush();
      frame().children.push(...plain(value));
      cursor += value.length;
      tokens++;
      continue;
    }
    if (rest.startsWith('`')) {
      const fence = rest.startsWith('```') ? '```' : '`';
      const end = text.indexOf(fence, cursor + fence.length);
      if (
        end > cursor + fence.length &&
        (fence.length === 3 || !text.slice(cursor + 1, end).includes('\n'))
      ) {
        flush();
        let content = text.slice(cursor + fence.length, end);
        if (fence.length === 3)
          content = content.replace(/^(?:[a-zA-Z][\w+-]{0,30})?\r?\n/, '').replace(/\r?\n$/, '');
        frame().children.push({
          type: 'code',
          key: key(),
          text: content,
          block: fence.length === 3,
        });
        cursor = end + fence.length;
        tokens++;
        continue;
      }
      // An unmatched fence stays literal; don't reinterpret its remaining backticks.
      buffer += fence;
      cursor += fence.length;
      tokens++;
      continue;
    }
    if (text[cursor] === '[') {
      // Bounded label/destination scan; balanced URL parentheses are supported.
      const labelOffset = text.slice(cursor + 1, cursor + 2049).indexOf('](');
      const labelEnd = labelOffset < 0 ? -1 : cursor + 1 + labelOffset;
      if (labelEnd > cursor + 1 && labelEnd - cursor <= 2048) {
        let end = labelEnd + 2,
          depth = 1;
        for (; end < text.length && end - labelEnd <= 4096 && depth; end++) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')') depth--;
          if (/\s/.test(text[end])) break;
        }
        if (!depth) {
          const href = text.slice(labelEnd + 2, end - 1);
          let safe = false;
          try {
            const url = new URL(href);
            safe =
              /^https?:\/\//i.test(href) &&
              !url.username &&
              !url.password &&
              !/[\s\x00-\x1f\x7f]/.test(href);
          } catch {}
          flush();
          if (safe)
            frame().children.push({
              type: 'url',
              key: key(),
              text: text.slice(cursor + 1, labelEnd),
              href: new URL(href).href,
            });
          else frame().children.push({ type: 'text', key: key(), text: text.slice(cursor, end) });
          cursor = end;
          tokens++;
          continue;
        }
      }
      tokens++;
    }
    const marker =
      frame().marker && rest.startsWith(frame().marker) && !space(text[cursor - 1])
        ? frame().marker
        : ['**', '__', '||', '~~', '*', '_', '~'].find((value) => rest.startsWith(value));
    if (marker) {
      const previous = text[cursor - 1],
        next = text[cursor + marker.length];
      if (
        frame().marker === marker &&
        (marker === '||' || !space(previous)) &&
        (!marker.includes('_') || !word(next))
      ) {
        flush();
        const closed = stack.pop()!;
        frame().children.push({
          type: 'format',
          key: key(),
          format: markers[marker],
          text: text.slice(closed.start, cursor),
          children: closed.children,
        });
      } else if (
        (marker === '||' ? next !== undefined : !space(next)) &&
        (!marker.includes('_') || !word(previous)) &&
        stack.length < 9
      ) {
        flush();
        stack.push({ marker, start: cursor + marker.length, children: [] });
      } else buffer += marker;
      cursor += marker.length;
      tokens++;
      continue;
    }
    buffer += text[cursor++];
  }
  flush();
  while (stack.length > 1) {
    const unclosed = stack.pop()!;
    frame().children.push(
      { type: 'text', key: key(), text: unclosed.marker },
      ...unclosed.children,
    );
  }
  return root.children;
}

/** Code/spoiler URLs must not become automatic previews or visible attachments. */
export function messageFormatUrls(
  parts: FormattedMessagePart[],
  hidden = false,
  result = { visible: new Set<string>(), hidden: new Set<string>() },
) {
  for (const part of parts) {
    if (part.type === 'format')
      messageFormatUrls(part.children, hidden || part.format === 'spoiler', result);
    else if (part.type === 'code') {
      for (const link of buildMessageTextParts(part.text))
        if (link.type === 'url') result.hidden.add(link.href);
    } else if (part.type === 'url') (hidden ? result.hidden : result.visible).add(part.href);
  }
  return result;
}

/** Collapse after parsing so cutting a long spoiler/code block cannot expose its contents. */
export function collapseFormattedMessage(
  parts: FormattedMessagePart[],
  limit = 4096,
): FormattedMessagePart[] {
  let remaining = limit;
  function visit(nodes: FormattedMessagePart[]): FormattedMessagePart[] {
    const result: FormattedMessagePart[] = [];
    for (const part of nodes) {
      if (remaining <= 0) break;
      if (part.type === 'format') result.push({ ...part, children: visit(part.children) });
      else {
        result.push(
          part.text.length <= remaining
            ? part
            : { ...part, text: part.text.slice(0, remaining) + '…' },
        );
        remaining -= part.text.length;
      }
    }
    return result;
  }
  return visit(parts);
}

/** Remove duplicate media links without changing literal code, spoilers or link labels. */
export function withoutFormattedMediaUrls(
  parts: FormattedMessagePart[],
  attachments: ReadonlyArray<{ url: string; mimeType: string }>,
): FormattedMessagePart[] {
  if (!attachments.length) return parts;
  return parts.flatMap((part): FormattedMessagePart[] => {
    if (part.type === 'format' && part.format !== 'spoiler') {
      const children = withoutFormattedMediaUrls(part.children, attachments);
      return children.length ? [{ ...part, children }] : [];
    }
    if (part.type === 'url' && !withoutPreviewMediaUrls(part.text, attachments)) return [];
    return [part];
  });
}
