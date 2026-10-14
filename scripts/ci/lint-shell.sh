#!/usr/bin/env bash
# Run ShellCheck on every script in scripts/.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require_env SHELLCHECK_IMAGE

files=()
while IFS= read -r -d '' file; do
    files+=("$file")
done < <(find scripts -type f -name '*.sh' -print0)

[[ ${#files[@]} -gt 0 ]] || die "No shell scripts found in scripts/."

log "shellcheck (${#files[@]} files)"
docker_tool \
    --network none \
    --entrypoint shellcheck \
    "$SHELLCHECK_IMAGE" \
    "${files[@]}"