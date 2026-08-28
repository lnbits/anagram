import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { STARTUP_CHECKPOINT_STORAGE_KEY } from 'src/stores/nostr/constants';
import { hasStorage, isPlainRecord } from 'src/stores/nostr/shared';

export const STARTUP_CHECKPOINT_VERSION = 1;

export type StartupCheckpointStatus = 'complete' | 'failed' | 'in_progress';

export interface StartupCheckpoint {
  version: number;
  pubkey: string;
  relaySignature: string;
  status: StartupCheckpointStatus;
  updatedAt: string;
}

export function buildStartupRelaySignature(relayUrls: string[]): string {
  return inputSanitizerService
    .normalizeRelayListMetadataEntries(relayUrls.map((url) => ({ url })))
    .map((entry) => entry.url)
    .filter((url) => /^wss?:\/\//i.test(url))
    .sort((first, second) => first.localeCompare(second))
    .join(',');
}

export function normalizeStartupCheckpoint(value: unknown): StartupCheckpoint | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  const version = Number(value.version);
  const pubkey = inputSanitizerService.normalizeHexKey(
    typeof value.pubkey === 'string' ? value.pubkey : ''
  );
  const relaySignature =
    typeof value.relaySignature === 'string' ? value.relaySignature.trim() : '';
  const status = value.status;
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt.trim() : '';

  if (
    version !== STARTUP_CHECKPOINT_VERSION ||
    !pubkey ||
    !relaySignature ||
    (status !== 'complete' && status !== 'failed' && status !== 'in_progress') ||
    !updatedAt ||
    Number.isNaN(new Date(updatedAt).getTime())
  ) {
    return null;
  }

  return {
    version,
    pubkey,
    relaySignature,
    status,
    updatedAt,
  };
}

export function readStartupCheckpoint(): StartupCheckpoint | null {
  if (!hasStorage()) {
    return null;
  }

  const stored = window.localStorage.getItem(STARTUP_CHECKPOINT_STORAGE_KEY)?.trim();
  if (!stored) {
    return null;
  }

  try {
    return normalizeStartupCheckpoint(JSON.parse(stored));
  } catch {
    return null;
  }
}

export function writeStartupCheckpoint(
  pubkey: string,
  relayUrls: string[],
  status: StartupCheckpointStatus
): StartupCheckpoint | null {
  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkey);
  const relaySignature = buildStartupRelaySignature(relayUrls);
  if (!normalizedPubkey || !relaySignature) {
    return null;
  }

  const checkpoint: StartupCheckpoint = {
    version: STARTUP_CHECKPOINT_VERSION,
    pubkey: normalizedPubkey,
    relaySignature,
    status,
    updatedAt: new Date().toISOString(),
  };

  if (hasStorage()) {
    window.localStorage.setItem(STARTUP_CHECKPOINT_STORAGE_KEY, JSON.stringify(checkpoint));
  }

  return checkpoint;
}

export function isStartupCheckpointCurrent(
  checkpoint: StartupCheckpoint | null,
  pubkey: string,
  relayUrls: string[]
): boolean {
  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkey);
  if (!checkpoint || checkpoint.status !== 'complete' || !normalizedPubkey) {
    return false;
  }

  return (
    checkpoint.version === STARTUP_CHECKPOINT_VERSION &&
    checkpoint.pubkey === normalizedPubkey &&
    checkpoint.relaySignature === buildStartupRelaySignature(relayUrls)
  );
}
