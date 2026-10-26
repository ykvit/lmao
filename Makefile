SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --no-print-directory
.NOTPARALLEL:
.DEFAULT_GOAL := help

export UID := $(shell id -u)
export GID := $(shell id -g)

COMPOSE_GPU := $(if $(filter 1,$(GPU)),-f compose.gpu.yaml)
CMD_DEV     := docker compose -f compose.yaml -f compose.dev.yaml $(COMPOSE_GPU)
CMD_PROD    := docker compose -f compose.yaml -f compose.prod.yaml $(COMPOSE_GPU)
CMD_ACTIVE  := $(if $(filter prod,$(ENV)),$(CMD_PROD),$(CMD_DEV))

.PHONY: help models-volume dev prod logs shell down down-all format clean reset bump release-plan


##@ General

help: ##> Show this help message.
	@awk 'BEGIN {FS = ":.*?##> "} /^##@/ { printf("\n\033[1;33m%s\033[0m\n", substr($$0, 5)); next; } /^[a-zA-Z0-9_.-]+:.*?##> / { printf("  \033[36m%-20s\033[0m %s\n", $$1, $$2); }' $(MAKEFILE_LIST)


##@ Environment

# Internal: the models volume is external, so Compose does not create it.
models-volume:
	@docker volume inspect ollama >/dev/null 2>&1 || docker volume create ollama >/dev/null

dev: models-volume ##> Start DEV with hot reload on port 5000 (make dev [GPU=1]).
	@test -z "$$($(CMD_PROD) ps -q)" || { echo "prod is running: run 'make down ENV=prod' first (dev and prod share the models volume and the GPU)." >&2; exit 1; }
	$(CMD_DEV) up --build -d
	@echo "App is running at http://localhost:5000"

prod: models-volume ##> Start PROD locally on port 5001 (make prod [GPU=1]).
	@test -z "$$($(CMD_DEV) ps -q)" || { echo "dev is running: run 'make down' first (dev and prod share the models volume and the GPU)." >&2; exit 1; }
	$(CMD_PROD) up --build -d
	@echo "App is running at http://localhost:5001"

logs: ##> Follow logs (make logs [ENV=prod]).
	$(CMD_ACTIVE) logs -f

shell: ##> Open bash in app (make shell [ENV=prod]).
	$(CMD_ACTIVE) exec app /bin/bash

down: ##> Stop environment (make down [ENV=prod]).
	$(CMD_ACTIVE) down --remove-orphans

down-all: ##> Stop dev and prod.
	$(CMD_DEV) down --remove-orphans
	$(CMD_PROD) down --remove-orphans


##@ Code

format: ##> Fix and format Python files (changes source!).
	scripts/dev/format.sh


##@ Cleanup

clean: ##> Remove reports and caches.
	scripts/dev/clean.sh

reset: ##> Clean + remove containers and prod history (models are kept).
	scripts/dev/clean.sh --volumes

##@ Release

bump: ##> Bump version (make bump PART=patch|minor|major).
	scripts/dev/bump.sh $(PART)

release-plan: ##> Show the tag the current version would release.
	scripts/release/plan.sh

include ci.mk