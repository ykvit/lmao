#!/usr/bin/env bash
set -Eeuo pipefail

platform="${1:?Usage: scan-image.sh PLATFORM IMAGE TRIVY_IMAGE CACHE_DIR REPO_DIR}"
image="${2:?Missing IMAGE}"
trivy_image="${3:?Missing TRIVY_IMAGE}"
cache_dir="${4:?Missing CACHE_DIR}"
repo_dir="${5:?Missing REPO_DIR}"

temporary_dir="$(mktemp -d)"

cleanup() {
    local status=$?
    trap - EXIT
    rm -rf -- "$temporary_dir"
    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$cache_dir"

docker image save \
    --output "$temporary_dir/image.tar" \
    "$image"

docker run --rm \
    --platform "$platform" \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --volume "$temporary_dir:/scan:ro" \
    --volume "$cache_dir:/cache" \
    --volume "$repo_dir:/repo:ro" \
    --workdir /repo \
    --entrypoint trivy \
    "$trivy_image" \
    image \
    --cache-dir /cache \
    --input /scan/image.tar \
    --severity CRITICAL,HIGH \
    --exit-code 1 \
    --ignore-unfixed \
    --vuln-type os,library \
    --scanners vuln \
    --timeout 10m