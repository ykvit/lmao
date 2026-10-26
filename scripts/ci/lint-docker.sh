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
        files=(-f compose.yaml -f "compose.${variant}.yaml")

        if [[ "$gpu" == 1 ]]; then
            files+=(-f compose.gpu.yaml)
        fi

        log "compose config: variant=$variant gpu=$gpu"
        rendered="$(docker compose --env-file /dev/null "${files[@]}" config)"

        # Every published port must be bound to the loopback interface.
        published="$(grep -c 'published:' <<<"$rendered" || true)"
        loopback="$(grep -c 'host_ip: 127.0.0.1' <<<"$rendered" || true)"

        [[ "$published" -gt 0 ]] \
            || die "variant=$variant: no published ports found; the check is not seeing the config."
        [[ "$published" == "$loopback" ]] \
            || die "variant=$variant: a published port is not bound to 127.0.0.1."
    done
done