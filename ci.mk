# Checks. Everything .github/workflows/ci.yml runs is defined here.

export CI_PLATFORM     ?= linux/amd64
export CI_DEV_IMAGE    ?= lmao:dev-ci
export CI_IMAGE        ?= lmao:ci-local
export TRIVY_CACHE_DIR ?= $(HOME)/.cache/lmao/trivy
export GH_TOKEN

# Online zizmor audits: always on in GitHub Actions (CI=true),
# locally only through `make ci`.
export ZIZMOR_ONLINE ?= $(if $(CI),1,0)

export ACTIONLINT_IMAGE := rhysd/actionlint:1.7.7
export ZIZMOR_IMAGE     := ghcr.io/zizmorcore/zizmor:1.6.0
export HADOLINT_IMAGE   := hadolint/hadolint:v2.12.0-alpine
export SHELLCHECK_IMAGE := koalaman/shellcheck:v0.10.0
export TRIVY_IMAGE      := aquasec/trivy:0.61.1

.PHONY: check ci \
        check-workflows check-code check-image test-image \
        lint-python lint-shell lint-docker audit test \
        build-dev build-prod smoke-test scan-image


##@ Checks

check: check-workflows check-code check-image ##> All checks offline, no token needed.
	@echo "All checks passed."

ci: export ZIZMOR_ONLINE := 1
ci: check ##> Exactly what GitHub CI runs (needs GH_TOKEN).


##@ CI jobs

check-workflows: ##> Lint GitHub workflows (actionlint, zizmor).
	scripts/ci/lint-workflows.sh

check-code: lint-shell lint-python audit test ##> Lint Python and shell, audit deps, run tests.

check-image: lint-docker build-prod test-image ##> Lint Docker config, build and test prod image.

test-image: smoke-test scan-image ##> Smoke-test and scan existing CI_IMAGE (no build).


##@ Building blocks

lint-python audit test: build-dev

lint-python: ##> Ruff lint and format check.
	scripts/ci/lint-python.sh

lint-shell: ##> ShellCheck all scripts.
	scripts/ci/lint-shell.sh

lint-docker: ##> Hadolint and Compose validation.
	scripts/ci/lint-docker.sh

audit: ##> Audit production dependencies.
	scripts/ci/audit.sh

test: ##> Tests with coverage (coverage.xml, htmlcov/).
	scripts/ci/test.sh

build-dev: ##> Build dev image.
	scripts/ci/build-image.sh dev "$(CI_DEV_IMAGE)"

build-prod: ##> Build production image.
	scripts/ci/build-image.sh production "$(CI_IMAGE)"

smoke-test: ##> Smoke-test CI_IMAGE.
	scripts/ci/smoke-test.sh

scan-image: ##> Scan CI_IMAGE for vulnerabilities.
	scripts/ci/scan-image.sh