#!/usr/bin/env bash
# Start CI_IMAGE, wait for its HEALTHCHECK and verify it does not run as root.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_IMAGE

container=""

# shellcheck disable=SC2317,SC2329
cleanup() {
    local status=$?
    trap - EXIT

    if [[ -n "$container" ]]; then
        if [[ "$status" != 0 ]]; then
            echo "=== Container health ==="
            docker inspect --format '{{json .State.Health}}' "$container" || true
            echo "=== Container logs ==="
            docker logs "$container" 2>&1 || true
        fi

        docker rm -f "$container" >/dev/null 2>&1 || true
    fi

    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "Starting $CI_IMAGE"

container="$(
    docker run --detach \
        --health-interval=2s \
        --health-timeout=3s \
        --health-start-period=5s \
        --health-retries=30 \
        "$CI_IMAGE"
)"

health=starting

for i in {1..60}; do
    running="$(docker inspect --format '{{.State.Running}}' "$container")"
    [[ "$running" == true ]] || die "Container exited prematurely."

    health="$(
        docker inspect \
            --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
            "$container"
    )"

    case "$health" in
        healthy) break ;;
        unhealthy|missing) die "Container health: $health" ;;
    esac

    echo "Waiting for application... ($i/60)"
    sleep 2
done

[[ "$health" == healthy ]] || die "Application failed to become healthy."
log "Application is healthy."

user_id="$(docker exec "$container" id -u)"
[[ "$user_id" != 0 ]] || die "Container is running as root."
log "Container runs as UID $user_id."