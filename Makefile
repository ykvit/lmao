SHELL := /bin/bash
.SHELLFLAGS := -O globstar -c
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
CMD_DOWN := docker compose $(COMPOSE_BASE)

SERVICE_APP := app
VOL_OLLAMA  := ollama

.DEFAULT_GOAL := help

##@ General
help: ##> Show this help message with sections.
	@awk 'BEGIN {FS = ":.*?##> "} /^##@/ { printf("\n\033[1;33m%s\033[0m\n", substr($$0, 5)); next; } /^[a-zA-Z0-9_.-]+:.*?##> / { printf("  \033[36m%-18s\033[0m %s\n", $$1, $$2); }' $(MAKEFILE_LIST)

##@ Deployment
dev: ##> Start DEV environment (Usage: make dev [GPU=1]).
	@echo "Starting DEV environment"
	$(CMD_DEV) up --build -d
	@echo "App is running at http://localhost:5000"

prod: ##> Start PROD environment (Usage: make prod [GPU=1]).
	@echo "Starting PROD environment"
	$(CMD_PROD) up --build -d
	@echo "App is running at http://localhost:5000"

logs: ##> View logs (DEV only).
	@echo "Tailing logs"
	$(CMD_DEV) logs -f

shell: ##> Open an interactive bash shell in app container (DEV only).
	@echo "Entering app container"
	$(CMD_DEV) exec $(SERVICE_APP) /bin/bash

##@ Quality & CI
format: ##> Automatically format Python code (Ruff).
	@echo "Formatting Python code"
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff format .
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff check --fix .

lint: ##> Run static code analysis (Ruff).
	@echo "Running Ruff Linter"
	$(CMD_DEV) run --rm --no-deps $(SERVICE_APP) ruff check .

test: ##> Run all tests (Pytest).
	@echo "Running Pytest"
	$(CMD_DEV) run --rm $(SERVICE_APP) pytest tests/

ci: format lint test ##> Run CI locally (Format -> Lint -> Test).
	@echo "CI pipeline completed successfully."

##@ Cleanup
down: ##> Stop all environments.
	@echo "Stopping all environments"
	$(CMD_DOWN) down --remove-orphans

clean: ##> Deep clean: remove volumes, build cache, and __pycache__.
	@echo "Deep Cleaning"
	$(CMD_DOWN) down -v --remove-orphans
	-docker builder prune -af
	-find . -type d -name "__pycache__" -exec rm -r {} +
	-find . -type d -name ".pytest_cache" -exec rm -r {} +
	-find . -type d -name ".ruff_cache" -exec rm -r {} +
