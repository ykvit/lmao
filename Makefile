SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --no-print-directory

export UID := $(shell id -u)
export GID := $(shell id -g)

COMPOSE_BASE := -f compose.base.yaml
COMPOSE_DEV  := -f compose.dev.yaml
COMPOSE_PROD := -f compose.prod.yaml

COMPOSE_GPU :=
ifeq ($(GPU),1)
	COMPOSE_GPU := -f compose.gpu.yaml
endif

CMD_DEV  := docker compose $(COMPOSE_BASE) $(COMPOSE_DEV) $(COMPOSE_GPU)
CMD_PROD := docker compose $(COMPOSE_BASE) $(COMPOSE_PROD) $(COMPOSE_GPU)

ENV ?= dev
ifeq ($(ENV),prod)
	CMD_ACTIVE := $(CMD_PROD)
else
	CMD_ACTIVE := $(CMD_DEV)
endif

SERVICE_APP := app
VOL_OLLAMA  := ollama

# Same architecture locally and on the GitHub runner.
# ARM hosts require Docker emulation.
export CI_PLATFORM ?= linux/amd64
export CI_DEV_IMAGE ?= lmao:dev-ci
export CI_IMAGE ?= lmao:ci-local

# Empty locally: Docker still uses its normal local build cache.
# GitHub Actions supplies GHA cache arguments.
BUILDX_CACHE_ARGS ?=

# Shared tool versions. Update centrally.
ACTIONLINT_IMAGE := rhysd/actionlint:1.7.7
ZIZMOR_IMAGE     := ghcr.io/zizmorcore/zizmor:1.6.0
HADOLINT_IMAGE   := hadolint/hadolint:v2.12.0-alpine
SHELLCHECK_IMAGE := koalaman/shellcheck:v0.10.0
TRIVY_IMAGE      := aquasec/trivy:0.61.1

TRIVY_CACHE_DIR ?= $(HOME)/.cache/lmao/trivy

# auto: online when GH_TOKEN exists, otherwise offline with a warning.
# online: require GH_TOKEN.
# offline: explicitly disable online checks.
WORKFLOW_LINT_MODE ?= auto
export GH_TOKEN

DOCKER_RUN := docker run --rm --platform "$(CI_PLATFORM)"

.DEFAULT_GOAL := help

.PHONY: help setup dev prod logs shell \
        format format-check lint audit test coverage-html \
        ci ci-check ci-quality ci-image ci-workflows ci-shellcheck \
        ci-build-dev ci-build-prod ci-config-check ci-smoke ci-trivy \
        down down-all clean


##@ General

help: ##> Show this help message.
	@awk 'BEGIN {FS = ":.*?##> "} /^##@/ { printf("\n\033[1;33m%s\033[0m\n", substr($$0, 5)); next; } /^[a-zA-Z0-9_.-]+:.*?##> / { printf("  \033[36m%-20s\033[0m %s\n", $$1, $$2); }' $(MAKEFILE_LIST)


##@ Setup & Infrastructure

setup: ##> Create required external Docker volumes.
	docker volume create "$(VOL_OLLAMA)"


##@ Deployment

dev: setup ##> Start DEV (Usage: make dev [GPU=1]).
	$(CMD_DEV) up --build -d
	@echo "App is running at http://localhost:5000"

prod: setup ##> Start PROD (Usage: make prod [GPU=1]).
	$(CMD_PROD) up --build -d
	@echo "App is running at http://localhost:5000"

logs: ##> View logs (Usage: make logs [ENV=prod] [GPU=1]).
	$(CMD_ACTIVE) logs -f

shell: ##> Open bash in app (Usage: make shell [ENV=prod]).
	$(CMD_ACTIVE) exec $(SERVICE_APP) /bin/bash


##@ Quality

# GNU Make builds this shared prerequisite once per invocation.
format format-check lint audit test: ci-build-dev

format: ##> Apply Ruff fixes and format local Python files.
	$(DOCKER_RUN) \
		--network none \
		--user "$(UID):$(GID)" \
		--volume "$(CURDIR):/app" \
		--workdir /app \
		"$(CI_DEV_IMAGE)" \
		sh -ec '\
			status=0; \
			ruff check --fix --no-cache . || status=$$?; \
			ruff format --no-cache . || status=$$?; \
			exit "$$status"'

format-check: ##> Check formatting without modifying local source.
	$(DOCKER_RUN) \
		--network none \
		--workdir /app \
		"$(CI_DEV_IMAGE)" \
		ruff format --check --no-cache .

lint: ##> Run Ruff without modifying local source.
	$(DOCKER_RUN) \
		--network none \
		--workdir /app \
		"$(CI_DEV_IMAGE)" \
		ruff check --no-cache --output-format=github .

audit: ##> Audit production dependencies from the current uv.lock.
	$(DOCKER_RUN) \
		--env XDG_CACHE_HOME=/tmp/.cache \
		--workdir /app \
		"$(CI_DEV_IMAGE)" \
		sh -ec '\
			uv export \
				--locked \
				--no-dev \
				--no-emit-project \
				--no-hashes \
				--format requirements-txt \
				--output-file /tmp/requirements-audit.txt; \
			pip-audit --no-deps -r /tmp/requirements-audit.txt'

test: ##> Run isolated tests and export coverage reports.
	bash scripts/ci/run-tests.sh \
		"$(CI_PLATFORM)" \
		"$(CI_DEV_IMAGE)" \
		"$(CURDIR)"

coverage-html: test ##> Run tests and generate HTML coverage.
	@echo "Report is available in htmlcov/index.html"


##@ CI Pipelines

ci: ##> Fix and format source, then run every CI check.
	+$(MAKE) format
	+$(MAKE) ci-check
	@echo "Code formatted and all CI checks passed."
	@echo "Review git diff before committing."

ci-check: ##> Run all server checks locally; requires GH_TOKEN.
	+$(MAKE) ci-workflows WORKFLOW_LINT_MODE=online
	+$(MAKE) ci-quality
	+$(MAKE) ci-image
	@echo "All CI checks passed."

ci-quality: ##> Check formatting, lint, dependencies, and tests.
	+$(MAKE) --jobs=1 format-check lint audit test

ci-image: ##> Validate, build, smoke-test, and scan production.
	+$(MAKE) --jobs=1 ci-config-check ci-smoke ci-trivy


##@ CI Building Blocks

ci-build-dev: ##> Build the dev image from the current working tree.
	docker buildx build \
		$(BUILDX_CACHE_ARGS) \
		--platform "$(CI_PLATFORM)" \
		--target dev \
		--tag "$(CI_DEV_IMAGE)" \
		--pull \
		--load \
		--provenance=false \
		--sbom=false \
		.

ci-build-prod: ##> Build the production image.
	docker buildx build \
		$(BUILDX_CACHE_ARGS) \
		--platform "$(CI_PLATFORM)" \
		--target production \
		--tag "$(CI_IMAGE)" \
		--pull \
		--load \
		--provenance=false \
		--sbom=false \
		.

ci-shellcheck: ##> Check CI shell scripts with ShellCheck.
	$(DOCKER_RUN) \
		--network none \
		--volume "$(CURDIR):/repo:ro" \
		--workdir /repo \
		--entrypoint shellcheck \
		"$(SHELLCHECK_IMAGE)" \
		scripts/ci/*.sh

ci-workflows: ci-shellcheck ##> Check workflows and scripts; offline fallback allowed.
	@shopt -s nullglob; \
	files=(.github/workflows/*.yml .github/workflows/*.yaml); \
	if [[ $${#files[@]} -eq 0 ]]; then \
		echo "No GitHub workflow files found." >&2; \
		exit 1; \
	fi; \
	$(DOCKER_RUN) \
		--volume "$(CURDIR):/repo:ro" \
		--workdir /repo \
		--entrypoint actionlint \
		"$(ACTIONLINT_IMAGE)" \
		"$${files[@]}"
	@mode="$(WORKFLOW_LINT_MODE)"; \
	if [[ "$$mode" == auto ]]; then \
		if [[ -n "$${GH_TOKEN:-}" ]]; then \
			mode=online; \
		else \
			mode=offline; \
		fi; \
	fi; \
	docker_args=(); \
	zizmor_args=(); \
	case "$$mode" in \
		online) \
			if [[ -z "$${GH_TOKEN:-}" ]]; then \
				echo "GH_TOKEN is required for full online workflow checks." >&2; \
				echo "For offline-only checks, run: make ci-workflows" >&2; \
				exit 1; \
			fi; \
			docker_args+=(--env GH_TOKEN); \
			;; \
		offline) \
			echo "WARNING: zizmor is offline; online audits are not performed." >&2; \
			zizmor_args+=(--offline); \
			;; \
		*) \
			echo "Invalid WORKFLOW_LINT_MODE: $$mode" >&2; \
			exit 1; \
			;; \
	esac; \
	$(DOCKER_RUN) \
		"$${docker_args[@]}" \
		--volume "$(CURDIR):/repo:ro" \
		--workdir /repo \
		--entrypoint zizmor \
		"$(ZIZMOR_IMAGE)" \
		"$${zizmor_args[@]}" \
		--format=github \
		.github/workflows/

ci-config-check: ##> Lint Dockerfile and validate all Compose combinations.
	$(DOCKER_RUN) \
		--network none \
		--volume "$(CURDIR):/repo:ro" \
		--workdir /repo \
		--entrypoint hadolint \
		"$(HADOLINT_IMAGE)" \
		--failure-threshold warning \
		Dockerfile
	@for variant in dev prod; do \
		for gpu in 0 1; do \
			args=(-f compose.base.yaml -f "compose.$${variant}.yaml"); \
			if [[ "$$gpu" == 1 ]]; then \
				args+=(-f compose.gpu.yaml); \
			fi; \
			echo "Validating Compose: variant=$$variant gpu=$$gpu"; \
			env UID="$(UID)" GID="$(GID)" \
				docker compose \
				--env-file /dev/null \
				"$${args[@]}" \
				config --quiet; \
		done; \
	done

# Built once when both targets are invoked by ci-image.
ci-smoke ci-trivy: ci-build-prod

ci-smoke: ##> Check production HEALTHCHECK and non-root execution.
	bash scripts/ci/smoke-test.sh \
		"$(CI_PLATFORM)" \
		"$(CI_IMAGE)"

ci-trivy: ##> Scan production for fixable HIGH/CRITICAL vulnerabilities.
	bash scripts/ci/scan-image.sh \
		"$(CI_PLATFORM)" \
		"$(CI_IMAGE)" \
		"$(TRIVY_IMAGE)" \
		"$(TRIVY_CACHE_DIR)" \
		"$(CURDIR)"


##@ Cleanup

down: ##> Stop the active environment (Usage: make down [ENV=prod]).
	$(CMD_ACTIVE) down --remove-orphans

down-all: ##> Stop containers using both Compose configurations.
	$(CMD_DEV) down --remove-orphans
	$(CMD_PROD) down --remove-orphans

clean: ##> Remove containers, Compose volumes, and Python reports/caches.
	@echo "WARNING: Compose-managed volumes, including history_data, will be removed."
	@echo "The external Ollama volume is preserved."
	$(CMD_DEV) down -v --remove-orphans
	$(CMD_PROD) down -v --remove-orphans
	find . -type d \( \
		-name "__pycache__" -o \
		-name ".pytest_cache" -o \
		-name ".ruff_cache" \
		\) -prune -exec rm -rf {} +
	rm -rf htmlcov
	rm -f .coverage .coverage.* coverage.xml