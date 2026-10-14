#!/usr/bin/env bash
# Run tests inside the dev image without network access,
# then copy coverage reports (coverage.xml, htmlcov/) to the repo root.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_PLATFORM CI_DEV_IMAGE

container=""

# shellcheck disable=SC2317
cleanup() {
    local status=$?
    trap - EXIT

    if [[ -n "$container" ]]; then
        docker rm -f "$container" >/dev/null 2>&1 || true
    fi

    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Remove old reports so a failed run cannot leave misleading results.
rm -f -- coverage.xml .coverage
rm -rf -- htmlcov

container="$(
    docker create \
        --platform "$CI_PLATFORM" \
        --network none \
        --env PYTHON_DOTENV_DISABLED=1 \
        --env FLASK_DEBUG=0 \
        --env OLLAMA_BASE_URL=http://127.0.0.1:11434 \
        --env COVERAGE_FILE=/tmp/ci-reports/.coverage \
        --workdir /app \
        "$CI_DEV_IMAGE" \
        sh -ec '
            mkdir -p /tmp/ci-reports
            pytest \
                -p no:cacheprovider \
                --cov-report=xml:/tmp/ci-reports/coverage.xml \
                --cov-report=html:/tmp/ci-reports/htmlcov
        '
)"

run_status=0
docker start --attach "$container" || run_status=$?

test_status="$(docker inspect --format '{{.State.ExitCode}}' "$container")"

# Without -a, docker cp creates files owned by the invoking user.
docker cp "$container:/tmp/ci-reports/." . \
    || warn "No coverage reports were produced."

if [[ "$run_status" != 0 ]]; then
    exit "$run_status"
fi

exit "$test_status"