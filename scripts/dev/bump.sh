#!/usr/bin/env bash
# Bump the project version in pyproject.toml and uv.lock using the dev service,
# then commit the bump and open the release PR.
# Usage: bump.sh patch|minor|major [alpha|beta|rc|stable]
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

[[ $# -gt 0 ]] || die "Usage: make bump PART=patch|minor|major"

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "Run from main (current branch: $branch)."
git diff --quiet || die "Unstaged changes in the working tree. Commit or stash first."
git diff --cached --quiet || die "Staged changes in the working tree. Commit or stash first."

args=()
for part in "$@"; do
    args+=(--bump "$part")
done

# --no-deps: do not start Ollama just to bump a version.
docker compose -f compose.yaml -f compose.dev.yaml \
    run --rm --no-deps --build \
    --user "$(id -u):$(id -g)" \
    --env UV_CACHE_DIR=/tmp/uv-cache \
    app \
    uv version "${args[@]}" --no-sync

new_version="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' pyproject.toml)"
log "Version is now $new_version."

# Only pyproject.toml and uv.lock may change.
changed="$(git status --porcelain)"
[[ -n "$changed" ]] || die "Nothing changed: version is already $new_version?"
while IFS= read -r line; do
    file="${line:3}"
    case "$file" in
        pyproject.toml | uv.lock) ;;
        *) die "Unexpected change: $file" ;;
    esac
done <<<"$changed"

git checkout -b "chore/bump-$new_version"
git add pyproject.toml uv.lock
git commit -m "chore: bump version to $new_version"
git push -u origin "chore/bump-$new_version"

# The release label excludes bump PRs from changelogs (see .github/release.yml).
gh label create release --color 0E8A16 --description "Version bump and release PR" 2>/dev/null || true

log "Opening the release PR."
sed "s/X\.Y\.Z/$new_version/g" .github/PULL_REQUEST_TEMPLATE/release.md |
    gh pr create \
        --base main \
        --title "chore: bump version to $new_version" \
        --body-file - \
        --label release
log "Merge the PR to release $new_version."