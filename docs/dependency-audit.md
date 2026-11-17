# Dependency audit policy

CI and release verification both run `npm run audit:ci`. It audits the entire
dependency tree and blocks high/critical findings, including development tools.
Registry failures, invalid reports, and unknown dependency paths fail the check.
The full npm report remains visible in the job log.

## Temporary picomatch exception

- Advisory: [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
- Reviewed for this repository: 2026-11-17. Expires: **2026-12-01 00:00 UTC**.
- The installed version, **4.0.7**, is the latest published version; the advisory
  currently lists no patched version. `npm audit fix --force` suggests breaking
  toolchain downgrades, not a patched picomatch release.
- Picomatch only appears in the development dependency graph (Vite, Vitest,
  tinyglobby/fdir and Svelte tooling). The app does not import it or pass received
  Nostr messages, searches or relay data to its glob parser. The affected globs
  are build/test inputs from repository code and tooling, not remote chat input.
  Development tools must not be used to evaluate untrusted glob patterns.
- This accepts the build-time risk temporarily; **it does not fix picomatch's
  ReDoS vulnerability**. It applies only to this exact advisory, range and
  installed version, and only when every affected node is marked `dev: true`
  in the lockfile. Parent findings are accepted only when every cause resolves
  to this exception. Other advisories, critical severity, production/shared
  dependencies, changed versions/ranges and expired exceptions block the build.

Replace the dependency with an upstream patched release when available, run the
full checks, and remove the exception. If none is available by the expiry date,
the next build fails and requires a fresh review; do not automatically extend it.
Use plain `npm audit` to see npm's unfiltered exit status at any time.
