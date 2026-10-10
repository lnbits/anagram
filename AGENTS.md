# Repository guide

This is the SvelteKit 3 / Tauri 2 Anagram rebuild. Use npm and the committed lockfile. Configuration belongs in `vite.config.ts`; SvelteKit 3 does not use `svelte.config.js`. Internal package imports use `#src/` with explicit `.ts` or `.svelte` extensions.

Keep Nostr protocol work in `src/stores/nostr/` and the nostr-tools adapter in `src/lib/nostr/client.ts`. Read `nips/NIPS_USED.md` and `nips/nip171.md` before modifying group or message semantics. Do not add NDK.

Keep messages in IndexedDB. Do not introduce full-history reads into startup, message ingestion, thread paging or search jumps. Preserve per-account queue isolation, real-EOSE coverage checks and bounded hydration. Keep desktop split view and mobile route navigation working.

After changes, run `npm run quality:all`, `npm run test:unit`, and the closest browser tests (`npm run test:e2e:local`). Run `npm run build` for UI/build changes. Use `nix-shell shell.nix --run 'cargo check --manifest-path src-tauri/Cargo.toml'` on this machine for native changes. Do not claim live-call or installer validation from unit tests alone.
