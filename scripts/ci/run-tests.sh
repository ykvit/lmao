#!/usr/bin/env bash
set -Eeuo pipefail

platform="${1:?Usage: run-tests.sh PLATFORM IMAGE OUTPUT_DIR}"
image="${2:?Missing IMAGE}"
output_dir="${3:?Missing OUTPUT_DIR}"

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
mkdir -p "$output_dir"
rm -f -- "$output_dir/coverage.xml" "$output_dir/.coverage"
rm -rf -- "$output_dir/htmlcov"

container="$(
    docker create \
        --platform "$platform" \
        --network none \
        --env PYTHON_DOTENV_DISABLED=1 \
        --env FLASK_DEBUG=0 \
        --env OLLAMA_BASE_URL=http://127.0.0.1:11434 \
        --env COVERAGE_FILE=/tmp/ci-reports/.coverage \
        --workdir /app \
        "$image" \
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

test_status="$(
    docker inspect --format '{{.State.ExitCode}}' "$container"
)"

# Without -a, docker cp creates destination files for the invoking user.
docker cp "$container:/tmp/ci-reports/." "$output_dir/"

if [[ "$run_status" != 0 ]]; then
    exit "$run_status"
fi

exit "$test_status"