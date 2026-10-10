# Releases

Push a version tag to run [release.yml](../.github/workflows/release.yml). Versions are derived from the tag; no manual version-file edits are required.

| Tag                           | Result                             |
| ----------------------------- | ---------------------------------- |
| `v0.9.1`                      | Published release                  |
| `v0.9.1-beta.1`               | Published prerelease               |
| `v0.9.1-rc1` or `v0.9.1-rc.1` | Draft prerelease, including reruns |

The release waits for all builds and checks, then attaches Windows `.exe`, Intel/Apple Silicon `.dmg`, Linux `.AppImage`, Android `.apk`, `anagram-web.zip`, and `SHA256SUMS.txt`. Failed builds leave workflow artifacts. No automatic desktop updater is configured.

## Signing

Configure repository **Actions secrets**. Never commit signing keys or certificates.

| Platform | Secrets                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`                                   |
| iPhone   | `APPLE_TEAM_ID`, `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`                                                |
| macOS    | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`; optionally `APPLE_SIGNING_IDENTITY` |

**Android:** encode the existing keystore as base64 and keep the same key for updates. Tagged releases require signing. Manual builds without secrets produce an unsigned APK. Signatures and 16 KB alignment are checked before upload.

**iPhone builds are paused** and are not required for releases. To resume, configure signing and set the `IOS_BUILDS_ENABLED` repository variable to `true`. Use a base64 Apple Distribution `.p12` and provisioning profile for `com.nostr.anagram`. Without signing credentials, the asset is explicitly named `-ios-unsigned.ipa` and needs signing before installation. Partial signing configuration fails the build.

The `IOS_EXPORT_METHOD` repository variable defaults to `app-store-connect` for App Store/TestFlight. Use `release-testing` for an ad hoc profile covering registered devices, or `debugging` with development credentials. The workflow builds the IPA; it does not submit it to Apple.

**macOS:** use a base64 Developer ID Application certificate. Existing secrets `BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD`, and `APPLE_APP_SPECIFIC_PASSWORD` are also accepted. The signing identity is derived from the certificate if omitted. Without a certificate, builds use ad hoc signing. Windows installers are currently unsigned.

See Tauri’s [Android](https://v2.tauri.app/distribute/sign/android/), [iOS](https://v2.tauri.app/distribute/sign/ios/), and [macOS](https://v2.tauri.app/distribute/sign/macos/) signing guides.

## Manual builds

Run **Release** from the Actions tab to validate all active platforms without publishing. Pushes to `build-validation/**` branches also validate using the package version. Only version-tag pushes can publish a release. Download the `complete-release` artifact to inspect the installers before tagging.

Run **Android APK** for an Android-only build. Native projects are generated from committed sources. Mobile versions omit RC suffixes, retain the full tag in asset names, and use the workflow run number as the build number. Reruns reuse that number.

## Packaged-app validation

Release publication waits for these checks on the actual packages:

- **Linux / Windows:** extract the AppImage or install the NSIS executable; log in through the native WebView, read a profile, send and receive encrypted DMs, reconnect after a relay disconnect, and restore login/history after restarting. A local relay validates signed events; an unavailable extra relay must not block first login. A separate read-only check requires real EOSE from one default public WSS relay in the packaged WebView.
- **Android:** install the release APK on a fresh Android 15 emulator, require rendered login controls, log in with a disposable key, connect to at least one default WSS relay, and verify login/connectivity after restarting. This is read-only on public relays; no test profile or messages are published. A total public-relay outage can fail the Android and desktop WSS checks.
- **macOS:** verify and mount each architecture's DMG, copy the app, verify its signature, and require a surviving process and rendered Login/Create Account controls, recognized from the native window screenshot. This does not validate relay traffic on macOS.

Failed checks block publication. Logs, screenshots and result files are retained as `smoke-*` / `android-startup-diagnostics` workflow artifacts. Tests use disposable accounts and never require a developer's saved keys. iOS remains paused; physical-device, call and notification behavior still need platform testing. Local web tests alone do not validate installers.

Use a fresh RC tag for each candidate. A failed release run does not replace existing assets, even if the same tag was moved to a newer commit. Check the successful release run before downloading again.

## Running on NixOS

Use `appimage-run ./Anagram_<version>_amd64.AppImage`. It supplies the Linux library environment expected by the AppImage; launching it directly can fail with missing libraries such as `libfontconfig.so.1`.
