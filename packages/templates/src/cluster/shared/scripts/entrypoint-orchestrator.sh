#!/bin/bash
set -e

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Credentials ────────────────────────────────────────────────────────
source "${SCRIPTS_DIR}/setup-credentials.sh"

# ── Clone / update workspace ──────────────────────────────────────────
REPO_DIR="/workspaces/$(basename "${REPO_URL:?REPO_URL is required}" .git)"

if [ ! -d "${REPO_DIR}/.git" ]; then
  echo "[orchestrator] Cloning ${REPO_URL} (branch: ${REPO_BRANCH:-main})..."
  git clone --branch "${REPO_BRANCH:-main}" "${REPO_URL}" "${REPO_DIR}"
else
  echo "[orchestrator] Repository already cloned at ${REPO_DIR}"
fi

cd "${REPO_DIR}"

# ── Install dependencies ─────────────────────────────────────────────
if [ -f "package.json" ]; then
  echo "[orchestrator] Installing dependencies..."
  if command -v pnpm &>/dev/null; then
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  elif [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi
fi

# ── Start orchestrator ────────────────────────────────────────────────
echo "[orchestrator] Starting on port ${ORCHESTRATOR_PORT:-3100}..."
exec generacy orchestrate \
  --port "${ORCHESTRATOR_PORT:-3100}" \
  --workers "${WORKER_COUNT:-3}" \
  --redis "${REDIS_URL:-redis://redis:6379}"
