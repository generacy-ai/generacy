# Quickstart: Validating the GH_TOKEN Expiry Backstop

**Issue**: [generacy-ai/generacy#762](https://github.com/generacy-ai/generacy/issues/762)
**Branch**: `762-summary-when-cluster-s`
**Status**: Complete

This guide explains how to verify the cluster-side detection/observability work locally and how an operator should expect to observe the feature in production.

## Prerequisites

- Repo cloned at `/workspaces/generacy`.
- Tooling: Node.js >=22, pnpm, `gh` CLI installed in PATH for integration validation.
- A cluster running locally (devcontainer / `pnpm dev` for the orchestrator package, or a `cluster-base` image launched via `generacy launch`).
- For end-to-end validation: a real GitHub App credential sealed via the bootstrap wizard so `.agency/credentials.yaml` and `/var/lib/generacy/wizard-credentials.env` are populated.

## Install / build

```bash
cd /workspaces/generacy
pnpm install
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/workflow-engine build
```

## Run unit tests

The new tests are scoped — fast and runnable without a cluster.

```bash
pnpm --filter @generacy-ai/orchestrator test -- github-auth-health
pnpm --filter @generacy-ai/orchestrator test -- credential-expiry-watcher
pnpm --filter @generacy-ai/orchestrator test -- label-monitor-service.401
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-monitor-service.401
pnpm --filter @generacy-ai/workflow-engine test -- gh-cli.401-parsing
```

Or run the full orchestrator + workflow-engine suites:

```bash
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/workflow-engine test
```

## Inspect `/health`

With the orchestrator running:

```bash
curl -s http://localhost:3100/health | jq .githubAuth
```

Expected shapes:

- Before any monitor call:
  ```json
  { "status": "unknown", "consecutiveFailures": 0 }
  ```
- Healthy steady state:
  ```json
  {
    "status": "ok",
    "consecutiveFailures": 0,
    "lastSuccessAt": "2026-06-05T02:00:00.000Z",
    "credentialId": "primary-github-app",
    "expiresAt": "2026-06-05T03:00:00.000Z"
  }
  ```
- Auth failing:
  ```json
  {
    "status": "failing",
    "consecutiveFailures": 3,
    "lastSuccessAt": "2026-06-05T01:30:00.000Z",
    "credentialId": "primary-github-app",
    "expiresAt": "2026-06-05T02:30:00.000Z"
  }
  ```

## Synthetic auth-failure validation (SC-001, SC-002, SC-004)

1. Confirm `/health.githubAuth.status === 'ok'`.
2. Corrupt the `GH_TOKEN` in `/var/lib/generacy/wizard-credentials.env` (root + restart the orchestrator, OR push a bad token via the bootstrap UI in dev mode):
   ```bash
   sudo sed -i 's/^GH_TOKEN=.*/GH_TOKEN=ghu_INVALID/' /var/lib/generacy/wizard-credentials.env
   ```
3. Wait up to one monitor poll cycle (30–60s) plus the watcher tick (60s).
4. Verify in orchestrator logs at default level (no `DEBUG=1`):
   - One `warn` line: `GitHub authentication failing — investigate credential refresh chain` with `credentialId`, `statusCode: 401`.
   - For each subsequent 401, **no** new `warn` lines (state-stable; SC-002).
5. Verify `/health`:
   ```bash
   curl -s http://localhost:3100/health | jq '.githubAuth | { status, consecutiveFailures }'
   # → { "status": "failing", "consecutiveFailures": N }
   ```
6. Verify the cloud receives at most one `auth-failed` event per credential per transition and at most one `refresh-requested` per 60s. Inspect the cluster relay's outbound trace (if dev mode) or the cloud's `cluster.credentials` consumer log.

## Synthetic recovery validation (SC-003 detection half)

1. With `status: 'failing'`, restore the valid token:
   ```bash
   sudo cp /tmp/good-wizard-credentials.env /var/lib/generacy/wizard-credentials.env  # or push a fresh token through the bootstrap UI
   ```
2. Within one monitor poll cycle, `wizard-creds-token-provider.ts` picks up the new mtime, monitors succeed, and:
   - One `info` line: `GitHub authentication recovered` with `recoveredAfterFailures`.
   - `/health.githubAuth.status` flips back to `ok`.
   - One `auth-recovered` event emitted on `cluster.credentials`.

The cloud-side push of a fresh token in response to `refresh-requested` is the **companion ticket** — not validated by this quickstart. Until that ships, only manual token replacement closes the loop.

## Proactive near-expiry validation

1. Fake `expiresAt` in `.agency/credentials.yaml`:
   ```yaml
   credentials:
     primary-github-app:
       type: github-app
       expiresAt: "2026-06-05T02:30:00.000Z"  # set to ~4 min from now
   ```
2. Wait up to 60s.
3. Confirm one `warn` line: `GitHub token near expiry — requesting refresh from cloud` with `secondsRemaining < 300`.
4. Confirm one `refresh-requested` event with `reason: 'near-expiry'` on `cluster.credentials`.
5. Stay below threshold for 5 minutes: confirm at most 5 events were emitted (1 per 60s, SC-004).

## Available developer commands

```bash
# Run the orchestrator locally with verbose logging
LOG_LEVEL=debug pnpm --filter @generacy-ai/orchestrator dev

# Trigger a poll cycle manually (existing dev endpoint, if enabled)
curl -X POST http://localhost:3100/internal/label-monitor/poll

# Inspect emitted relay events in dev (tail orchestrator stdout for 'event' messages)
pnpm --filter @generacy-ai/orchestrator dev | grep -E 'cluster\.credentials|GitHub auth'
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/health.githubAuth` missing from response | Code built but server didn't restart | `pnpm --filter @generacy-ai/orchestrator build && restart` |
| `/health.githubAuth.status === 'unknown'` forever | No monitor has executed yet, or no repositories configured | Confirm `config.repositories` is non-empty; check `LabelMonitorService` is started |
| `auth-failed` event never emitted on the cloud | Relay not connected, or `cluster.credentials` not in `ALLOWED_CHANNELS` | Confirm relay is connected via `/health.relay` (or equivalent); confirm `internal-relay-events.ts:5` lists the channel |
| Refresh requests emitted faster than 60s | Rate-limit clock isn't shared across credentials | Confirm the rate-limit `Map` keys by `credentialId` not by reason |
| `auth-recovered` not emitted after token swap | mtime cache in `wizard-creds-token-provider.ts` not invalidating | Check the new file's mtime moved forward; remember the env file is written by control-plane, not by the orchestrator |
| Distinct 401 log line not appearing in default logs | `parseGhStatusCode` returning `undefined` for the actual stderr format `gh` is producing | Run `GH_TOKEN=fake gh repo view <owner>/<repo>` once and add a fixture for the observed stderr |

## Related

- Cloud refresh-chain bug: `generacy-ai/generacy-cloud#813`
- Cloud-side consumer for `action: 'refresh-requested'`: separate companion ticket to be filed per Q2 answer B.
- Source paths touched: see [plan.md](./plan.md) "Project Structure" section.
