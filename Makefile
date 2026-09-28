##############################################################################
# OwnDatabase — Makefile
##############################################################################

.PHONY: help up down restart logs migrate migrate-status backup restore test test-e2e test-all test-deps sync-shared \
        ps shell-api shell-db shell-redis clean reset generate-secrets \
        lint format build

# Default target
.DEFAULT_GOAL := help

# ─────────────────────────────────────────────────────────────────────────────
# Environment
# ─────────────────────────────────────────────────────────────────────────────

# Load .env if it exists
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

COMPOSE := docker compose
PROJECT := owndatabase

# ─────────────────────────────────────────────────────────────────────────────
# HELP
# ─────────────────────────────────────────────────────────────────────────────

help: ## Show this help message
	@echo ""
	@echo "  OwnDatabase — Development Commands"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf ""} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CORE
# ─────────────────────────────────────────────────────────────────────────────

up: check-env ## Start all services
	@echo "→ Starting OwnDatabase services..."
	$(COMPOSE) up -d
	@echo ""
	@echo "✓ Services started."
	@echo ""
	@echo "  Dashboard:  http://localhost"
	@echo "  API:        http://localhost/api"
	@echo "  Auth:       http://localhost/auth"
	@echo "  Storage:    http://localhost/storage"
	@echo "  Grafana:    http://localhost/grafana"
	@echo ""

down: ## Stop all services
	@echo "→ Stopping OwnDatabase services..."
	$(COMPOSE) down
	@echo "✓ All services stopped."

restart: ## Restart all services
	$(COMPOSE) restart

restart-api: ## Restart only the API service
	$(COMPOSE) restart control-api api-service auth-service

logs: ## Stream logs from all services
	$(COMPOSE) logs -f --tail=100

logs-api: ## Stream control API logs
	$(COMPOSE) logs -f --tail=100 control-api

logs-db: ## Stream PostgreSQL logs
	$(COMPOSE) logs -f --tail=100 postgres

logs-auth: ## Stream auth service logs
	$(COMPOSE) logs -f --tail=100 auth-service

ps: ## Show service status
	$(COMPOSE) ps

build: ## Build all custom Docker images
	@echo "→ Building Docker images..."
	$(COMPOSE) build --no-cache
	@echo "✓ Images built."

# ─────────────────────────────────────────────────────────────────────────────
# DATABASE
# ─────────────────────────────────────────────────────────────────────────────

migrate: ## Run all pending database migrations (also run automatically on control-api start)
	@echo "→ Running migrations..."
	$(COMPOSE) exec control-api npx tsx src/cli/migrate.ts up

migrate-status: ## Show which migrations are applied
	$(COMPOSE) exec control-api npx tsx src/cli/migrate.ts status

# ─────────────────────────────────────────────────────────────────────────────
# BACKUPS
# ─────────────────────────────────────────────────────────────────────────────

backup: ## Create a manual database backup (pg_dump)
	@echo "→ Creating database backup..."
	@mkdir -p ./backups
	$(COMPOSE) exec -T postgres pg_dump \
		-U $(POSTGRES_USER) \
		-d $(POSTGRES_DB) \
		--no-owner \
		--no-acl \
		-Fc \
		> ./backups/backup_$(shell date +%Y%m%d_%H%M%S).dump
	@echo "✓ Backup saved to ./backups/"

restore: ## Restore a database backup (usage: make restore FILE=./backups/backup.dump)
	@if [ -z "$(FILE)" ]; then echo "ERROR: Specify FILE= for restore. Example: make restore FILE=./backups/backup.dump"; exit 1; fi
	@echo "→ Restoring from $(FILE)..."
	@echo "WARNING: This will overwrite the current database. Press Ctrl+C to cancel."
	@sleep 5
	$(COMPOSE) exec -T postgres pg_restore \
		-U $(POSTGRES_USER) \
		-d $(POSTGRES_DB) \
		--no-owner \
		--no-acl \
		-c \
		< $(FILE)
	@echo "✓ Restore complete."

# ─────────────────────────────────────────────────────────────────────────────
# TESTING
# ─────────────────────────────────────────────────────────────────────────────

test: ## Run the pytest API suite against a running stack (make up first)
	python -m pytest tests -m "not e2e"

test-e2e: ## Run the Playwright dashboard tests (needs: pip install -r tests/requirements.txt && playwright install chromium)
	python -m pytest tests/e2e

test-all: ## Run every test (API + Playwright)
	python -m pytest tests

test-deps: ## Install Python test dependencies
	pip install -r tests/requirements.txt
	python -m playwright install chromium

sync-shared: ## Copy platform/shared/*.ts into each data-plane service
	bash scripts/sync-shared.sh

# ─────────────────────────────────────────────────────────────────────────────
# SHELL ACCESS
# ─────────────────────────────────────────────────────────────────────────────

shell-api: ## Open shell in control API container
	$(COMPOSE) exec control-api sh

shell-db: ## Open psql session
	$(COMPOSE) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

shell-redis: ## Open redis-cli session
	$(COMPOSE) exec redis redis-cli -a $(REDIS_PASSWORD)

shell-storage: ## Open shell in the SeaweedFS (S3) container
	$(COMPOSE) exec minio sh

# ─────────────────────────────────────────────────────────────────────────────
# CODE QUALITY
# ─────────────────────────────────────────────────────────────────────────────

lint: ## Run ESLint on all packages
	$(COMPOSE) exec control-api npm run lint
	$(COMPOSE) exec dashboard npm run lint
	$(COMPOSE) exec auth-service npm run lint
	$(COMPOSE) exec api-service npm run lint
	$(COMPOSE) exec storage-api npm run lint

format: ## Run Prettier on all packages
	$(COMPOSE) exec control-api npm run format
	$(COMPOSE) exec dashboard npm run format

# ─────────────────────────────────────────────────────────────────────────────
# SETUP
# ─────────────────────────────────────────────────────────────────────────────

check-env: ## Check required environment variables
	@if [ ! -f ".env" ]; then \
		echo "ERROR: .env file not found."; \
		echo "Copy .env.example to .env and fill in required values."; \
		echo "  cp .env.example .env"; \
		exit 1; \
	fi

generate-secrets: ## Generate random secrets for .env
	@echo ""
	@echo "Generated secrets (copy to .env):"
	@echo ""
	@echo "POSTGRES_PASSWORD=$(shell openssl rand -hex 24)"
	@echo "REDIS_PASSWORD=$(shell openssl rand -hex 24)"
	@echo "JWT_SECRET=$(shell openssl rand -hex 32)"
	@echo "SECRET_ENCRYPTION_KEY=$(shell openssl rand -hex 32)"
	@echo "GRAFANA_PASSWORD=$(shell openssl rand -hex 12)"
	@echo "MINIO_ROOT_PASSWORD=$(shell openssl rand -hex 16)"
	@echo ""

init: ## Initialize project (copy env, install deps)
	@echo "→ Initializing OwnDatabase..."
	@if [ ! -f ".env" ]; then cp .env.example .env; echo "✓ Created .env from .env.example"; fi
	@echo ""
	@echo "IMPORTANT: Edit .env and set your passwords before running 'make up'"
	@echo "Run 'make generate-secrets' to generate random secrets."
	@echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CLEANUP
# ─────────────────────────────────────────────────────────────────────────────

clean: ## Stop services and remove containers (preserves volumes)
	$(COMPOSE) down --remove-orphans

reset: ## DANGER: Stop services and remove ALL data volumes
	@echo "WARNING: This will delete all data. Press Ctrl+C to cancel."
	@sleep 5
	$(COMPOSE) down -v --remove-orphans
	@echo "✓ All data removed."
