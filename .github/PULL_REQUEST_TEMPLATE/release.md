<!-- Title: chore: bump version to X.Y.Z -->
<!-- Used by scripts/dev/bump.sh: X.Y.Z is replaced with the real version. -->

Releases vX.Y.Z. Merging this PR publishes the image and creates the GitHub Release.

## Checks

- [ ] `make release-plan` prints the tag vX.Y.Z
- [ ] `GH_TOKEN="$(gh auth token)" make ci` passes