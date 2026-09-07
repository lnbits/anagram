export interface ContactBirthday {
  year?: number;
  month?: number;
  day?: number;
}

export type ContactType = 'user' | 'group';

export interface ContactGroupMember {
  public_key: string;
  name: string;
  given_name?: string | null;
  picture?: string;
  avatar?: string;
  about?: string;
  nip05?: string;
  nprofile?: string;
}

export interface ContactMetadata {
  name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  npub?: string;
  nprofile?: string;
  lud06?: string;
  lud16?: string;
  display_name?: string;
  website?: string;
  banner?: string;
  bot?: boolean;
  group?: boolean;
  birthday?: ContactBirthday;
  // App-local linkage used to map contacts to existing chat threads.
  chatId?: string;
  avatar?: string;
  last_seen_incoming_activity_at?: string;
  last_seen_incoming_activity_event_id?: string;
  profile_event_created_at?: number;
  relay_list_event_created_at?: number;
  general_relay_entries?: ContactRelay[];
  dm_receive_relay_entries?: ContactRelay[];
  dm_receive_relay_event_created_at?: number;
  private_contact_list_member?: boolean;
  muted?: boolean;
  blocked?: boolean;
  blocked_at?: string;
  group_private_key_encrypted?: string;
  owner_public_key?: string;
  group_members?: ContactGroupMember[];
}

export interface ContactRelay {
  url: string;
  read: boolean;
  write: boolean;
}

export interface ContactRecord {
  id: number;
  public_key: string;
  type: ContactType;
  name: string;
  given_name: string | null;
  meta: ContactMetadata;
  relays?: ContactRelay[];
  sendMessagesToAppRelays: boolean;
}

export interface CreateContactInput {
  public_key: string;
  type?: ContactType;
  name: string;
  given_name?: string | null;
  meta?: ContactMetadata;
  relays?: ContactRelay[];
  sendMessagesToAppRelays?: boolean;
}

export interface UpdateContactInput {
  public_key?: string;
  type?: ContactType;
  name?: string;
  given_name?: string | null;
  meta?: ContactMetadata;
  relays?: ContactRelay[];
  sendMessagesToAppRelays?: boolean;
}
