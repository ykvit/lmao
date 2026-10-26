#!/usr/bin/env bash
# Apply Ruff fixes and formatting to the working tree using the dev service.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# --no-deps: do not start Ollama just to run a formatter.
docker compose -f compose.yaml -f compose.dev.yaml \
    run --rm --no-deps --build \
    --user "$(id -u):$(id -g)" \
    app \
    sh -c '
        status=0
        ruff check --fix --no-cache . || status=1
        ruff format --no-cache . || status=1
        exit "$status"
    '

log "Formatted. Review git diff before committing."