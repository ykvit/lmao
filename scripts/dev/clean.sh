#!/usr/bin/env bash
# Remove generated reports and caches.
# With --volumes also remove containers and Compose volumes (history!).
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

remove_volumes=0

case "${1:-}" in
    "") ;;
    --volumes) remove_volumes=1 ;;
    *) die "Usage: clean.sh [--volumes]" ;;
esac

if [[ "$remove_volumes" == 1 ]]; then
    warn "Removing containers and Compose volumes, including prod evaluation history."
    log "Preserved: the external Ollama volume (models) and ./history (dev history)."

    for env in dev prod; do
        docker compose \
            -f compose.base.yaml \
            -f "compose.${env}.yaml" \
            down -v --remove-orphans
    done
fi

log "Removing reports and caches"

find . \
    -path ./.git -prune -o \
    -path ./.venv -prune -o \
    -type d \( \
        -name __pycache__ -o \
        -name .pytest_cache -o \
        -name .ruff_cache \
    \) -prune -exec rm -rf {} +

rm -rf -- htmlcov
rm -f -- .coverage .coverage.* coverage.xml