# PR title

`feat: add Mac App Store and TestFlight packaging`

# PR description

Add a sandboxed macOS distribution workflow for the Mac App Store and TestFlight.

- Add store-specific Tauri configuration targeting macOS 11, with camera, microphone, file-access, and network entitlements.
- Package the privacy manifest and permission descriptions.
- Add an archive helper that validates universal binaries, signatures, sandboxing, and the privacy manifest, then generates Xcode export/upload options.
- Document building, automatic signing, uploading, and encryption compliance.

## Validation

- Built, signed, and uploaded universal version 0.9.7 (2) to TestFlight.
- Verified sandboxed startup and separate Keychain, UDP, and HTTPS checks.
- Quality checks passed; three initial unit-test failures passed on rerun.
- WebKit: 16/18 selected tests passed; both failing scenarios passed in Chromium.
- Hands-on TestFlight login, attachment, and call testing remains pending.

## Note

These changes are currently uncommitted on `main`. **`todo.md` is staged—exclude it from the commit and PR.**
