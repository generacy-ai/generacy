#!/bin/bash
# setup-credentials.sh — Configure GitHub and Anthropic credentials
# Sourced by entrypoint-orchestrator.sh and entrypoint-worker.sh
set -e

# ── GitHub Token ──────────────────────────────────────────────────────
# Accept GITHUB_TOKEN or GH_TOKEN (GitHub CLI convention)
export GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"

if [ -n "${GITHUB_TOKEN}" ]; then
  echo "[credentials] Configuring GitHub authentication..."

  # Authenticate GitHub CLI
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true

  # Configure git to use the token for HTTPS clones
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
else
  echo "[credentials] WARNING: No GITHUB_TOKEN or GH_TOKEN set — GitHub operations may fail"
fi

# ── Anthropic API Key ─────────────────────────────────────────────────
# Accept ANTHROPIC_API_KEY or CLAUDE_API_KEY
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$CLAUDE_API_KEY}"

if [ -n "${ANTHROPIC_API_KEY}" ]; then
  echo "[credentials] Anthropic API key configured"
else
  echo "[credentials] WARNING: No ANTHROPIC_API_KEY or CLAUDE_API_KEY set — Claude operations may fail"
fi
