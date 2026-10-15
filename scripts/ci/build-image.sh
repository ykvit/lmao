#!/usr/bin/env bash
# Build a Dockerfile target and load it into the local image store.
# In GitHub Actions, the GHA build cache is enabled automatically.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

target="${1:?Usage: build-image.sh dev|production TAG}"
tag="${2:?Usage: build-image.sh dev|production TAG}"

require_env CI_PLATFORM

cache_args=()

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    scope="lmao-${target}"
    cache_args=(
        --cache-from "type=gha,version=2,scope=${scope}"
        --cache-to "type=gha,version=2,scope=${scope},mode=max,ignore-error=true"
    )
fi

log "Building target '$target' as $tag"

docker buildx build \
    ${cache_args[@]+"${cache_args[@]}"} \
    --platform "$CI_PLATFORM" \
    --target "$target" \
    --tag "$tag" \
    --pull \
    --load \
    --provenance=false \
    --sbom=false \
    .