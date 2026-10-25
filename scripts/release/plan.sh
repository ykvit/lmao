#!/usr/bin/env bash
# Derive the release tag from pyproject.toml and decide whether to release it.
# A version is released once: its tag is created last, by the GitHub Release.
# Prints version, tag, release and prerelease (and appends them to $GITHUB_OUTPUT).
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

emit() {
    printf '%s=%s\n' "$1" "$2"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
    fi
}

version="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' pyproject.toml)"
[[ -n "$version" ]] || die "Cannot find version in pyproject.toml."

# PEP 440 -> semver tag: 1.2.3 -> v1.2.3, 1.2.3rc1 -> v1.2.3-rc.1
re='^([0-9]+\.[0-9]+\.[0-9]+)((a|b|rc)([0-9]+))?$'
[[ "$version" =~ $re ]] \
    || die "Unsupported version \"$version\". Use X.Y.Z, X.Y.ZaN, X.Y.ZbN or X.Y.ZrcN."

base="${BASH_REMATCH[1]}"
kind="${BASH_REMATCH[3]}"
number="${BASH_REMATCH[4]}"

prerelease=true
case "$kind" in
    "")  tag="v${base}"; prerelease=false ;;
    a)   tag="v${base}-alpha.${number}" ;;
    b)   tag="v${base}-beta.${number}" ;;
    rc)  tag="v${base}-rc.${number}" ;;
esac

release=true
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    release=false
fi

log "version $version -> tag $tag (release=$release)"

emit version "$version"
emit tag "$tag"
emit release "$release"
emit prerelease "$prerelease"