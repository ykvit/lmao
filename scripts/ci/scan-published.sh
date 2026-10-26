#!/usr/bin/env bash
# Scan the published image with Trivy: the latest tag and the current X.Y tag.
# Tags that point to the same digest are scanned once.
# SARIF_FILE (optional) receives the report for the latest tag.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env PUBLISHED_IMAGE

minor="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([0-9]+\.[0-9]+)\.[0-9]+.*/\1/p' pyproject.toml)"
[[ -n "$minor" ]] || die "Cannot find version in pyproject.toml."

status=0
seen=" "

for tag in latest "$minor"; do
    ref="$PUBLISHED_IMAGE:$tag"

    digest="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
    if [[ -z "$digest" ]]; then
        [[ "$tag" != latest ]] || die "Cannot resolve $ref. Is a release published?"
        warn "Skipping $ref: tag is not published."
        continue
    fi

    if [[ "$seen" == *" $digest "* ]]; then
        log "$ref has the same digest as a scanned tag, skipping."
        continue
    fi
    seen+="$digest "

    sarif=""
    if [[ "$tag" == latest ]]; then
        sarif="${SARIF_FILE:-}"
    fi

    log "Pulling $ref"
    docker pull --quiet "$ref" >/dev/null

    SCAN_IMAGE="$ref" SARIF_FILE="$sarif" scripts/ci/scan-image.sh || status=1
done

exit "$status"