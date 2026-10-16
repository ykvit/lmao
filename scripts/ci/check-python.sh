#!/usr/bin/env bash
# Check that Dockerfile and pyproject.toml agree on Python major.minor. Never changes source.
set -Eeuo pipefail
# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

docker_mm="$(sed -nE 's/^FROM[[:space:]]+python:([0-9]+\.[0-9]+)[.-].*/\1/p' Dockerfile | head -n1)"
[[ -n "$docker_mm" ]] || die "Cannot parse Python version from the Dockerfile FROM line."

major="${docker_mm%%.*}"
minor="${docker_mm#*.}"
want=">=${docker_mm},<${major}.$((minor + 1))"

have="$(sed -nE 's/^requires-python[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' pyproject.toml)"
[[ -n "$have" ]] || die "Cannot find requires-python in pyproject.toml."

[[ "$have" == "$want" ]] \
    || die "requires-python is \"$have\", but Dockerfile uses Python $docker_mm (expected \"$want\")."

log "Python $docker_mm: Dockerfile and pyproject.toml agree."