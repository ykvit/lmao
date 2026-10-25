#!/usr/bin/env bash
# Audit locked production dependencies with pip-audit.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env CI_DEV_IMAGE

docker run --rm \
    --env XDG_CACHE_HOME=/tmp/.cache \
    --workdir /app \
    "$CI_DEV_IMAGE" \
    sh -ec '
        uv export \
            --locked \
            --no-dev \
            --no-emit-project \
            --no-hashes \
            --format requirements-txt \
            --output-file /tmp/requirements-audit.txt
        pip-audit --no-deps -r /tmp/requirements-audit.txt
    '