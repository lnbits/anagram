import type { ContactRecord } from '#src/types/contact.ts';

export interface ContactListOptions {
  loggedInPubkey?: string | null;
  resolveNpub?: (publicKey: string) => string | null | undefined;
}

interface ContactSearchMatch {
  fieldIndex: number;
  matchIndex: number;
}

interface ContactSearchField {
  priority: number;
  value: string;
}

const HEX_CONTACT_NAME_PATTERN = /^[0-9a-f]{32,64}$/;

function normalizeContactText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeContactSearchQuery(value: unknown): string {
  return normalizeContactText(value).toLowerCase();
}

function normalizeLoggedInPubkey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolvedContactNpub(contact: ContactRecord, options: ContactListOptions = {}): string {
  const storedNpub = normalizeContactText(contact.meta.npub);
  if (storedNpub) {
    return storedNpub;
  }

  const resolvedNpub = options.resolveNpub?.(contact.public_key);
  return normalizeContactText(resolvedNpub);
}

function listCandidateValues(contact: ContactRecord, options: ContactListOptions = {}): string[] {
  return [
    normalizeContactText(contact.meta.name),
    normalizeContactText(contact.meta.about),
    normalizeContactText(contact.meta.nip05),
    resolvedContactNpub(contact, options),
  ].filter((value) => value.length > 0);
}

function appendUniqueSearchField(
  fields: ContactSearchField[],
  seen: Set<string>,
  priority: number,
  value: string
): void {
  const normalizedValue = normalizeContactText(value);
  if (!normalizedValue) {
    return;
  }

  const normalizedKey = normalizedValue.toLowerCase();
  if (seen.has(normalizedKey)) {
    return;
  }

  seen.add(normalizedKey);
  fields.push({
    priority,
    value: normalizedValue,
  });
}

function preferredSearchName(contact: ContactRecord): string {
  const metadataName = normalizeContactText(contact.meta.name);
  if (metadataName) {
    return metadataName;
  }

  const recordName = normalizeContactText(contact.name);
  if (!recordName) {
    return '';
  }

  return recordName.toLowerCase() === contact.public_key.trim().toLowerCase() ? '' : recordName;
}

function isLoggedInContact(contact: ContactRecord, options: ContactListOptions = {}): boolean {
  const loggedInPubkey = normalizeLoggedInPubkey(options.loggedInPubkey);
  if (!loggedInPubkey) {
    return false;
  }

  return contact.public_key.trim().toLowerCase() === loggedInPubkey;
}

function contactListBucket(contact: ContactRecord, options: ContactListOptions = {}): number {
  if (isLoggedInContact(contact, options)) {
    return 0;
  }

  const normalizedTitle = contactListTitle(contact, options).trim().toLowerCase();
  if (!normalizedTitle) {
    return 1;
  }

  if (HEX_CONTACT_NAME_PATTERN.test(normalizedTitle) || normalizedTitle.startsWith('npub')) {
    return 2;
  }

  return 1;
}

function findContactSearchMatch(
  contact: ContactRecord,
  query: string,
  options: ContactListOptions = {}
): ContactSearchMatch | null {
  const normalizedQuery = normalizeContactSearchQuery(query);
  if (!normalizedQuery) {
    return null;
  }

  const fields = buildPrioritizedContactSearchFields(contact, options);
  for (const field of fields) {
    const normalizedField = field.value.toLowerCase();
    const matchIndex = normalizedField.indexOf(normalizedQuery);
    if (matchIndex !== -1) {
      return { fieldIndex: field.priority, matchIndex };
    }
  }

  return null;
}

function buildPrioritizedContactSearchFields(
  contact: ContactRecord,
  options: ContactListOptions = {}
): ContactSearchField[] {
  const fields: ContactSearchField[] = [];
  const seen = new Set<string>();

  appendUniqueSearchField(fields, seen, 0, contact.given_name ?? '');
  appendUniqueSearchField(fields, seen, 1, preferredSearchName(contact));
  appendUniqueSearchField(fields, seen, 2, contact.meta.about ?? '');
  appendUniqueSearchField(fields, seen, 3, contact.meta.nip05 ?? '');
  appendUniqueSearchField(fields, seen, 4, contact.meta.lud16 ?? '');
  appendUniqueSearchField(fields, seen, 5, contact.meta.display_name ?? '');
  appendUniqueSearchField(fields, seen, 6, contact.meta.website ?? '');
  appendUniqueSearchField(fields, seen, 7, contact.meta.npub ?? '');
  appendUniqueSearchField(fields, seen, 8, resolvedContactNpub(contact, options));
  appendUniqueSearchField(fields, seen, 9, contact.public_key);

  return fields;
}

export function buildContactSearchFields(
  contact: ContactRecord,
  options: ContactListOptions = {}
): string[] {
  return buildPrioritizedContactSearchFields(contact, options).map((field) => field.value);
}

export function contactListTitle(contact: ContactRecord, options: ContactListOptions = {}): string {
  if (isLoggedInContact(contact, options)) {
    return 'My Self';
  }

  return listCandidateValues(contact, options)[0] ?? contact.public_key.trim().slice(0, 32);
}

export function contactListCaption(
  contact: ContactRecord,
  options: ContactListOptions = {}
): string {
  const candidates = listCandidateValues(contact, options);
  if (isLoggedInContact(contact, options)) {
    return candidates[0] ?? '';
  }

  return candidates[1] ?? '';
}

export function compareContactsForList(
  first: ContactRecord,
  second: ContactRecord,
  options: ContactListOptions = {}
): number {
  const byBucket = contactListBucket(first, options) - contactListBucket(second, options);
  if (byBucket !== 0) {
    return byBucket;
  }

  const byTitle = contactListTitle(first, options).localeCompare(
    contactListTitle(second, options),
    undefined,
    {
      sensitivity: 'base',
    }
  );
  if (byTitle !== 0) {
    return byTitle;
  }

  const byCaption = contactListCaption(first, options).localeCompare(
    contactListCaption(second, options),
    undefined,
    {
      sensitivity: 'base',
    }
  );
  if (byCaption !== 0) {
    return byCaption;
  }

  return first.public_key.localeCompare(second.public_key);
}

export function sortContactsForList(
  contacts: ContactRecord[],
  options: ContactListOptions = {}
): ContactRecord[] {
  return [...contacts].sort((first, second) => compareContactsForList(first, second, options));
}

export function searchContactsForList(
  contacts: ContactRecord[],
  query: string,
  options: ContactListOptions = {}
): ContactRecord[] {
  const normalizedQuery = normalizeContactSearchQuery(query);
  if (!normalizedQuery) {
    return sortContactsForList(contacts, options);
  }

  return contacts
    .map((contact) => ({
      contact,
      match: findContactSearchMatch(contact, normalizedQuery, options),
    }))
    .filter(
      (entry): entry is { contact: ContactRecord; match: ContactSearchMatch } =>
        entry.match !== null
    )
    .sort((first, second) => {
      const byBucket =
        contactListBucket(first.contact, options) - contactListBucket(second.contact, options);
      if (byBucket !== 0) {
        return byBucket;
      }

      const byFieldIndex = first.match.fieldIndex - second.match.fieldIndex;
      if (byFieldIndex !== 0) {
        return byFieldIndex;
      }

      const byMatchIndex = first.match.matchIndex - second.match.matchIndex;
      if (byMatchIndex !== 0) {
        return byMatchIndex;
      }

      return compareContactsForList(first.contact, second.contact, options);
    })
    .map((entry) => entry.contact);
}
