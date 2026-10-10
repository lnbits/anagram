import { normalizeRumor } from '#src/lib/nostr/normalizeRumor.ts';
import { ConversationKeyCache } from './conversationKeyCache';
const conversationKeys = new ConversationKeyCache();
import { nip44, verifyEvent, type Event } from 'nostr-tools';
self.onmessage = (message: MessageEvent<{ id: number; wrap: Event; key: Uint8Array; requireEmptySealTags?: boolean }>) => {
  const { id, wrap, key, requireEmptySealTags } = message.data;
  try {
    if (wrap.kind !== 1059 || !verifyEvent(wrap)) throw new Error('Invalid gift wrap signature');
    const seal = JSON.parse(
      nip44.v2.decrypt(wrap.content, nip44.v2.utils.getConversationKey(key, wrap.pubkey)),
    );
    if (seal.kind !== 13 || !verifyEvent(seal) || (requireEmptySealTags && (!Array.isArray(seal.tags) || seal.tags.length !== 0))) throw new Error('Invalid seal signature');
    const rumor = JSON.parse(
      nip44.v2.decrypt(seal.content, conversationKeys.get(key, seal.pubkey)),
    );
    if (requireEmptySealTags && rumor.sig) throw new Error('Group rumor must be unsigned');
    self.postMessage({ id, rumor: normalizeRumor(rumor, seal.pubkey) });
  } catch {
    // Parser/crypto errors can contain decrypted input. Send a fixed diagnostic.
    self.postMessage({ id, error: 'Unable to decrypt or validate gift wrap' });
  } finally {
    key.fill(0);
  }
};
