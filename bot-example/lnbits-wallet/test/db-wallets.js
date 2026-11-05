// See db-mode.js. A registry built from the same entries as wallets.json, keeping the M6 refs,
// so every test written for wallets.js runs unchanged against SQLite, the ledger and the keyring.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keyring } from '../keyring.js';
import { Ledger } from '../ledger.js';
import { Registry } from '../registry.js';
import { DB_FILE, Store } from '../store.js';
import { walletRef, Wallets as FileWallets } from '../wallets.js';

export * from '../wallets.js';

const ORIGIN = 'https://lnbits.test/';
const dirs = [];
process.once('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export class Wallets extends Registry {
  // Each simulated restart has a new store, which cannot know the first link time. Saved state
  // does, as it does for wallets.json. (Real database mode keeps it in the one database.)
  linkedSince() {
    return undefined;
  }
  constructor(entries = []) {
    const file = new FileWallets(entries); // the same validation and errors as wallets.js
    const root = mkdtempSync(join(tmpdir(), 'anagram-lnbits-wallet-db-'));
    dirs.push(root);
    const secrets = join(root, 'secrets');
    const keyring = Keyring.init(secrets);
    const store = Store.create(join(root, DB_FILE));
    const ledger = Ledger.create(secrets, keyring, store.getMeta('store_id'));
    // Management off: these tests are about behaviour that must match wallets.json mode.
    super({ store, keyring, ledger, maxPerOwner: 1, manageable: false });
    for (const owner of file.owners()) {
      const invoiceKey = file.keyFor(owner);
      this.connect({
        owner,
        source: 'operator',
        actor: 'operator',
        label: file.label(owner),
        origin: ORIGIN,
        secret: { invoiceKey },
        ref: walletRef(owner, invoiceKey),
        // A restart in these tests builds a new store: the same link keeps its id, as it would.
        id: walletRef(owner, `id:${invoiceKey}`),
      });
    }
  }
}
