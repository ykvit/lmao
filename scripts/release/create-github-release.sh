#!/usr/bin/env bash
# Create a GitHub Release for TAG. Safe to rerun.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env TAG GH_TOKEN GITHUB_REPOSITORY

if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    log "GitHub Release $TAG already exists."
    exit 0
fi

args=(
    --repo "$GITHUB_REPOSITORY"
    --title "$TAG"
    --generate-notes
    --verify-tag
)

if [[ "$TAG" == *-* ]]; then
    args+=(--prerelease)
fi

gh release create "$TAG" "${args[@]}"