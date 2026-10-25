# NOT BUILT. Version registry for CI tool images (read by ci.mk, tracked by Dependabot).
# Format is strict: one `FROM <image> AS <name>` per line; <name> is what ci.mk looks up.
# Pin every image by digest: FROM image:tag@sha256:<index digest> AS name
FROM rhysd/actionlint:1.7.7@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9 AS actionlint
FROM ghcr.io/zizmorcore/zizmor:1.6.0@sha256:c92dceb026c6858fd51814baf6b9bdc4328c0a36abf42dfa1bdc59f69a1deb77 AS zizmor
FROM hadolint/hadolint:v2.12.0-alpine@sha256:3c206a451cec6d486367e758645269fd7d696c5ccb6ff59d8b03b0e45268a199 AS hadolint
FROM koalaman/shellcheck:v0.10.0@sha256:2097951f02e735b613f4a34de20c40f937a6c8f18ecb170612c88c34517221fb AS shellcheck
FROM aquasec/trivy:0.61.1@sha256:91bcccab7cb503127b0d792db7c652c4e556c9ff30eeb0908b6ae1980d7727ad AS trivy