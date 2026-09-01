# Remaining F-Droid submission steps for Anagram 0.7.0

The Anagram repository and its F-Droid recipe are ready for submission:

- Release: `https://github.com/lnbits/anagram/releases/tag/v0.7.0`
- Version name: `0.7.0`
- Android version code: `7`
- Release commit: `825b69632e841871b5c410de756209fe72088071`
- Application ID: `com.nostr.chat`
- Asset rights: confirmed and recorded in `docs/asset-provenance.md`
- Recipe: `metadata/com.nostr.chat.yml`
- Additional source library: `srclibs/rolldown.yml`

The finalized recipe was checked with the current official `fdroidserver` and `fdroiddata` on 2026-09-01. `readmeta`, `rewritemeta`, `checkupdates`, `lint`, `fetch_srclibs`, the isolated build, and the APK scanner all passed. The isolated build checked out the release commit above, rebuilt esbuild and Rolldown from source, and produced an unsigned release APK with package `com.nostr.chat`, version `0.7.0`, and version code `7`. Its SHA-256 was `fee00c55578c7c0a4a553f4837d1202bc763e6b1efc60b2f2544860753671cf4`.

Only submission to the separate `fdroid/fdroiddata` repository remains.

## 1. Fork and clone fdroiddata

Open `https://gitlab.com/fdroid/fdroiddata`, sign in, and select **Fork**. Then clone your fork and create a submission branch from the official `master` branch:

```bash
git clone https://gitlab.com/YOUR_GITLAB_USERNAME/fdroiddata.git
cd fdroiddata
git remote add upstream https://gitlab.com/fdroid/fdroiddata.git
git fetch upstream
git switch -c com.nostr.chat upstream/master
```

Do not push directly to the official repository.

## 2. Copy the finalized recipe

From the `fdroiddata` checkout:

```bash
cp /Users/moto/Documents/GitHub/motorina0/xyz/metadata/com.nostr.chat.yml \
  metadata/com.nostr.chat.yml
```

Check whether Rolldown has already been added by another contributor:

```bash
test -f srclibs/rolldown.yml && sed -n '1,120p' srclibs/rolldown.yml
```

If it does not exist, copy the tested declaration:

```bash
cp /Users/moto/Documents/GitHub/motorina0/xyz/srclibs/rolldown.yml \
  srclibs/rolldown.yml
```

If it exists, compare definitions and use the official upstream version instead of overwriting it. Do not copy the Fastlane files into `fdroiddata`; F-Droid reads them from the tagged Anagram source.

## 3. Commit and push the fdroiddata contribution

```bash
git status --short
git add metadata/com.nostr.chat.yml
```

If Rolldown was newly added:

```bash
git add srclibs/rolldown.yml
```

Commit and push:

```bash
git commit -m "New App: com.nostr.chat"
git push -u origin com.nostr.chat
```

## 4. Open the merge request

Open a GitLab merge request with:

- Source: your fork's `com.nostr.chat` branch.
- Target: `fdroid/fdroiddata` -> `master`.
- Title: `New App: com.nostr.chat`.
- Label: `New App`, if available.

The description should state:

- The submission has upstream/LNbits authorization.
- LNbits controls `nostr.com`, supporting the `com.nostr.chat` application ID.
- The source is MIT licensed.
- Manrope and Space Grotesk are OFL-1.1 licensed and their license files are included.
- LNbits holds the rights required to distribute the store graphics and visible screenshot content; provenance is recorded in `docs/asset-provenance.md`.
- The app contains no Firebase, GMS, advertising, analytics, or tracking SDKs.
- Relay notifications connect directly to configurable Nostr relays.
- Blossom storage is configurable.
- The Sandpack dependency is replaced before npm downloads Nodebox.
- esbuild and Rolldown are rebuilt from source.
- The Capacitor archive in `scanignore` is source input supplied by Capacitor and is unpacked by the Android build; it is not executed or shipped as a standalone binary.
- The package intentionally uses standard F-Droid signing.
- The isolated build and APK scanner passed on 2026-09-01 using the exact release commit.

Do not upload an APK to the merge request. Do not add `Binaries` or `AllowedAPKSigningKeys` when using standard F-Droid signing.

## 5. Respond to review

Reviewers may request asset-rights evidence, a clearer `scanignore` explanation, recipe changes, anti-feature disclosure, or another isolated build. Push corrections to the same branch so the merge request updates automatically.

After acceptance, F-Droid will rebuild the tagged source, sign the APK with F-Droid's key, and publish it.

## Actions that require your authenticated external accounts

Codex cannot create or operate your personal GitLab fork, push its submission branch, open the merge request, or respond as you to F-Droid reviewers without access to your authenticated GitLab account. Those are steps 1, 3, 4, and 5 above. No remaining action in the Anagram repository is required for this submission.
