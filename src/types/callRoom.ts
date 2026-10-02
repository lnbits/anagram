import type { CallSignal } from './call';

export const ROOM_PROTOCOL = 'anagram/iroh-room/1';
export const ROOM_MAX_MEMBERS = 6;
export const ROOM_LIFETIME_MS = 8 * 60 * 60 * 1000;
export interface CallRoomLink {
  id: string;
  host: string;
  secret: string;
  expiresAt: string;
  relays: string[];
}
export interface CallRoomMember {
  pubkey: string;
  sessionId: string;
  name: string;
  relays: string[];
}
export interface CallRoomSignal {
  protocol: typeof ROOM_PROTOCOL;
  roomId: string;
  senderSession: string;
  expiresAt: string;
  action: 'join' | 'roster' | 'signal' | 'leave' | 'closed' | 'rejected';
  secret?: string;
  member?: CallRoomMember;
  revision?: number;
  members?: CallRoomMember[];
  signal?: CallSignal;
  recipientSession?: string;
  reason?: 'full' | 'ended' | 'failed';
}
export interface CallRoomSession {
  link: CallRoomLink;
  own: CallRoomMember;
  phase: 'preparing' | 'joining' | 'active' | 'ended';
  members: CallRoomMember[];
  revision: number;
}
