export const DEFAULT_BLOSSOM_SERVER_URL = 'https://blossom.nostr.build';
// Default for end-to-end encrypted private media. The server must store the uploaded
// ciphertext (application/octet-stream) byte-for-byte; verified against Ditto's Blossom server.
export const DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL = 'https://blossom.ditto.pub';

export function normalizeBlossomServerUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return null;
  }

  try {
    const url = new URL(normalizedValue);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function requireBlossomServerUrl(value: unknown): string {
  const serverUrl = normalizeBlossomServerUrl(value);
  if (!serverUrl) {
    throw new Error('Enter a valid HTTPS Blossom server URL without a path.');
  }

  return serverUrl;
}

export function buildBlossomUploadUrl(serverUrl: string): string {
  return `${requireBlossomServerUrl(serverUrl)}/upload`;
}

export function getBlossomServerHost(serverUrl: string): string {
  return new URL(requireBlossomServerUrl(serverUrl)).host;
}

export type BlossomAuthAction = 'upload' | 'delete';

export function buildBlossomUploadAuthorization(
  serverUrl: string,
  sha256: string,
  createdAt: number,
  action: BlossomAuthAction = 'upload'
): { content: string; tags: string[][] } {
  const serverHost = getBlossomServerHost(serverUrl);
  const normalizedSha256 = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedSha256)) {
    throw new Error('A valid file hash is required to sign upload auth.');
  }

  return {
    content:
      action === 'delete'
        ? `Authorize media delete from ${serverHost}`
        : `Authorize media upload to ${serverHost}`,
    tags: [
      ['t', action],
      ['expiration', String(createdAt + 15 * 60)],
      ['server', serverHost],
      ['x', normalizedSha256],
    ],
  };
}
