#!/usr/bin/env bash
# Lint GitHub workflows with actionlint and audit them with zizmor.
# ZIZMOR_ONLINE=1 enables online audits and requires GH_TOKEN.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env ACTIONLINT_IMAGE ZIZMOR_IMAGE

shopt -s nullglob
files=(.github/workflows/*.yml .github/workflows/*.yaml)
shopt -u nullglob

[[ ${#files[@]} -gt 0 ]] || die "No workflow files found in .github/workflows."

log "actionlint"
docker_tool \
    --network none \
    --entrypoint actionlint \
    "$ACTIONLINT_IMAGE" \
    "${files[@]}"

format=plain
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    format=github
fi

if [[ "${ZIZMOR_ONLINE:-0}" == 1 ]]; then
    [[ -n "${GH_TOKEN:-}" ]] \
        || die "GH_TOKEN is required. Try: GH_TOKEN=\"\$(gh auth token)\" make ci"

    log "zizmor (online)"
    docker_tool \
        --env GH_TOKEN \
        --entrypoint zizmor \
        "$ZIZMOR_IMAGE" \
        --format="$format" \
        .
else
    warn "zizmor runs offline. Use 'make ci' for online audits."

    log "zizmor (offline)"
    docker_tool \
        --network none \
        --entrypoint zizmor \
        "$ZIZMOR_IMAGE" \
        --offline \
        --format="$format" \
        .
fi