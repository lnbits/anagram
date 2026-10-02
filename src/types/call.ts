export const CALL_SIGNAL_KIND = 21117;
export const CALL_PROTOCOL = 'anagram/iroh-call/1';
export const CALL_RING_TIMEOUT_MS = 60_000;
export const CALL_CONNECT_TIMEOUT_MS = 30_000;
export const CALL_SUPPORT_TIMEOUT_MS = 10_000;

export type CallMode = 'audio' | 'video';
export type CallPhase = 'preparing' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';
export type CallEndReason =
  | 'hangup'
  | 'declined'
  | 'busy'
  | 'timeout'
  | 'failed'
  | 'cancelled'
  | 'unsupported';
export interface CallAddress {
  id: string;
  relayUrl: string;
}
export interface CallSignal {
  protocol: typeof CALL_PROTOCOL;
  callId: string;
  action: 'invite' | 'ringing' | 'accept' | 'end';
  expiresAt: string;
  mode: CallMode;
  address?: CallAddress;
  mimeType?: string;
  reason?: CallEndReason;
  mediaVersion?: 2;
  videoSupported?: boolean;
}
export interface CallSession {
  id: string;
  peerPubkey: string;
  peerName: string;
  direction: 'incoming' | 'outgoing';
  mode: CallMode;
  phase: CallPhase;
  startedAt: string | null;
  microphoneMuted: boolean;
  cameraMuted: boolean;
  peerConfirmed?: boolean;
  mediaVersion?: 2;
  videoAvailable?: boolean;
  endReason?: CallEndReason;
}
export interface CallConnection {
  send(data: Uint8Array): Promise<void>;
  recv(): Promise<Uint8Array>;
  close(reason?: CallEndReason): void;
  end_reason?(): string | undefined;
}
export interface CallEndpoint {
  online(): Promise<void>;
  id(): string;
  relay_url(): string;
  connect(peerId: string, relayUrl: string, callId: string): Promise<CallConnection>;
  accept(peerId: string, callId: string): Promise<CallConnection>;
  close(): Promise<void>;
}
