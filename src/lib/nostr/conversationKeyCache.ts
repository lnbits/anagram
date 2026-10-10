import { nip44 } from 'nostr-tools';

// Lives exclusively in the crypto worker. Switching recipient keys discards the
// previous account/group cache. Never serialize secret bytes or use them as strings.
export class ConversationKeyCache {
  private recipient: Uint8Array | null = null;
  private keys = new Map<string, Uint8Array>();
  constructor(private readonly capacity = 200) {}
  clear() {
    this.recipient?.fill(0);
    this.recipient = null;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }
  get(secret: Uint8Array, peer: string): Uint8Array {
    if (
      !this.recipient ||
      secret.length !== this.recipient.length ||
      !secret.every((byte, index) => byte === this.recipient![index])
    ) {
      this.clear();
      this.recipient = secret.slice();
    }
    let key = this.keys.get(peer);
    if (key) this.keys.delete(peer);
    else key = nip44.v2.utils.getConversationKey(secret, peer);
    this.keys.set(peer, key);
    if (this.keys.size > this.capacity) {
      const oldest = this.keys.keys().next().value!;
      this.keys.get(oldest)!.fill(0);
      this.keys.delete(oldest);
    }
    return key;
  }
}
