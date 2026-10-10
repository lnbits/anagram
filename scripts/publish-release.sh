#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_TAG:?Missing release tag}"
: "${RELEASE_DRAFT:?Missing draft policy}"
: "${RELEASE_PRERELEASE:?Missing prerelease policy}"
if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
  # Enforce RC visibility before replacing any assets on reruns.
  if [[ "$RELEASE_DRAFT" == true ]]; then
    gh release edit "$RELEASE_TAG" --draft=true --prerelease=true
  fi
  gh release upload "$RELEASE_TAG" release-assets/* --clobber
  # Preserve manually drafted stable/beta releases on rerun.
else
  # Stage every new release as a draft so nobody sees partially uploaded assets.
  gh release create "$RELEASE_TAG" release-assets/* --verify-tag \
    --title "Anagram $RELEASE_TAG" --generate-notes --draft --prerelease="$RELEASE_PRERELEASE"
  if [[ "$RELEASE_DRAFT" != true ]]; then
    gh release edit "$RELEASE_TAG" --draft=false
  fi
fi
