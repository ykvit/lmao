SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --no-print-directory
.NOTPARALLEL:
.DEFAULT_GOAL := help

export UID := $(shell id -u)
export GID := $(shell id -g)

COMPOSE_GPU := $(if $(filter 1,$(GPU)),-f compose.gpu.yaml)
CMD_DEV     := docker compose -f compose.base.yaml -f compose.dev.yaml $(COMPOSE_GPU)
CMD_PROD    := docker compose -f compose.base.yaml -f compose.prod.yaml $(COMPOSE_GPU)
CMD_ACTIVE  := $(if $(filter prod,$(ENV)),$(CMD_PROD),$(CMD_DEV))

.PHONY: help setup dev prod logs shell down down-all format clean reset


##@ General

help: ##> Show this help message.
	@awk 'BEGIN {FS = ":.*?##> "} /^##@/ { printf("\n\033[1;33m%s\033[0m\n", substr($$0, 5)); next; } /^[a-zA-Z0-9_.-]+:.*?##> / { printf("  \033[36m%-20s\033[0m %s\n", $$1, $$2); }' $(MAKEFILE_LIST)


##@ Environment

# Internal: dev and prod call it automatically.
setup:
	@docker volume create ollama >/dev/null

dev: setup ##> Start DEV with hot reload (make dev [GPU=1]).
	$(CMD_DEV) up --build -d
	@echo "App is running at http://localhost:5000"

prod: setup ##> Start PROD locally (make prod [GPU=1]).
	$(CMD_PROD) up --build -d
	@echo "App is running at http://localhost:5000"

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

format: build-dev ##> Fix and format Python files (changes source!).
	scripts/dev/format.sh


##@ Cleanup

clean: ##> Remove reports and caches.
	scripts/dev/clean.sh

reset: ##> Clean + remove containers and volumes (deletes history!).
	scripts/dev/clean.sh --volumes


include ci.mk