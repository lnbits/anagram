import type { MessageRelayStatus } from '#src/types/chat.ts';

export function isMessageRelayStatus(value: unknown): value is MessageRelayStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const status = value as Partial<MessageRelayStatus>;
  return (
    typeof status.relay_url === 'string' &&
    (status.direction === 'outbound' || status.direction === 'inbound') &&
    (status.status === 'pending' ||
      status.status === 'published' ||
      status.status === 'failed' ||
      status.status === 'received') &&
    (status.scope === 'recipient' || status.scope === 'self' || status.scope === 'subscription')
  );
}

export function normalizeMessageRelayStatus(value: unknown): MessageRelayStatus | null {
  if (!isMessageRelayStatus(value)) {
    return null;
  }

  const relayUrl = value.relay_url.trim();
  if (!relayUrl) {
    return null;
  }

  const updatedAt =
    typeof value.updated_at === 'string' && value.updated_at.trim()
      ? value.updated_at.trim()
      : new Date().toISOString();
  const detail =
    typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined;

  return {
    relay_url: relayUrl,
    direction: value.direction,
    status: value.status,
    scope: value.scope,
    updated_at: updatedAt,
    ...(detail ? { detail } : {}),
  };
}

export function normalizeMessageRelayStatuses(value: unknown): MessageRelayStatus[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeMessageRelayStatus(entry))
    .filter((entry): entry is MessageRelayStatus => Boolean(entry));
}

export function mergeMessageRelayStatuses(
  existingRelayStatuses: MessageRelayStatus[],
  nextRelayStatuses: MessageRelayStatus[]
): MessageRelayStatus[] {
  const mergedRelayStatuses = new Map<string, MessageRelayStatus>();

  for (const relayStatus of [...existingRelayStatuses, ...nextRelayStatuses]) {
    const normalizedRelayStatus = normalizeMessageRelayStatus(relayStatus);
    if (!normalizedRelayStatus) {
      continue;
    }

    const key = [
      normalizedRelayStatus.relay_url,
      normalizedRelayStatus.direction,
      normalizedRelayStatus.scope,
    ].join('|');
    mergedRelayStatuses.set(key, normalizedRelayStatus);
  }

  return Array.from(mergedRelayStatuses.values()).sort((first, second) => {
    const byRelayUrl = first.relay_url.localeCompare(second.relay_url);
    if (byRelayUrl !== 0) {
      return byRelayUrl;
    }

    const byDirection = first.direction.localeCompare(second.direction);
    if (byDirection !== 0) {
      return byDirection;
    }

    return first.scope.localeCompare(second.scope);
  });
}
