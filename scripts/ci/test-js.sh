#!/usr/bin/env bash
# Run the JavaScript unit tests (node --test) in the pinned Node image.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env NODE_IMAGE

log "node --test"
docker_tool \
    --network none \
    --entrypoint node \
    "$NODE_IMAGE" \
    --test "tests/js/*.test.js"