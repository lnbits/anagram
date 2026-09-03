export type MockRelayHangMode = 'none' | 'handshake' | 'responses';
export type MockRelayMessageType = 'ack' | 'event' | 'eose' | 'other';

export interface MockRelayConfig {
  listenHost: string;
  listenPort: number;
  targetUrl: string;
  handshakeDelayMs: number;
  requestDelayMs: number;
  ackDelayMs: number;
  eventDelayMs: number;
  eoseDelayMs: number;
  otherDelayMs: number;
  jitterMs: number;
  dropAcks: boolean;
  dropEvents: boolean;
  dropEose: boolean;
  hangMode: MockRelayHangMode;
  verbose: boolean;
}

export interface MockRelayOptions {
  delayMs?: number | string;
  listenHost?: string;
  listenPort?: number | string;
  targetUrl?: string;
  handshakeDelayMs?: number | string;
  requestDelayMs?: number | string;
  ackDelayMs?: number | string;
  eventDelayMs?: number | string;
  eoseDelayMs?: number | string;
  otherDelayMs?: number | string;
  jitterMs?: number | string;
  dropAcks?: boolean | string;
  dropEvents?: boolean | string;
  dropEose?: boolean | string;
  hangMode?: MockRelayHangMode | string;
  verbose?: boolean | string;
  environment?: Record<string, string | undefined>;
  logger?: Pick<Console, 'error' | 'info' | 'warn'>;
  random?: () => number;
}

export interface MockRelayHandle {
  close: () => Promise<void>;
  config: MockRelayConfig;
  connectionCount: () => number;
  relayUrl: string;
}

export function calculateDelayMs(
  baseDelayMs: number,
  jitterMs: number,
  random?: () => number
): number;
export function classifyRelayMessage(message: unknown): MockRelayMessageType;
export function parseCommandLineArguments(argumentsList: string[]): MockRelayOptions & {
  help?: boolean;
};
export function resolveMockRelayConfig(
  overrides?: MockRelayOptions,
  environment?: Record<string, string | undefined>
): MockRelayConfig;
export function resolveRelayResponseBehavior(
  message: unknown,
  config: MockRelayConfig,
  random?: () => number
): {
  delayMs: number;
  messageType: MockRelayMessageType;
  shouldDrop: boolean;
};
export function startMockRelayProxy(options?: MockRelayOptions): Promise<MockRelayHandle>;
