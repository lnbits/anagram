export const CALL_SIGNAL_KIND = 21117;
export const CALL_PROTOCOL = 'anagram/iroh-call/1';
export const CALL_RING_TIMEOUT_MS = 60_000;
export const CALL_CONNECT_TIMEOUT_MS = 30_000;
export const CALL_SUPPORT_TIMEOUT_MS = 10_000;

export type CallMode = 'audio' | 'video';
export type CallPhase =
  'preparing' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';
export type CallEndReason =
  'hangup' | 'declined' | 'busy' | 'timeout' | 'failed' | 'cancelled' | 'unsupported';
export interface CallAddress {
  id: string;
  relayUrl: string;
}
export interface CallSignal {
  protocol: typeof CALL_PROTOCOL;
  callId: string;
  action: 'invite' | 'ringing' | 'accept' | 'end' | 'reconnect';
  expiresAt: string;
  mode: CallMode;
  address?: CallAddress;
  mimeType?: string;
  reason?: CallEndReason;
  transportVersion?: 2;
  reconnectSupported?: boolean;
  reconnectAttempt?: number;
  mediaVersion?: 2;
  packetAudioVersion?: 1;
  packetVideoVersion?: 1;
  videoSupported?: boolean;
  screenSupported?: boolean;
  muteStateSupported?: boolean;
  mediaRecoveryVersion?: 1;
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
  remoteMicrophoneMuted?: boolean;
  cameraMuted: boolean;
  peerConfirmed?: boolean;
  mediaVersion?: 2;
  videoAvailable?: boolean;
  screenAvailable?: boolean;
  screenSharing?: boolean;
  endReason?: CallEndReason;
}
export interface CallTransportStats {
  relayOnly: boolean;
  rttMs: number;
  paths: number;
}
export interface CallConnection {
  transportStats?(): Promise<CallTransportStats>;
  sendAudio?(data: Uint8Array): Promise<void>;
  recvAudio?(): Promise<Uint8Array>;
  send(data: Uint8Array): Promise<void>;
  recv(): Promise<Uint8Array>;
  close(reason?: CallEndReason): void;
  end_reason?(): string | undefined;
}
export interface CallEndpoint {
  datagrams?: boolean;
  multiplexed?: boolean;
  online(): Promise<void>;
  id(): string;
  relay_url(): string;
  connect(
    peerId: string,
    relayUrl: string,
    callId: string,
    multiplexed?: boolean,
  ): Promise<CallConnection>;
  accept(peerId: string, callId: string, multiplexed?: boolean): Promise<CallConnection>;
  close(): Promise<void>;
}
