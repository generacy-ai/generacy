---
sidebar_position: 4
---

# Using Claude Subscription Credits (Max / Pro)

By default, Generacy expects an Anthropic **API key** (`ANTHROPIC_API_KEY`) to authenticate Claude agents. However, if you have a [Claude Max or Pro subscription](https://claude.ai) you can use your OAuth bearer token instead — no separate API key or API credits required. This lets you run Generacy against the same credit pool that backs your claude.ai usage.

:::info macOS + local cluster
The instructions below apply specifically to the **local cluster** setup (cluster-base / cluster-microservices dev containers on macOS). On Linux or in CI, obtain an OAuth token via `claude` CLI login and set `ANTHROPIC_AUTH_TOKEN` directly.
:::

## How it works

Claude's desktop client and CLI store OAuth tokens in the **macOS Keychain** under the service name `claude.ai` and account `oauth:access_token`. Docker containers running the Generacy cluster run as Linux processes and cannot reach the macOS Keychain directly.

The workaround is to extract the token from the Keychain on the host and write it into `.devcontainer/generacy/.env.local` before (or after) starting the cluster. Generacy's worker containers read `ANTHROPIC_AUTH_TOKEN` from `.env.local` at start-up and use it for Claude agent calls.

```
macOS Keychain  →  extract token  →  .env.local  →  Docker worker container
```

## Prerequisites

- macOS with Claude desktop or CLI installed and **signed in** (`claude` → Account → signed in, or `claude login` from CLI)
- Generacy cluster set up via `setup.sh` (see [Local Orchestration](./level-3-local-orchestration.md))
- `.devcontainer/generacy/.env.local` exists in your project

## One-time extraction

Run this command in your project root to pull the current OAuth token from the Keychain and write it to `.env.local`:

```bash
TOKEN=$(security find-generic-password \
  -s "claude.ai" \
  -a "oauth:access_token" \
  -w 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "No OAuth token found. Make sure you are logged in to Claude desktop or CLI."
  exit 1
fi

# Update ANTHROPIC_AUTH_TOKEN in .env.local (adds it if absent)
if grep -q "^ANTHROPIC_AUTH_TOKEN=" .devcontainer/generacy/.env.local; then
  sed -i '' "s|^ANTHROPIC_AUTH_TOKEN=.*|ANTHROPIC_AUTH_TOKEN=${TOKEN}|" \
    .devcontainer/generacy/.env.local
else
  echo "ANTHROPIC_AUTH_TOKEN=${TOKEN}" >> .devcontainer/generacy/.env.local
fi

echo "ANTHROPIC_AUTH_TOKEN updated."
```

Leave `ANTHROPIC_API_KEY` **empty** in `.env.local` so that the cluster falls back to the OAuth token:

```env title=".devcontainer/generacy/.env.local"
# Leave blank to use OAuth token below
CLAUDE_API_KEY=
ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...
```

## Token refresh

OAuth tokens issued by Claude are **short-lived** (typically a few hours). If workers start failing with authentication errors, the token has expired. You can automate the refresh with the helper script below.

### `refresh-token.sh`

Save this script in your project at `.generacy/refresh-token.sh` and make it executable (`chmod +x`):

```bash title=".generacy/refresh-token.sh"
#!/usr/bin/env bash
# Refresh ANTHROPIC_AUTH_TOKEN from macOS Keychain and optionally restart workers.
set -euo pipefail

ENV_LOCAL=".devcontainer/generacy/.env.local"

TOKEN=$(security find-generic-password \
  -s "claude.ai" \
  -a "oauth:access_token" \
  -w 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  echo "ERROR: No OAuth token found. Log in with the Claude desktop app or 'claude login'."
  exit 1
fi

if grep -q "^ANTHROPIC_AUTH_TOKEN=" "$ENV_LOCAL"; then
  sed -i '' "s|^ANTHROPIC_AUTH_TOKEN=.*|ANTHROPIC_AUTH_TOKEN=${TOKEN}|" "$ENV_LOCAL"
else
  echo "ANTHROPIC_AUTH_TOKEN=${TOKEN}" >> "$ENV_LOCAL"
fi

echo "Token refreshed."

# Optionally restart workers to pick up the new token.
if [[ "${1:-}" == "--restart" ]]; then
  COMPOSE_FILE=".devcontainer/generacy/docker-compose.yml"
  ENV_FILE=".devcontainer/generacy/.env"
  ENV_LOCAL_FILE=".devcontainer/generacy/.env.local"
  docker compose -f "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" --env-file "$ENV_LOCAL_FILE" \
    restart worker
  echo "Workers restarted."
fi
```

Run it manually when you need to refresh:

```bash
# Refresh token only
./.generacy/refresh-token.sh

# Refresh and restart workers
./.generacy/refresh-token.sh --restart
```

Or add it to your shell's login profile to refresh automatically each session.

:::caution `~/.claude.json` and multiple containers
The cluster bind-mounts `~/.claude.json` from your host into each container. This file stores Claude CLI preferences, **not** the OAuth bearer token (on macOS the bearer token lives in the Keychain). Running multiple containers with the same bind-mounted file can cause JSON parse errors if containers try to write to it simultaneously.

If you see `SyntaxError: Unexpected token` in worker logs related to `~/.claude.json`, restore the file from a backup or regenerate it by logging out and back in to Claude CLI on the host.
:::

## Environment variable reference

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Standard Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Takes precedence when set. |
| `ANTHROPIC_AUTH_TOKEN` | OAuth bearer token for Claude Max / Pro subscribers. Used when `ANTHROPIC_API_KEY` is empty. Format: `sk-ant-oat01-...` |

Set at most **one** of these. If both are present the API key is used.

## Frequently asked questions

**Can I use my Claude Max credits with the API?**
No. Claude Max and Pro subscriptions grant credits for use via claude.ai and the Claude CLI only. They are not transferable to Anthropic API calls — those require a separate API account with billing. The OAuth token approach described here lets you use those subscription credits within the Generacy local cluster.

**How do I know if the token is working?**
After starting the cluster, watch the worker logs:

```bash
docker compose -f .devcontainer/generacy/docker-compose.yml logs -f worker
```

A successful Claude invocation will log lines like `claude --session-id ...`. An authentication failure will show `401 Unauthorized` or `invalid_api_key`.

**What if `security find-generic-password` returns nothing?**
The token is only present after you have actively used Claude on the machine. Open Claude desktop (or run `claude` in a terminal and perform at least one query) and then retry the extraction command.
