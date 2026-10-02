import type { CallEndpoint } from 'src/types/call';

// Loaded from the same origin. This asset is built from iroh-calls/ and shipped on every target.
let modulePromise: Promise<{
  CallEndpoint: { create(relayUrl?: string): Promise<CallEndpoint> };
}> | null = null;
export async function createIrohCallEndpoint(): Promise<CallEndpoint> {
  if (!modulePromise) {
    const url = new URL('iroh/anagram_iroh_calls.js', document.baseURI).href;
    modulePromise = import(/* @vite-ignore */ url)
      .then(async (module) => {
        await module.default();
        return module;
      })
      .catch((error) => {
        modulePromise = null;
        throw error;
      });
  }
  const relayUrl = process.env.APP_IROH_RELAY_URL?.trim() || undefined;
  if (relayUrl && new URL(relayUrl).protocol !== 'https:')
    throw new Error('Iroh calls require an HTTPS relay');
  return (await modulePromise).CallEndpoint.create(relayUrl);
}
