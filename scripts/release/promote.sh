#!/usr/bin/env bash
# Copy the verified image to the release tags
# and check that every tag resolves to the digest that was tested.
# IMAGE_SOURCE: image@digest to copy (the staging registry).
# IMAGE_TAGS: newline-separated list from docker/metadata-action.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env IMAGE_SOURCE IMAGE_DIGEST IMAGE_TAGS

args=()
while IFS= read -r tag; do
    if [[ -n "$tag" ]]; then
        args+=(--tag "$tag")
    fi
done <<< "$IMAGE_TAGS"

[[ ${#args[@]} -gt 0 ]] || die "No release tags provided."

docker buildx imagetools create "${args[@]}" "$IMAGE_SOURCE"

while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    got="$(docker buildx imagetools inspect "$tag" | awk '/^Digest:/{print $2; exit}')"
    [[ "$got" == "$IMAGE_DIGEST" ]] \
        || die "$tag resolves to ${got:-nothing}, expected $IMAGE_DIGEST."
    log "$tag -> $got"
done <<< "$IMAGE_TAGS"