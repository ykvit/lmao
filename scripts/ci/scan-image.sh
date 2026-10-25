#!/usr/bin/env bash
# Scan CI_IMAGE with Trivy. Fails on fixable HIGH/CRITICAL vulnerabilities.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_IMAGE TRIVY_IMAGE TRIVY_CACHE_DIR

temporary_dir="$(mktemp -d)"

# shellcheck disable=SC2317,SC2329
cleanup() {
    local status=$?
    trap - EXIT
    rm -rf -- "$temporary_dir"
    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$TRIVY_CACHE_DIR"

log "Exporting $CI_IMAGE"
docker image save --output "$temporary_dir/image.tar" "$CI_IMAGE"

log "Scanning with Trivy"
docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --volume "$temporary_dir:/scan:ro" \
    --volume "$TRIVY_CACHE_DIR:/cache" \
    --volume "$REPO_ROOT:/repo:ro" \
    --workdir /repo \
    --entrypoint trivy \
    "$TRIVY_IMAGE" \
    image \
    --cache-dir /cache \
    --input /scan/image.tar \
    --severity CRITICAL,HIGH \
    --exit-code 1 \
    --ignore-unfixed \
    --vuln-type os,library \
    --scanners vuln \
    --timeout 10m