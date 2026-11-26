// Who may use the bot, and where. Everything is denied unless the operator listed it.
//
// A message is answered only when BOTH hold:
//   - its author is in the sender allowlist, and
//   - it arrives by DM, or in a private/public group the operator allowed.
// Group membership never grants access by itself: other members are not trusted automatically.
export class Access {
  constructor({ senders = [], privateGroups = [], publicGroups = [] } = {}) {
    this.senders = new Set(senders);
    this.privateGroups = new Set(privateGroups);
    this.publicGroups = new Set(publicGroups);
  }
  sender(pubkey) {
    return this.senders.has(pubkey);
  }
  // A private group is identified by its stable group identity pubkey (NIP-171).
  privateGroup(pubkey) {
    return this.privateGroups.has(pubkey);
  }
  // A public group is identified by its address: 34550:<owner pubkey>:<identifier>.
  publicGroup(address) {
    return this.publicGroups.has(address);
  }
}
