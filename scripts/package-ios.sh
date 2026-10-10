#!/usr/bin/env bash
set -euo pipefail
mkdir -p mobile-assets
version=$(node -p 'require("./package.json").version')
if [[ -n "${IOS_CERTIFICATE:-}" || -n "${IOS_MOBILE_PROVISION:-}" ]]; then
  : "${IOS_CERTIFICATE:?Missing IOS_CERTIFICATE}"
  : "${IOS_CERTIFICATE_PASSWORD:?Missing IOS_CERTIFICATE_PASSWORD}"
  : "${IOS_MOBILE_PROVISION:?Missing IOS_MOBILE_PROVISION}"
  : "${APPLE_DEVELOPMENT_TEAM:?Missing APPLE_TEAM_ID}"
  case "${IOS_EXPORT_METHOD:-app-store-connect}" in
    app-store-connect|release-testing|debugging) ;;
    *) echo 'Invalid IOS_EXPORT_METHOD' >&2; exit 1 ;;
  esac
  npm run tauri -- ios build --ci --target aarch64 --export-method "${IOS_EXPORT_METHOD:-app-store-connect}" --config src-tauri/mobile-version.json -- --locked
  suffix=""

else
  unset IOS_CERTIFICATE IOS_CERTIFICATE_PASSWORD IOS_MOBILE_PROVISION
  if [[ -z "${APPLE_DEVELOPMENT_TEAM:-}" ]]; then unset APPLE_DEVELOPMENT_TEAM; fi
  npm run tauri -- ios build --ci --target aarch64 --no-sign --config src-tauri/mobile-version.json -- --locked
  suffix="-unsigned"
  echo 'Unsigned IPA: requires signing before installation on an iPhone.' >> "$GITHUB_STEP_SUMMARY"
fi
# Bash 3.2 on macOS has no mapfile.
count=$(find src-tauri/gen/apple/build -type f -name '*.ipa' | wc -l | tr -d ' ')
[[ "$count" == 1 ]] || { echo 'Expected one IPA'; exit 1; }
ipa=$(find src-tauri/gen/apple/build -type f -name '*.ipa')
python3 scripts/release-smoke/ios_permissions.py "$ipa"
cp "$ipa" "mobile-assets/anagram-${version}-ios${suffix}.ipa"
