# shellcheck shell=bash
# Shared helpers for all scripts. Source it, do not execute it.
# Scripts are started by make, which exports their configuration
# as environment variables.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() {
    printf '==> %s\n' "$*" >&2
}

warn() {
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        printf '::warning::%s\n' "$*" >&2
    else
        printf 'WARNING: %s\n' "$*" >&2
    fi
}

die() {
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        printf '::error::%s\n' "$*" >&2
    else
        printf 'ERROR: %s\n' "$*" >&2
    fi
    exit 1
}

# Fail early with a clear message when a script is run outside make.
require_env() {
    local name
    for name in "$@"; do
        [[ -n "${!name:-}" ]] || die "$name is not set. Run this through make."
    done
}

# Run a tool container with the repository mounted read-only.
# Tools run on the host platform. Only images under test need CI_PLATFORM.
docker_tool() {
    docker run --rm \
        --volume "$REPO_ROOT:/repo:ro" \
        --workdir /repo \
        "$@"
}