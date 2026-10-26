#!/usr/bin/env bash
# Bump the project version in pyproject.toml and uv.lock using the dev service.
# Usage: bump.sh patch|minor|major [alpha|beta|rc|stable]
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

[[ $# -gt 0 ]] || die "Usage: make bump PART=patch|minor|major"

args=()
for part in "$@"; do
    args+=(--bump "$part")
done

# --no-deps: do not start Ollama just to bump a version.
docker compose -f compose.yaml -f compose.dev.yaml \
    run --rm --no-deps --build \
    --user "$(id -u):$(id -g)" \
    --env UV_CACHE_DIR=/tmp/uv-cache \
    app \
    uv version "${args[@]}" --no-sync

new_version="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' pyproject.toml)"
log "Version is now $new_version."
log "Next: commit pyproject.toml and uv.lock, open a PR. Merging it releases this version."