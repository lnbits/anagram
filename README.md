# Anagram

Private Nostr messaging with DMs, groups, and Iroh audio/video calls. Built with Svelte and Tauri for web, desktop, and mobile. Messages are stored locally in IndexedDB; no application backend is required.

## Run

Use Node 24 and npm:

```sh
npm ci
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). Sign in with a private key, a Nostr browser extension, or a remote signer.

## Build

```sh
npm run build          # Web app → build/
npm run preview        # Preview the production web app
npm run dev:desktop    # Desktop development
npm run build:desktop  # Desktop installer
```

Desktop builds require Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). The production web app can be installed as a PWA.

## Check

```sh
npm run quality:all
npm run test:unit
npx playwright install chromium
npm run test:e2e:local
```

## Releases

Version tags build Windows, macOS, Linux, Android, and web assets. **RC tags such as `v0.1.0-rc1` stay as drafts.** iPhone builds are paused.

- [Release and signing setup](docs/releases.md)
- [Development, hosting, and mobile builds](docs/development.md)
- [Protocol notes](nips/NIPS_USED.md)
- [Security review](docs/security-review.md)

Browser private-key login stores the key in localStorage. Use an extension or remote signer if you don’t want the app to store your account key. Uploaded media is not encrypted by this client.
