#!/usr/bin/env bash
set -Eeuo pipefail

platform="${1:?Usage: smoke-test.sh PLATFORM IMAGE}"
image="${2:?Missing IMAGE}"

container=""

cleanup() {
    local status=$?
    trap - EXIT

    if [[ -n "$container" ]]; then
        echo "=== Container health ==="
        docker inspect \
            --format '{{json .State.Health}}' \
            "$container" || true

        echo "=== Container logs ==="
        docker logs "$container" 2>&1 || true

        docker rm -f "$container" >/dev/null 2>&1 || true
    fi

    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container="$(
    docker run --detach \
        --platform "$platform" \
        --health-interval=2s \
        --health-timeout=3s \
        --health-start-period=5s \
        --health-retries=30 \
        "$image"
)"

healthy=0

for i in {1..60}; do
    running="$(
        docker inspect --format '{{.State.Running}}' "$container"
    )"

    if [[ "$running" != true ]]; then
        echo "::error::Container exited prematurely"
        exit 1
    fi

    health="$(
        docker inspect \
            --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
            "$container"
    )"

    case "$health" in
        healthy)
            healthy=1
            break
            ;;
        unhealthy|missing)
            echo "::error::Container health: $health"
            exit 1
            ;;
    esac

    echo "Waiting for application... ($i/60)"
    sleep 2
done

if [[ "$healthy" != 1 ]]; then
    echo "::error::Application failed to become healthy"
    exit 1
fi

echo "Application is healthy."

user_id="$(docker exec "$container" id -u)"

if [[ "$user_id" == 0 ]]; then
    echo "::error::Container is running as root"
    exit 1
fi

echo "Container runs as UID $user_id."