// Runs the whole test suite in database mode: "npm run test:db". Tests that import
// '../wallets.js' get test/db-wallets.js instead, whose Wallets is a registry over a temporary
// store, migrated the way "npm run migrate" does. Production code is not involved.
import { registerHooks } from 'node:module';

const REAL = new URL('../wallets.js', import.meta.url).href;
const SHIM = new URL('./db-wallets.js', import.meta.url).href;
const TESTS = new URL('./', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url === REAL && context.parentURL?.startsWith(TESTS) && context.parentURL !== SHIM)
      return { ...result, url: SHIM };
    return result;
  },
});
