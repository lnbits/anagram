const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public', 'iroh');
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'iroh-calls', 'target');
const bindingVersion = execFileSync(process.env.WASM_BINDGEN || 'wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim();
if (bindingVersion !== 'wasm-bindgen 0.2.122') throw new Error('Install wasm-bindgen-cli 0.2.122 to rebuild the pinned call transport.');
execFileSync('cargo', ['build', '--manifest-path', path.join(root, 'iroh-calls', 'Cargo.toml'),
  '--target', 'wasm32-unknown-unknown', '--release', '--locked'], { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } });
fs.mkdirSync(output, { recursive: true });
execFileSync(process.env.WASM_BINDGEN || 'wasm-bindgen', [path.join(target, 'wasm32-unknown-unknown', 'release', 'anagram_iroh_calls.wasm'),
  '--target', 'web', '--out-dir', output], { stdio: 'inherit' });
const hashes = Object.fromEntries(['anagram_iroh_calls.js', 'anagram_iroh_calls_bg.wasm'].map((name) => [name,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex')]));
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ iroh: '1.3.0', wasmBindgen: '0.2.122', hashes }, null, 2) + '\n');
