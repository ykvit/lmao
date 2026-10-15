#!/usr/bin/env bash
# Run Ruff lint and format check inside the dev image. Never changes source.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_PLATFORM CI_DEV_IMAGE

output_format=full
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    output_format=github
fi

docker run --rm \
    --platform "$CI_PLATFORM" \
    --network none \
    --workdir /app \
    "$CI_DEV_IMAGE" \
    sh -c '
        status=0
        ruff check --no-cache --output-format="$1" . || status=1
        ruff format --check --no-cache . || status=1
        exit "$status"
    ' sh "$output_format"