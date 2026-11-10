// Who may use the bot, where, and in which repositories. Everything is denied unless listed.
//
// A message is handled only when BOTH hold:
//   - its author is in ALLOWED_USERS, and
//   - it arrives by DM, or in a private/public group the operator allowed.
// Group membership never grants access. Each user has their own repository list.
export class Access {
  // users: Map or [[pubkey, ['owner/repo', ...]]], with canonical repository names.
  constructor({ users = [], privateGroups = [], publicGroups = [] } = {}) {
    this.users = new Map(users);
    this.privateGroups = new Set(privateGroups);
    this.publicGroups = new Set(publicGroups);
  }
  sender(pubkey) {
    return this.users.has(pubkey);
  }
  repos(pubkey) {
    return [...(this.users.get(pubkey) ?? [])];
  }
  // Returns the canonical repository name if this user may use it, otherwise undefined.
  repo(pubkey, name) {
    const wanted = String(name).toLowerCase();
    return this.repos(pubkey).find((repo) => repo.toLowerCase() === wanted);
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
