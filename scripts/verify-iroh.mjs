import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../static/iroh/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
for (const [file, expected] of Object.entries(manifest.hashes)) {
  const actual = createHash('sha256')
    .update(readFileSync(new URL(file, root)))
    .digest('hex');
  if (actual !== expected)
    throw new Error(`Iroh asset mismatch: ${file}. Rebuild and update its manifest together.`);
}
console.log('Bundled Iroh assets match their manifest.');
