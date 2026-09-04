#!/usr/bin/env bash
set -euo pipefail

required_env_vars=(GH_TOKEN TAG COMMIT REPOSITORY)
required_assets=(
  anagram-android-release.apk
  anagram-linux.AppImage
  anagram-linux.deb
  anagram-linux.rpm
  anagram-macos.zip
  anagram-windows.exe
)

validate_env() {
  for env_var in "${required_env_vars[@]}"; do
    if [[ -z "${!env_var:-}" ]]; then
      echo "Missing required environment variable: ${env_var}" >&2
      exit 1
    fi
  done
}

validate_assets() {
  asset_paths=()

  for asset in "${required_assets[@]}"; do
    local asset_path="release-assets/${asset}"
    if [[ ! -f "${asset_path}" ]]; then
      echo "Missing release asset: ${asset}" >&2
      exit 1
    fi

    asset_paths+=("${asset_path}")
  done
}

write_checksums() {
  rm -f release-assets/SHA256SUMS
  sha256sum "${asset_paths[@]}" > release-assets/SHA256SUMS
}

write_release_notes() {
  cat > release-notes.md <<EOF
Automated binary release for ${TAG}.

Commit: ${COMMIT}

Android test-only artifact:

**anagram-android-debug-test-only.apk is a DEBUG build provided only for direct-install testing. It is not a production Android release, is not the F-Droid package, and is not intended for normal user installation or updates. Production Android distribution will be through F-Droid. If Android rejects an update because the debug signing key changed, uninstall the previous test build first.**

Versioned asset URLs:

- Android debug APK (TEST ONLY): https://github.com/${REPOSITORY}/releases/download/${TAG}/anagram-android-debug-test-only.apk
- Linux AppImage: https://github.com/${REPOSITORY}/releases/download/${TAG}/anagram-linux.AppImage
- Linux DEB: https://github.com/${REPOSITORY}/releases/download/${TAG}/anagram-linux.deb
- Linux RPM: https://github.com/${REPOSITORY}/releases/download/${TAG}/anagram-linux.rpm
- macOS ZIP: https://github.com/${REPOSITORY}/releases/download/${TAG}/anagram-macos.zip
- Windows EXE: https://github.com/${REPOSITORY}/releases/download/${TAG}/anagram-windows.exe

Latest asset URLs:

- Android debug APK (TEST ONLY): https://github.com/${REPOSITORY}/releases/latest/download/anagram-android-debug-test-only.apk
- Linux AppImage: https://github.com/${REPOSITORY}/releases/latest/download/anagram-linux.AppImage
- Linux DEB: https://github.com/${REPOSITORY}/releases/latest/download/anagram-linux.deb
- Linux RPM: https://github.com/${REPOSITORY}/releases/latest/download/anagram-linux.rpm
- macOS ZIP: https://github.com/${REPOSITORY}/releases/latest/download/anagram-macos.zip
- Windows EXE: https://github.com/${REPOSITORY}/releases/latest/download/anagram-windows.exe
EOF
}

publish_release() {
  if gh release view "${TAG}" > /dev/null 2>&1; then
    gh release upload "${TAG}" release-assets/* --clobber
    gh release edit "${TAG}" --title "${TAG}" --notes-file release-notes.md --draft=false --prerelease=false
    gh release edit "${TAG}" --latest
    return
  fi

  gh release create "${TAG}" release-assets/* \
    --verify-tag \
    --title "${TAG}" \
    --notes-file release-notes.md \
    --latest=false
  gh release edit "${TAG}" --latest
}

validate_env
validate_assets
write_checksums
write_release_notes
publish_release
