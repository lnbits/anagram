// Random identifiers shown to users. Crockford base-32 avoids look-alike letters (I, L, O, U).
import { randomInt } from 'node:crypto';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHAR = '[0-9A-HJKMNP-TV-Z]';
// AG-7K92: the internal issue reference. Stable for a draft and shown on GitHub.
export const REF = new RegExp(`^AG-${CHAR}{4}$`);
// K3P9QX: the confirmation code of one draft revision. Changes on every edit.
export const CODE = new RegExp(`^${CHAR}{6}$`);

const random = (length) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

// taken(id) reports identifiers already in use (drafts in memory and persisted records).
export function uniqueId(prefix, length, taken) {
  for (let i = 0; i < 1000; i++) {
    const id = `${prefix}${random(length)}`;
    if (!taken(id)) return id;
  }
  throw new Error('Could not allocate a unique identifier.');
}
export const newRef = (taken) => uniqueId('AG-', 4, taken);
export const newCode = (taken) => uniqueId('', 6, taken);

// Users may type identifiers in lower case. Unknown shapes return undefined.
export function normalizeRef(value) {
  const id = String(value ?? '')
    .trim()
    .toUpperCase();
  return REF.test(id) ? id : undefined;
}
export function normalizeCode(value) {
  const id = String(value ?? '')
    .trim()
    .toUpperCase();
  return CODE.test(id) ? id : undefined;
}
