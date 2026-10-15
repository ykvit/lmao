#!/usr/bin/env bash
# Copy the verified image index (with attestations) to release tags.
# IMAGE_TAGS: newline-separated list from docker/metadata-action.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env IMAGE_NAME IMAGE_DIGEST IMAGE_TAGS

args=()
while IFS= read -r tag; do
    if [[ -n "$tag" ]]; then
        args+=(--tag "$tag")
    fi
done <<< "$IMAGE_TAGS"

[[ ${#args[@]} -gt 0 ]] || die "No release tags provided."

docker buildx imagetools create \
    "${args[@]}" \
    "${IMAGE_NAME}@${IMAGE_DIGEST}"