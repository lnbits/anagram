import { isValidPubkey, nip19, normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import type {
  ContactBirthday,
  ContactGroupMember,
  ContactMetadata,
  ContactRelay,
} from 'src/types/contact';

export interface NpubValidationResult {
  isValid: boolean;
  normalizedPubkey: string | null;
}

export type PrivateKeyFormat = 'nsec' | 'hex';

export interface PrivateKeyValidationResult {
  isValid: boolean;
  hexPrivateKey: string | null;
  format: PrivateKeyFormat | null;
}

export type NsecValidationResult = PrivateKeyValidationResult;

export interface RelayListEntryLike {
  url: string;
  read: boolean;
  write: boolean;
}

export interface RelayListMetadataEntryLike {
  url: string;
  read?: boolean;
  write?: boolean;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class InputSanitizerService {
  normalizeUrl(value: string): string {
    return value.trim();
  }

  readOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized || undefined;
  }

  normalizePositiveInteger(value: unknown): number | undefined {
    const normalizedValue = Number(value);
    if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
      return undefined;
    }

    return Math.floor(normalizedValue);
  }

  normalizeHexKey(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
  }

  normalizePublicKey(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    return normalized || null;
  }

  normalizeRelayWs(value: string): string | null {
    const normalized = value.trim();
    return normalized || null;
  }

  normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const uniqueValues = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue;
      }

      const normalized = entry.trim();
      if (!normalized) {
        continue;
      }

      uniqueValues.add(normalized);
    }

    return Array.from(uniqueValues);
  }

  normalizeRelayListEntry(entry: unknown): RelayListEntryLike | null {
    if (typeof entry === 'string') {
      const url = entry.trim();
      if (!url) {
        return null;
      }

      return {
        url,
        read: true,
        write: true,
      };
    }

    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const value = entry as Partial<RelayListEntryLike>;
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (!url) {
      return null;
    }

    return {
      url,
      read: typeof value.read === 'boolean' ? value.read : true,
      write: typeof value.write === 'boolean' ? value.write : true,
    };
  }

  normalizeContactRelayUrl(relay: ContactRelay): string | null {
    return this.normalizeRelayWs(relay.url);
  }

  normalizeContactRelayUrls(relays: ContactRelay[]): string[] {
    const uniqueRelays = new Set<string>();

    for (const relay of relays) {
      const normalizedRelay = this.normalizeContactRelayUrl(relay);
      if (!normalizedRelay) {
        continue;
      }

      uniqueRelays.add(normalizedRelay);
    }

    return Array.from(uniqueRelays);
  }

  normalizeRelayEntriesFromUrls(relayUrls: string[]): ContactRelay[] {
    const uniqueRelays = new Set<string>();
    for (const relayUrl of relayUrls) {
      const normalizedRelay = relayUrl.trim();
      if (!normalizedRelay) {
        continue;
      }

      uniqueRelays.add(normalizedRelay);
    }

    return Array.from(uniqueRelays).map((url) => ({
      url,
      read: true,
      write: true,
    }));
  }

  normalizeRelayListMetadataEntries(entries: RelayListMetadataEntryLike[]): ContactRelay[] {
    const uniqueRelays = new Map<string, ContactRelay>();

    for (const entry of entries) {
      if (!entry || typeof entry.url !== 'string') {
        continue;
      }

      const rawRelayUrl = entry.url.trim();
      if (!rawRelayUrl) {
        continue;
      }

      let normalizedRelayWs: string;
      try {
        normalizedRelayWs = normalizeRelayUrl(rawRelayUrl);
      } catch {
        continue;
      }

      const read = entry.read !== false;
      const write = entry.write !== false;
      if (!read && !write) {
        continue;
      }

      const existing = uniqueRelays.get(normalizedRelayWs);
      if (existing) {
        existing.read = existing.read || read;
        existing.write = existing.write || write;
        continue;
      }

      uniqueRelays.set(normalizedRelayWs, {
        url: normalizedRelayWs,
        read,
        write,
      });
    }

    return Array.from(uniqueRelays.values());
  }

  normalizeReadableRelayUrls(relays: ContactRelay[] | undefined): string[] {
    if (!Array.isArray(relays)) {
      return [];
    }

    const uniqueRelays = new Set<string>();
    for (const relay of relays) {
      if (!relay || relay.read === false) {
        continue;
      }

      const relayUrl = typeof relay.url === 'string' ? relay.url.trim() : '';
      if (!relayUrl) {
        continue;
      }

      try {
        uniqueRelays.add(normalizeRelayUrl(relayUrl));
      } catch {}
    }

    return Array.from(uniqueRelays);
  }

  normalizeContactBirthday(value: unknown): ContactBirthday | undefined {
    if (!isPlainObject(value)) {
      return undefined;
    }

    const birthday: ContactBirthday = {};
    const year = value.year;
    const month = value.month;
    const day = value.day;

    if (typeof year === 'number' && Number.isInteger(year)) {
      birthday.year = year;
    }

    if (typeof month === 'number' && Number.isInteger(month)) {
      birthday.month = month;
    }

    if (typeof day === 'number' && Number.isInteger(day)) {
      birthday.day = day;
    }

    return Object.keys(birthday).length > 0 ? birthday : undefined;
  }

  normalizeContactGroupMembers(value: unknown): ContactGroupMember[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const uniqueMembers = new Map<string, ContactGroupMember>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const rawMember = entry as Partial<ContactGroupMember>;
      const publicKey = this.normalizeHexKey(
        typeof rawMember.public_key === 'string' ? rawMember.public_key : ''
      );
      if (!publicKey) {
        continue;
      }

      const name = (typeof rawMember.name === 'string' ? rawMember.name.trim() : '') || publicKey;
      const givenName =
        typeof rawMember.given_name === 'string' ? rawMember.given_name.trim() || null : null;
      const picture = this.readOptionalString(rawMember.picture);
      const avatar = this.readOptionalString(rawMember.avatar);
      const about = this.readOptionalString(rawMember.about);
      const nip05 = this.readOptionalString(rawMember.nip05);
      const nprofile = this.readOptionalString(rawMember.nprofile);

      uniqueMembers.set(publicKey, {
        public_key: publicKey,
        name,
        given_name: givenName,
        ...(picture ? { picture } : {}),
        ...(avatar ? { avatar } : {}),
        ...(about ? { about } : {}),
        ...(nip05 ? { nip05 } : {}),
        ...(nprofile ? { nprofile } : {}),
      });
    }

    return Array.from(uniqueMembers.values());
  }

  normalizeContactMetadata(value: unknown): ContactMetadata {
    if (!isPlainObject(value)) {
      return {};
    }

    const meta: ContactMetadata = {};
    for (const key of ['general_relay_entries', 'dm_receive_relay_entries'] as const) {
      if (Array.isArray(value[key]))
        meta[key] = this.normalizeRelayListMetadataEntries(value[key] as ContactRelay[]);
    }
    const name = this.readOptionalString(value.name);
    const about = this.readOptionalString(value.about);
    const picture = this.readOptionalString(value.picture);
    const nip05 = this.readOptionalString(value.nip05);
    const npub = this.readOptionalString(value.npub);
    const nprofile = this.readOptionalString(value.nprofile);
    const lud06 = this.readOptionalString(value.lud06);
    const lud16 = this.readOptionalString(value.lud16);
    const displayName = this.readOptionalString(value.display_name);
    const website = this.readOptionalString(value.website);
    const banner = this.readOptionalString(value.banner);
    const chatId = this.readOptionalString(value.chatId);
    const avatar = this.readOptionalString(value.avatar);
    const lastSeenIncomingActivityAt = this.readOptionalString(
      value.last_seen_incoming_activity_at
    );
    const lastSeenIncomingActivityEventId = this.readOptionalString(
      value.last_seen_incoming_activity_event_id
    );
    const profileEventCreatedAt = this.normalizePositiveInteger(value.profile_event_created_at);
    const relayListEventCreatedAt = this.normalizePositiveInteger(
      value.relay_list_event_created_at
    );
    const privateContactListMember =
      typeof value.private_contact_list_member === 'boolean'
        ? value.private_contact_list_member
        : null;
    const muted = typeof value.muted === 'boolean' ? value.muted : null;
    const blocked = typeof value.blocked === 'boolean' ? value.blocked : null;
    const blockedAt = this.readOptionalString(value.blocked_at);
    const groupPrivateKeyEncrypted = this.readOptionalString(value.group_private_key_encrypted);
    const ownerPublicKey = this.normalizeHexKey(
      typeof value.owner_public_key === 'string' ? value.owner_public_key : ''
    );
    const birthday = this.normalizeContactBirthday(value.birthday);
    const groupMembers = this.normalizeContactGroupMembers(value.group_members);

    if (name) {
      meta.name = name;
    }

    if (about) {
      meta.about = about;
    }

    if (picture) {
      meta.picture = picture;
    }

    if (nip05) {
      meta.nip05 = nip05;
    }

    if (npub) {
      meta.npub = npub;
    }

    if (nprofile) {
      meta.nprofile = nprofile;
    }

    if (lud06) {
      meta.lud06 = lud06;
    }

    if (lud16) {
      meta.lud16 = lud16;
    }

    if (displayName) {
      meta.display_name = displayName;
    }

    if (website) {
      meta.website = website;
    }

    if (banner) {
      meta.banner = banner;
    }

    if (typeof value.bot === 'boolean') {
      meta.bot = value.bot;
    }

    if (typeof value.group === 'boolean') {
      meta.group = value.group;
    }

    if (birthday) {
      meta.birthday = birthday;
    }

    if (chatId) {
      meta.chatId = chatId;
    }

    if (avatar) {
      meta.avatar = avatar;
    }

    if (lastSeenIncomingActivityAt) {
      meta.last_seen_incoming_activity_at = lastSeenIncomingActivityAt;
    }

    if (lastSeenIncomingActivityEventId) {
      meta.last_seen_incoming_activity_event_id = lastSeenIncomingActivityEventId;
    }

    if (profileEventCreatedAt) {
      meta.profile_event_created_at = profileEventCreatedAt;
    }

    if (relayListEventCreatedAt) {
      meta.relay_list_event_created_at = relayListEventCreatedAt;
    }

    if (typeof privateContactListMember === 'boolean') {
      meta.private_contact_list_member = privateContactListMember;
    }

    if (typeof muted === 'boolean') {
      meta.muted = muted;
    }

    if (typeof blocked === 'boolean') {
      meta.blocked = blocked;
    }

    if (blockedAt) {
      meta.blocked_at = blockedAt;
    }

    if (groupPrivateKeyEncrypted) {
      meta.group_private_key_encrypted = groupPrivateKeyEncrypted;
    }

    if (ownerPublicKey) {
      meta.owner_public_key = ownerPublicKey;
    }

    if (groupMembers.length > 0) {
      meta.group_members = groupMembers;
    }

    return meta;
  }

  parseStoredContactMetadata(value: unknown): ContactMetadata {
    if (typeof value !== 'string') {
      return this.normalizeContactMetadata(value);
    }

    if (!value.trim()) {
      return {};
    }

    try {
      return this.normalizeContactMetadata(JSON.parse(value));
    } catch {
      return {};
    }
  }

  serializeContactMetadata(meta: ContactMetadata | undefined): string {
    return JSON.stringify(this.normalizeContactMetadata(meta ?? {}));
  }

  extractNip05Name(identifier: string): string | null {
    const [namePart] = identifier.split('@');
    const normalized = namePart?.trim();
    return normalized || null;
  }

  validateNsec(input: string): NsecValidationResult {
    const value = input.trim();
    if (!value) {
      return { isValid: false, hexPrivateKey: null, format: null };
    }

    try {
      const decoded = nip19.decode(value);
      if (decoded.type !== 'nsec') {
        return { isValid: false, hexPrivateKey: null, format: null };
      }

      const data = decoded.data as unknown;
      if (data instanceof Uint8Array) {
        if (data.length !== 32) {
          return { isValid: false, hexPrivateKey: null, format: null };
        }

        return { isValid: true, hexPrivateKey: bytesToHex(data), format: 'nsec' };
      }

      if (typeof data === 'string') {
        const normalized = this.normalizeHexKey(data);
        return {
          isValid: Boolean(normalized),
          hexPrivateKey: normalized,
          format: normalized ? 'nsec' : null,
        };
      }

      return { isValid: false, hexPrivateKey: null, format: null };
    } catch {
      return { isValid: false, hexPrivateKey: null, format: null };
    }
  }

  validatePrivateKey(input: string): PrivateKeyValidationResult {
    const normalizedHexKey = this.normalizeHexKey(input);
    if (normalizedHexKey) {
      return {
        isValid: true,
        hexPrivateKey: normalizedHexKey,
        format: 'hex',
      };
    }

    return this.validateNsec(input);
  }

  validateNpub(input: string): NpubValidationResult {
    const value = input.trim();
    if (!value) {
      return { isValid: false, normalizedPubkey: null };
    }

    try {
      const decoded = nip19.decode(value);
      if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
        return { isValid: false, normalizedPubkey: null };
      }

      if (!isValidPubkey(decoded.data)) {
        return { isValid: false, normalizedPubkey: null };
      }

      return { isValid: true, normalizedPubkey: decoded.data.toLowerCase() };
    } catch {
      return { isValid: false, normalizedPubkey: null };
    }
  }
}

export const inputSanitizerService = new InputSanitizerService();
