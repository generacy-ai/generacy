#!/bin/bash
set -e

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Credentials ────────────────────────────────────────────────────────
source "${SCRIPTS_DIR}/setup-credentials.sh"

# ── Docker-in-Docker (microservices variant only) ─────────────────────
if [ "${ENABLE_DIND}" = "true" ]; then
  echo "[worker] Enabling Docker-in-Docker..."
  source "${SCRIPTS_DIR}/setup-docker-dind.sh"
fi

# ── Start worker ──────────────────────────────────────────────────────
echo "[worker] Connecting to orchestrator at ${ORCHESTRATOR_URL:-http://orchestrator:3100}..."
exec generacy work \
  --orchestrator "${ORCHESTRATOR_URL:-http://orchestrator:3100}" \
  --redis "${REDIS_URL:-redis://redis:6379}" \
  --health-port "${HEALTH_PORT:-9001}"
