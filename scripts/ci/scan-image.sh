#!/usr/bin/env bash
# Scan an image with Trivy. Fails on fixable HIGH/CRITICAL vulnerabilities.
# The image is SCAN_IMAGE, or CI_IMAGE when SCAN_IMAGE is not set.
# SARIF_FILE (optional): also write a SARIF report there. Writing it never fails.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env TRIVY_IMAGE TRIVY_CACHE_DIR

image="${SCAN_IMAGE:-${CI_IMAGE:-}}"
[[ -n "$image" ]] || die "SCAN_IMAGE or CI_IMAGE is not set. Run this through make."

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

# Writable directory mounted at /out for the optional SARIF report.
if [[ -n "${SARIF_FILE:-}" ]]; then
    mkdir -p "$(dirname "$SARIF_FILE")"
    out_dir="$(cd "$(dirname "$SARIF_FILE")" && pwd)"
else
    out_dir="$temporary_dir/out"
    mkdir -p "$out_dir"
fi

log "Exporting $image"
docker image save --output "$temporary_dir/image.tar" "$image"

trivy_scan() {
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        --env HOME=/tmp \
        --volume "$temporary_dir:/scan:ro" \
        --volume "$out_dir:/out" \
        --volume "$TRIVY_CACHE_DIR:/cache" \
        --volume "$REPO_ROOT:/repo:ro" \
        --workdir /repo \
        --entrypoint trivy \
        "$TRIVY_IMAGE" \
        image \
        --cache-dir /cache \
        --input /scan/image.tar \
        --severity CRITICAL,HIGH \
        --ignore-unfixed \
        --vuln-type os,library \
        --scanners vuln \
        --timeout 10m \
        "$@"
}

if [[ -n "${SARIF_FILE:-}" ]]; then
    log "Writing SARIF report: $SARIF_FILE"
    trivy_scan --format sarif --output "/out/$(basename "$SARIF_FILE")" --exit-code 0
fi

log "Scanning $image with Trivy"
trivy_scan --exit-code 1