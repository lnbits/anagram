import type { CallEndpoint } from 'src/types/call';
import { defaultIrohRelays, normalizeIrohRelayUrl } from 'src/utils/irohRelays';
import { guardCallRelay } from './callRelayApproval';

// Loaded from the same origin. This asset is built from iroh-calls/ and shipped on every target.
let modulePromise: Promise<{
  CallEndpoint: { create_with_relays(relayUrls: string[]): Promise<CallEndpoint> };
}> | null = null;
export async function createIrohCallEndpoint(
  relayUrls = defaultIrohRelays()
): Promise<CallEndpoint> {
  const urls = relayUrls.map(normalizeIrohRelayUrl);
  if (!urls.length || urls.length > 21 || urls.some((url) => !url))
    throw new Error('Choose at least one valid HTTPS call relay');
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
  const endpoint = await (await modulePromise).CallEndpoint.create_with_relays(urls as string[]);
  return guardCallRelay(endpoint, urls as string[]);
}
