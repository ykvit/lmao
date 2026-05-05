SHELL := /bin/bash
MAKEFLAGS += --no-print-directory

# Capture UID/GID to pass to compose.dev.yaml for correct file permissions (prevents root-owned files).
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
PORT        ?= 5000

.DEFAULT_GOAL := help

##@ General
help: ##> Show this help message.
	@awk 'BEGIN {FS = ":.*?##> "} /^##@/ { printf("\n\033[1;33m%s\033[0m\n", substr($$0, 5)); next; } /^[a-zA-Z0-9_.-]+:.*?##> / { printf("  \033[36m%-18s\033[0m %s\n", $$1, $$2); }' $(MAKEFILE_LIST)

##@ Setup & Infrastructure
setup: ##> Create required external Docker volumes (Run this first!).
	@echo "Creating external volume '$(VOL_OLLAMA)'"
	docker volume create $(VOL_OLLAMA) || true

##@ Deployment
dev: setup ##> Start DEV environment (Usage: make dev [GPU=1]).
	@echo "Starting DEV environment"
	$(CMD_DEV) up --build -d
	@echo "App is running at http://localhost:$(PORT)"

prod: setup ##> Start PROD environment (Usage: make prod[GPU=1]).
	@echo "Starting PROD environment"
	$(CMD_PROD) up --build -d
	@echo "App is running at http://localhost:$(PORT)"

logs: ##> View logs.
	@echo "Tailing logs for $(ENV) environment"
	$(CMD_ACTIVE) logs -f

shell: ##> Open an interactive bash shell in app container.
	@echo "Entering app container in $(ENV) environment"
	$(CMD_ACTIVE) exec $(SERVICE_APP) /bin/bash

##@ Quality & CI
# NOTE: All tooling (Ruff, Pytest, pip-audit) is run using CMD_DEV because 
# the 'dev' image contains the required dependencies from requirements-dev.txt.

format: ##> Auto-format Python code (Local pre-commit tool).
	@echo "Formatting Python code"
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff format .
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff check --fix .

format-check: ##> Check code formatting strictly (GH Actions tool).
	@echo "Checking Python code formatting"
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff format --check .

lint: ##> Run static code analysis (GH Actions tool).
	@echo "Running Ruff Linter"
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff check .

audit: ##> Run vulnerability scanning.
	@echo "Running Security Audit (pip-audit)"
	$(CMD_DEV) run --rm --no-deps -e XDG_CACHE_HOME=/tmp/.cache $(SERVICE_APP) pip-audit

test: ##> Run tests with coverage report.
	@echo "Running Pytest"
	$(CMD_DEV) run --rm $(SERVICE_APP) pytest tests/

coverage-html: ##> Generate detailed HTML coverage report.
	@echo "Generating HTML Coverage Report"
	$(CMD_DEV) run --rm $(SERVICE_APP) pytest --cov-report=html tests/
	@echo "Report is available in htmlcov/index.html"

ci: format audit test ##> Local workflow: Auto-format -> Audit -> Test.
	@echo "Local pre-push checks passed! Ready to commit."

ci-check: format-check lint audit test ##> Server workflow (GH Actions): Strict Read-Only CI pipeline.
	@echo "CI pipeline passed successfully."

##@ Cleanup
down: ##> Stop the active environment.
	@echo "Stopping $(ENV) environment"
	$(CMD_ACTIVE) down --remove-orphans

down-all: ##> Stop ALL environments (dev and prod).
	@echo "Stopping ALL environments"
	$(CMD_DEV) down --remove-orphans
	$(CMD_PROD) down --remove-orphans

clean: ##> Deep clean: remove containers, cache, and compiled Python files.
	@echo "Deep Cleaning"
	$(CMD_DEV) down -v --remove-orphans
	$(CMD_PROD) down -v --remove-orphans
	-docker builder prune -af
	-find . -type d -name "__pycache__" -prune -exec rm -rf {} +
	-find . -type d -name ".pytest_cache" -prune -exec rm -rf {} +
	-find . -type d -name ".ruff_cache" -prune -exec rm -rf {} +
