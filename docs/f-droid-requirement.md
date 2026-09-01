# F-Droid release requirements

## Bottom line

The app is viable for F-Droid, but the repository is not submission-ready yet. The published `v0.6.1` tag is the latest Firebase-free F-Droid candidate and supersedes both `v0.6.0` and `v0.5.3`.

The two earlier dependency and release blockers are resolved and remain resolved in `v0.6.1`:

1. Android notifications now connect directly to Nostr relays without Firebase Cloud Messaging, Google Services or the Capacitor push-notifications package.
2. NDK's unused Sandpack dependency is replaced during npm resolution by the empty, MIT-licensed `@gitlab/noop` package, so non-FLOSS Nodebox is not fetched.

The current source now implements the configurable Blossom server described by the store listing. A draft `fdroiddata` recipe also builds and validates an unsigned APK from source against the post-`v0.6.1` technical-baseline commit. The GitHub workflow labels its Android debug APK as test-only, while production Android distribution is reserved for F-Droid. Production bundle metadata is deterministic for a given version and source commit. Remaining release work includes publishing the current source in a new immutable release, retargeting the recipe to that release, and network/asset review.

F-Droid’s governing requirements are in its [Inclusion Policy](https://f-droid.org/en/docs/Inclusion_Policy/).

## What must be changed

| Priority | Finding | Required action |
|---|---|---|
| Done | Published `v0.5.3` contained Firebase/GMS push support | Published Firebase-free `v0.6.1`; use `v0.6.1` or a later release as the submission baseline, never `v0.5.3`. |
| Done | NDK declared Sandpack and non-FLOSS Nodebox | Replaced the unused Sandpack dependency with an empty MIT-licensed package through npm overrides. |
| Done | F-Droid/Fastlane store metadata was missing | Added English descriptions, an icon, phone screenshots, and version-code changelogs upstream. |
| Done for technical baseline | No tested `fdroiddata` build recipe | Added and tested a source-build recipe against commit `840eb8de90e78b67364d638cb429f4b9f00803d9`; retarget it to the immutable `v0.6.2` release commit before submission. |
| Done | Current GitHub Android “release” is a debug APK | Renamed and labeled the GitHub APK as a debug test-only artifact; production Android distribution will be through F-Droid. |
| Done | Android identity was inconsistent | Normalized Android, Capacitor, and Electron IDs to `com.nostr.chat`. |
| Done | Production bundles contained the current build timestamp | Removed the wall-clock timestamp; bundle and cache identity now use the app version and Git commit SHA. |
| Done in current source | The `v0.6.1` listing says Blossom uploads are configurable, but the tagged implementation still uses fixed `blossom.nostr.build` | Added a configurable HTTPS server saved in encrypted NIP-78 preferences; publish it in a new release rather than moving `v0.6.1`. |
| Legal review | LNbits identifier, name, logo, screenshots and other assets | Confirm that the repository license and distribution permissions cover them all. |

### 1. NDK dependency resolution

The app directly uses NDK in [package.json](../package.json). NDK 3.0.3 declares Sandpack, which normally installs non-FLOSS Nodebox even though the application and NDK runtime do not use Sandpack.

The root npm override now replaces NDK's Sandpack dependency with dependency-free, MIT-licensed `@gitlab/noop@1.0.1`. The lockfile contains no Nodebox package or CodeSandbox tarball resolution, so the restricted package is not fetched during installation.

This differs from deleting the package after installation: npm resolves and downloads the FLOSS no-op package in its place. The override can be removed when an upstream NDK release drops the unused dependency.

The baseline `fdroid build` and source scanner completed successfully with the override in place. Official `fdroiddata` review will repeat the dependency and binary review when the recipe is submitted.

### 2. Firebase-free release

The annotated `v0.6.1` tag is published on `origin` and points to commit `c818fb278f0b709d4b149dd5191ae8de0182f35e`. The tagged source declares version `0.6.1`, Android version code `6`, and application ID `com.nostr.chat`.

The tagged manifests, lockfiles, Gradle configuration and application source contain no Firebase SDK, Google Services plugin, Google Mobile Services dependency or Capacitor push-notifications package. The native notification design instead uses direct Nostr relay connections as described in [android-relay-notifications.md](android-relay-notifications.md).

Version `0.6.1` is consistent across the root and Capacitor manifests and lockfiles. Do not submit `v0.5.3`; use `v0.6.1` or a later clean release after the remaining submission issues are addressed.

The package strings in [strings.xml](../src-capacitor/android/app/src/main/res/values/strings.xml) are normalized to `com.nostr.chat`.

### 3. Store metadata

English upstream metadata is available under `fastlane/metadata/android/en-US/`, following F-Droid's [Quick Start Guide](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide/) and [graphics/description guide](https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/).

The current layout is:

```text
fastlane/metadata/android/en-US/
├── title.txt
├── short_description.txt
├── full_description.txt
├── changelogs/
│   ├── 5.txt
│   └── 6.txt
└── images/
    ├── icon.png
    └── phoneScreenshots/
        ├── 1.png
        └── 2.png
```

The approved icon and mobile screenshots are sourced from `public/nostr_chat.png` and `docs/screenshots/`.

The listing discloses:

- Nostr relay usage.
- Background relay connection and notification behavior.
- Foreground-service and boot permissions.
- A configurable Blossom media-upload server.
- That notifications are direct relay notifications rather than FCM.

The published `v0.6.1` source predates this feature, but the current source now matches the listing. Users can select an HTTPS base URL under Media & Data Storage; [blossomUploadService.ts](../src/services/blossomUploadService.ts) applies it to the upload request and signed authorization event. The choice is stored in encrypted NIP-78 private preferences so it is restored with the account. Publish the implementation under a new tag rather than moving `v0.6.1`.

### 4. F-Droid build recipe

The draft recipe is available at [metadata/com.nostr.chat.yml](../metadata/com.nostr.chat.yml), with the additional Rolldown source-library declaration at [srclibs/rolldown.yml](../srclibs/rolldown.yml). Both files are intended for eventual submission to the separate `fdroiddata` repository.

The technical baseline targets version `0.6.1`, version code `6`, and the full post-tag source commit `840eb8de90e78b67364d638cb429f4b9f00803d9`. It:

- Installs checksum-pinned Node 24.16.0 and the required native build toolchains.
- Installs both npm lockfiles with lifecycle scripts disabled.
- Lets F-Droid scan the source tree and remove packaged executables before building.
- Rebuilds esbuild 0.27.7 from Go source and Rolldown 1.0.1 from Rust source instead of using their npm native binaries.
- Builds the Quasar UI, synchronizes Capacitor Android, and runs Gradle `assembleRelease`.
- Removes generated `node_modules` trees before F-Droid packages the source state.
- Detects future versions from `v*` Git tags and reads Android version codes from `src-capacitor/package.json`.

The recipe was tested in F-Droid's official `fdroidserver:buildserver` container. `fdroid lint` passed, `fdroid rewritemeta` parsed and canonicalized the recipe, the source scanner reported no blocking problems, and `fdroid build --on-server --no-tarball -v com.nostr.chat:6` completed successfully. The resulting 5,015,471-byte APK has package `com.nostr.chat`, version name `0.6.1`, version code `6`, and no APK signature. A standalone F-Droid APK scan also returned successfully with no findings. The APK's SHA-256 is `e1a4be25dcfc906d2109ce9c7591ec32aee24f802aad799759ba1213c3b4a3a3`.

This proves the source-build path but is not the final submission record: the configurable Blossom implementation was committed after the immutable `v0.6.1` tag. Once `v0.6.2` is published, replace the baseline commit/version fields with that tag's full commit hash, repeat the isolated build and APK checks, and submit the two recipe files to `fdroiddata`.

### 5. Android distribution and signing strategy

Production Android distribution uses standard F-Droid signing: F-Droid builds the app from source and signs the APK. The F-Droid APK therefore cannot update a GitHub debug installation.

The GitHub workflow continues to build a debug APK only for direct-install testing. Its public filename is `nostr-chat-android-debug-test-only.apk`; the workflow job, artifact name, release warning, and download labels all identify it as test-only. It is not presented as the production Android package, and users may need to uninstall an older test build if its debug signature differs.

Reproducible/upstream signing remains a possible future strategy but is not required for the current standard F-Droid path; see F-Droid’s [Reproducible Builds documentation](https://f-droid.org/en/docs/Reproducible_Builds/). Production builds no longer embed the current time in app metadata. [quasar.config.ts](../quasar.config.ts) derives the bundle and service-worker cache identity from the app version and Git commit SHA, so repeated builds of the same source use the same value.

### 6. Review network anti-features

The default Nostr relays in [relays.ts](../src/constants/relays.ts) are user-configurable, so they should not normally make the whole application dependent on one fixed provider.

The current media-upload implementation defaults to `blossom.nostr.build` but lets users replace it with another HTTPS Blossom server. The selection is restored from encrypted NIP-78 preferences and is used for both the upload endpoint and server-scoped authorization. This removes the fixed-provider dependency, although the default service and general network behavior should remain clearly disclosed to reviewers. Anti-features are warnings and do not automatically cause rejection; see the [Anti-Features policy](https://f-droid.org/en/docs/Anti-Features/).

## What is already in good shape

- The project has a real Capacitor Android target; it does not need to be rewritten in Kotlin.
- The current Android implementation includes meaningful native behavior: foreground service, boot handling and relay notifications.
- The root repository is MIT licensed in [LICENSE](../LICENSE).
- No current ads, analytics or tracking SDKs were found.
- The published `v0.6.1` notification implementation does not depend on Google services.
- Android versioning and release signing are already parameterized through Gradle in [build.gradle](../src-capacitor/android/app/build.gradle).

## Recommended release sequence

1. Complete the remaining asset and brand licensing review.
2. Confirm with reviewers whether the configurable Blossom default needs any anti-feature disclosure.
3. Run the complete project validation and Android smoke tests.
4. Bump the version and create a new immutable release tag (normally `v0.6.2`) containing the configurable Blossom implementation; do not move `v0.6.1`.
5. Retarget the tested F-Droid recipe to the new tag and repeat the isolated build and APK checks.
6. Submit a merge request to the official `fdroiddata` repository.
7. Respond to scanner/reviewer feedback and document any requested anti-features.

With the NDK dependency, Firebase-free release, configurable Blossom implementation, baseline source-build recipe, and Android distribution strategy addressed, the application looks like a reasonable F-Droid candidate once the remaining release and disclosure work is complete.
