#!/usr/bin/env bash
# Lint the Dockerfile and validate every Compose combination.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env HADOLINT_IMAGE

log "hadolint"
docker_tool \
    --network none \
    --entrypoint hadolint \
    "$HADOLINT_IMAGE" \
    --failure-threshold warning \
    Dockerfile

for variant in dev prod; do
    for gpu in 0 1; do
        files=(-f compose.base.yaml -f "compose.${variant}.yaml")

        if [[ "$gpu" == 1 ]]; then
            files+=(-f compose.gpu.yaml)
        fi

        log "compose config: variant=$variant gpu=$gpu"
        docker compose --env-file /dev/null "${files[@]}" config --quiet
    done
done