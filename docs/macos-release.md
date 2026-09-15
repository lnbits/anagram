# Signed macOS releases

The macOS job in `.github/workflows/release.yml` builds the existing Intel/x64 target on `macos-15-intel`. It uploads `release-assets/anagram-macos.zip` as `release-macos`. The archive contains `Anagram.app`, signed with Developer ID Application, notarized by Apple, and stapled. The existing `v*.*.*` tag trigger, tag validation, asset names, and other platform jobs are unchanged.

## One-time setup

Use an active Apple Developer Program team with permission to issue Developer ID certificates and submit software for notarization. In Keychain Access, export the **Developer ID Application** certificate **and its private key** as a password-protected `.p12`. The export must contain exactly one valid Developer ID Application identity for the intended team; unrelated identities are ignored. Renew expired or revoked certificates before building.

Add these six repository or organization **GitHub Actions secrets** (organization secrets must grant this repository access):

| Secret | Value |
| --- | --- |
| `BUILD_CERTIFICATE_BASE64` | Base64 of the exported `.p12`, including its private key. On macOS, `base64 -i DeveloperIDApplication.p12 \| pbcopy` copies it without printing it. |
| `P12_PASSWORD` | The nonempty password used when exporting the `.p12`. |
| `KEYCHAIN_PASSWORD` | A nonempty random password for the temporary runner keychain. |
| `APPLE_ID` | The Apple Account email authorized to notarize for this team. |
| `APPLE_TEAM_ID` | The 10-character team ID shown in Apple Developer membership details and in the certificate identity. |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password generated for that Apple Account, not its normal login password. |

The account must have accepted any pending Apple Developer agreements. No App Store provisioning profile, API key, or additional signing secrets are used. See [GitHub's certificate setup guidance](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications) and [Electron's notarization prerequisites](https://github.com/electron/notarize#prerequisites).

## Build sequence

1. `.github/scripts/macos-release.cjs build` rejects missing credentials, creates a private directory under `RUNNER_TEMP`, and saves the original user keychain search list. It imports the P12 into a temporary keychain, unlocks it for the job, and grants unattended signing access through trusted tools and the Apple/codesign key partitions. It selects exactly one valid Developer ID Application identity matching `APPLE_TEAM_ID` and passes its fingerprint and keychain to electron-builder.
2. `notarytool store-credentials` validates the Apple credentials and stores a profile in that same temporary keychain. The P12 file is deleted after import. Raw passwords and the certificate are removed from the environment passed to the existing `npm run build:electron:mac` pipeline.
3. The release-only Quasar configuration requires code signing. electron-builder signs nested Electron frameworks, helpers, and libraries before signing the outer app, with hardened runtime, Apple's secure timestamp service, and strict verification. The shared main/child entitlement file contains only `com.apple.security.cs.allow-jit`, required by modern Electron/V8. It does not enable unsigned executable memory, disable library validation, grant debugging access, or add App Sandbox capabilities. Review entitlements if native components or Electron requirements change; see [Electron's requirements](https://github.com/electron/notarize#prerequisites) and [electron-builder macOS options](https://www.electron.build/mac/).
4. The `afterSign` export in the release script verifies the signature and team, makes a temporary submission ZIP with `ditto`, and runs `notarytool submit --wait` with a 30-minute timeout. Only JSON status `Accepted` permits stapling. Rejected, missing, malformed, or timed-out results fail the build. The hook staples and validates the app before electron-builder creates its distributable ZIP. `mac.notarize: false` disables electron-builder's automatic submission, so there is only one notarization path.
5. The wrapper requires exactly one builder ZIP, stages it under the existing asset name, and extracts that exact file into a fresh directory. It requires a root-level `Anagram.app`, verifies nested signatures with `codesign --verify --deep --strict` and an Apple Developer ID/team requirement, runs `spctl --assess --type execute`, and validates the stapled ticket with `xcrun stapler validate`. Any error fails the job and removes the staged asset.
6. Cleanup runs on success, errors, and handled termination signals, with an additional workflow `always()` step before upload. It restores the keychain search list and deletes the temporary keychain, P12, notarization profile, submission archive, and extracted verification copy. Credential-bearing command arguments and unredacted diagnostics are never printed. The hosted runner is also discarded by GitHub when the job ends.

## Local development and validation

`npm run dev:electron`, `npm run build:electron:dir`, and `npm run build:electron:mac` remain unsigned and do not contact Apple's notary service. Leave `ANAGRAM_MACOS_RELEASE` unset for these commands. The release wrapper sets it only for its build subprocess. Windows, Linux, and Android continue to use their existing build paths.

For a signed local build, put the six credentials listed above in `.env.macos-release` at the repository root, replacing any mock values. This filename is already Git-ignored and is not automatically loaded by Quasar. Keep the file readable only by your user (`chmod 600 .env.macos-release`). Run:

```bash
npm run build:electron:mac:release
```

The command uses Node's `--env-file` support to load the credentials, creates a fresh `RUNNER_TEMP`, and invokes the same release wrapper used by GitHub Actions. It signs, notarizes, staples, extracts, and verifies `release-assets/anagram-macos.zip`, then cleans up the temporary credentials and keychain. It does not publish a release or push a tag. Keep signing credentials out of the main `.env`, which Quasar automatically loads into its application build definitions.

Repository checks cover identity selection, credential failures, notarization status handling, ordering, verification failures, and cleanup using simulated Apple tools. Run:

```bash
npm run quality:all
npm run test:unit
npm run test:e2e:local
npm run build:electron:dir
```

A real end-to-end signing check requires macOS, Xcode's `notarytool`/`stapler`, all six credentials, a usable Developer ID private key, and access to Apple's timestamp and notary services. On a disposable macOS machine, populate the same environment variables securely, set `RUNNER_TEMP` to a private temporary directory, and run `node .github/scripts/macos-release.cjs build`. This command builds and verifies locally; it does not publish, create a release, or push a tag.

The submission ID is printed when Apple returns a result. For a rejected submission, use `xcrun notarytool log <submission-id>` with your own securely stored credentials to retrieve Apple's detailed diagnostics; the CI keychain profile has already been deleted. A timeout fails rather than publishing an app with pending notarization. After a successful real build, also launch the extracted app and check normal messaging and notifications to confirm runtime compatibility of the entitlements.

If `notarytool store-credentials` fails with HTTP 401, Apple rejected the account credentials before the app build began. Check `APPLE_ID` and replace `APPLE_APP_SPECIFIC_PASSWORD` with an app-specific password generated for that same Apple Account. Use the password value, not the name you assigned to it. The wrapper reports the failing notarytool subcommand and its diagnostics with credential values redacted.
