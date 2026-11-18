// URLs are local handles, never network addresses. Keeping one media element
// preserves autoplay permission, sink selection and mobile audio routing.
const progress = new Map<string, () => number>();
export const callStreamReceived = (url: string) => progress.get(url)?.() ?? 0;
const streams = new Map<string, MediaStream>();
export function registerCallStream(
  stream: MediaStream,
  received?: () => number,
): { url: string; close(): void } {
  const url = `anagram-call:${crypto.randomUUID()}`;
  streams.set(url, stream);
  if (received) progress.set(url, received);
  return {
    url,
    close() {
      streams.delete(url);
      progress.delete(url);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
export function getCallStream(url: string): MediaStream | undefined {
  return streams.get(url);
}
export function attachCallMedia(element: HTMLMediaElement, url: string): void {
  const stream = getCallStream(url);
  element.srcObject = stream ?? null;
  if (stream || !url) element.removeAttribute('src');
  else element.src = url;
}
