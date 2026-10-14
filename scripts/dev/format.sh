#!/usr/bin/env bash
# Apply Ruff fixes and formatting to the working tree.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_PLATFORM CI_DEV_IMAGE

docker run --rm \
    --platform "$CI_PLATFORM" \
    --network none \
    --user "$(id -u):$(id -g)" \
    --volume "$REPO_ROOT:/app" \
    --workdir /app \
    "$CI_DEV_IMAGE" \
    sh -c '
        status=0
        ruff check --fix --no-cache . || status=1
        ruff format --no-cache . || status=1
        exit "$status"
    '

log "Formatted. Review git diff before committing."