# Checks. Everything .github/workflows/ci.yml runs is defined here.

export CI_DEV_IMAGE    ?= lmao:dev-ci
export CI_IMAGE        ?= lmao:ci-local
export TRIVY_CACHE_DIR ?= $(HOME)/.cache/lmao/trivy
export GH_TOKEN

# Online zizmor audits: always on in GitHub Actions (CI=true),
# locally only through `make ci`.
export ZIZMOR_ONLINE ?= $(if $(CI),1,0)

# Tool images live in docker/tools.Dockerfile (single source of truth,
# tracked by Dependabot). `$(call tool_image,NAME)` reads `FROM <image> AS NAME`.
TOOLS_FILE := docker/tools.Dockerfile
tool_image = $(or $(shell sed -nE 's/^FROM[[:space:]]+([^[:space:]]+)[[:space:]]+AS[[:space:]]+$(1)[[:space:]]*$$/\1/p' $(TOOLS_FILE)),$(error No image named '$(1)' in $(TOOLS_FILE)))

export ACTIONLINT_IMAGE  := $(call tool_image,actionlint)
export ZIZMOR_IMAGE      := $(call tool_image,zizmor)
export HADOLINT_IMAGE    := $(call tool_image,hadolint)
export SHELLCHECK_IMAGE  := $(call tool_image,shellcheck)
export NODE_IMAGE        := $(call tool_image,node)
export TRIVY_IMAGE       := $(call tool_image,trivy)
export REGISTRY_IMAGE    := $(call tool_image,registry)

# Published image scanned by `make scan-published`. Override for forks.
export PUBLISHED_IMAGE   ?= ghcr.io/ykvit/lmao

.PHONY: check ci \
        check-workflows check-code check-image test-image \
        check-python lint-python lint-shell lint-docker audit test test-js \
        build-dev build-prod smoke-test scan-image \
        scan-published zizmor-sarif


##@ Checks

check: check-workflows check-code check-image ##> All checks offline, no token needed.
	@echo "All checks passed."

ci: export ZIZMOR_ONLINE := 1
ci: check ##> Exactly what GitHub CI runs (needs GH_TOKEN).


##@ CI jobs

check-workflows: ##> Lint GitHub workflows (actionlint, zizmor).
	scripts/ci/lint-workflows.sh

check-code: check-python lint-shell lint-python audit test test-js ##> Check Python version, lint, audit, run Python and JS tests.

check-python: ##> Dockerfile and requires-python agree on Python version.
	scripts/ci/check-python.sh

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

test-js: ##> JavaScript unit tests (node --test).
	scripts/ci/test-js.sh

build-dev: ##> Build dev image.
	scripts/ci/build-image.sh dev "$(CI_DEV_IMAGE)"

build-prod: ##> Build production image.
	scripts/ci/build-image.sh production "$(CI_IMAGE)"

smoke-test: ##> Smoke-test CI_IMAGE.
	scripts/ci/smoke-test.sh

scan-image: ##> Scan CI_IMAGE for vulnerabilities.
	scripts/ci/scan-image.sh

##@ Scheduled security

scan-published: ##> Scan the published image (latest + current X.Y) with Trivy.
	scripts/ci/scan-published.sh

zizmor-sarif: ##> Online zizmor audit as SARIF (needs GH_TOKEN, SARIF_FILE).
	scripts/ci/zizmor-sarif.sh

print-%:
	@printf '%s\n' '$($*)'