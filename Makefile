# ═══════════════════════════════════════════════
#  Kaspi POS Automation — Makefile
# ═══════════════════════════════════════════════

.PHONY: help install start dev stop restart logs db-up db-down db-logs \
        db-shell lint format test regen-keypair regen-device \
        docker-up docker-down docker-build docker-logs docker-shell env-check

# Default target — show help
.DEFAULT_GOAL := help

# ─── Colors ───
CYAN  = \033[0;36m
GREEN = \033[0;32m
YELLOW= \033[0;33m
RED   = \033[0;31m
RESET = \033[0m

help: ## Show this help message
	@echo ""
	@echo "  $(CYAN)Kaspi POS Automation$(RESET)"
	@echo ""
	@echo "  $(GREEN)Usage:$(RESET) make <command>"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "  $(CYAN)%-20s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""

# ─── Setup ───

install: ## Install Node.js dependencies
	@echo "$(GREEN)Installing dependencies...$(RESET)"
	npm install

env-check: ## Check if .env file exists (copy from .env.example if missing)
	@if [ ! -f .env ]; then \
		echo "$(YELLOW)⚠️  .env not found. Copying from .env.example...$(RESET)"; \
		cp .env.example .env; \
		echo "$(RED)❗ Please fill in TOKEN_SECRET_KEY and ADMIN_SECRET_KEY in .env$(RESET)"; \
	else \
		echo "$(GREEN)✅ .env file found.$(RESET)"; \
	fi

# ─── Development ───

start: ## Start the server (production mode)
	@echo "$(GREEN)Starting server...$(RESET)"
	npm start

dev: db-up ## Start DB + server for local development
	@echo "$(GREEN)Starting server in dev mode...$(RESET)"
	npm start

stop: ## Stop all Docker containers (DB + web)
	@echo "$(YELLOW)Stopping all containers...$(RESET)"
	docker compose stop
	@echo "$(GREEN)✅ All containers stopped.$(RESET)"

# ─── Database (local Docker only) ───

db-up: ## Start only the PostgreSQL container
	@echo "$(GREEN)Starting PostgreSQL...$(RESET)"
	docker compose up -d db
	@echo "$(GREEN)✅ Database is up on port 5434$(RESET)"

db-down: ## Stop the PostgreSQL container
	@echo "$(YELLOW)Stopping PostgreSQL...$(RESET)"
	docker compose stop db

db-logs: ## Show PostgreSQL container logs
	docker compose logs -f db

db-shell: ## Open a psql shell inside the PostgreSQL container
	@echo "$(CYAN)Connecting to psql...$(RESET)"
	docker compose exec db psql -U postgres -d kaspi_gateway

restart: ## Restart the PostgreSQL container
	@echo "$(YELLOW)Restarting PostgreSQL...$(RESET)"
	docker compose restart db
	@echo "$(GREEN)✅ Restarted.$(RESET)"

# ─── Full Docker Stack ───

docker-up: ## Start the full stack (DB + app) with Docker Compose
	@echo "$(GREEN)Starting full Docker stack...$(RESET)"
	docker compose up -d
	@echo "$(GREEN)✅ App running at http://localhost:3000$(RESET)"
	@echo "$(GREEN)✅ Swagger at http://localhost:3000/api-docs$(RESET)"

docker-down: ## Stop and remove all Docker containers
	@echo "$(YELLOW)Stopping Docker stack...$(RESET)"
	docker compose down

docker-build: ## Rebuild the Docker image for the app
	@echo "$(GREEN)Building Docker image...$(RESET)"
	docker compose build web

docker-logs: ## Stream logs from the Docker app container
	docker compose logs -f web

docker-shell: ## Open a shell inside the running app container
	docker compose exec web sh

# ─── Code Quality ───

lint: ## Run ESLint
	@echo "$(CYAN)Running ESLint...$(RESET)"
	npm run lint

format: ## Run Prettier formatter
	@echo "$(CYAN)Running Prettier...$(RESET)"
	npm run format

test: ## Run all tests
	@echo "$(CYAN)Running tests...$(RESET)"
	npm test

# ─── Key Management ───

regen-keypair: ## Regenerate ECDH keypair (⚠️ invalidates all sessions)
	@echo "$(RED)⚠️  This will invalidate all active cashier sessions!$(RESET)"
	@read -p "Continue? [y/N] " confirm; \
	if [ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ]; then \
		npm run regen:keypair; \
		echo "$(GREEN)✅ Keypair regenerated.$(RESET)"; \
	else \
		echo "$(YELLOW)Cancelled.$(RESET)"; \
	fi

regen-device: ## Regenerate device fingerprint (⚠️ invalidates all sessions)
	@echo "$(RED)⚠️  This will invalidate all active cashier sessions!$(RESET)"
	@read -p "Continue? [y/N] " confirm; \
	if [ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ]; then \
		npm run regen:device; \
		echo "$(GREEN)✅ Device regenerated.$(RESET)"; \
	else \
		echo "$(YELLOW)Cancelled.$(RESET)"; \
	fi

# ─── Quick Info ───

urls: ## Print all useful local URLs
	@echo ""
	@echo "  $(CYAN)Local URLs:$(RESET)"
	@echo "  $(GREEN)App:$(RESET)     http://localhost:3000"
	@echo "  $(GREEN)Swagger:$(RESET) http://localhost:3000/api-docs"
	@echo "  $(GREEN)Connect:$(RESET) http://localhost:3000/connect.html"
	@echo "  $(GREEN)Health:$(RESET)  http://localhost:3000/health"
	@echo ""
