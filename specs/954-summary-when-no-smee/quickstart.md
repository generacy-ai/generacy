# Quickstart: verifying the smee-fallback warning and `/health` field

## Reproduce the pre-fix silence

On a cluster with no smee channel:

```bash
docker logs <cluster>-orchestrator-1 2>&1 | grep -ci smee
# → 0
```

After this feature lands, the same command returns `1` (the warning line).

## What you should see post-fix

### 1. Startup warning (full mode, no smee)

```
{"level":40,"time":"…","pollIntervalMs":30000,"completedCheckInterval":3,"processLatencyMs":30000,"completedLatencyMs":90000,"remediation":["SMEE_CHANNEL_URL","orchestrator.smeeChannelUrl"],"msg":"No smee channel configured; polling fallback active"}
```

At non-default `pollIntervalMs: 60000`:

```
… "pollIntervalMs":60000,"processLatencyMs":60000,"completedLatencyMs":180000 …
```

The invariant `completedLatencyMs === pollIntervalMs × 3` must hold — this is the "computed, not hardcoded" contract.

### 2. Startup info (smee set, webhook auto-setup disabled)

Rarer configuration but worth showing:

```
{"level":30,"time":"…","remediation":["GENERACY_WEBHOOK_SETUP_ENABLED","orchestrator.webhookSetup.enabled"],"msg":"Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos"}
```

Fires only when `smee.channelUrl` is present. When smee is empty, the §1 warning already implies "no webhook will be created".

### 3. `/health` includes `smeeConfigured`

```bash
curl -s http://localhost:3100/health | jq '.smeeConfigured'
# → false   (when config.smee.channelUrl is unset)
# → true    (when config.smee.channelUrl is a URL)
```

Present on both full-mode and worker-mode processes. The field is a configuration statement, not a claim of degradation — a worker returning `false` is not a bug.

## Toggle the branches locally

Point at your orchestrator's config source (env var takes precedence over yaml):

```bash
# Warning ON (polling fallback):
unset SMEE_CHANNEL_URL
docker compose up -d orchestrator

# Warning OFF (webhook real-time):
export SMEE_CHANNEL_URL=https://smee.io/abcdef
docker compose up -d orchestrator

# Info line ON (opt-out):
export SMEE_CHANNEL_URL=https://smee.io/abcdef
export GENERACY_WEBHOOK_SETUP_ENABLED=false     # or omit (default false)
docker compose up -d orchestrator

# Info line OFF (both set, both enabled):
export SMEE_CHANNEL_URL=https://smee.io/abcdef
export GENERACY_WEBHOOK_SETUP_ENABLED=true
docker compose up -d orchestrator
```

## Where the code lives

| behaviour                          | file                                              | line (pre-edit) |
|------------------------------------|---------------------------------------------------|-----------------|
| Warning emit site                  | `packages/orchestrator/src/server.ts`             | ~487 (else on the `if (config.smee.channelUrl)` receiver-construction guard) |
| Info emit site                     | `packages/orchestrator/src/server.ts`             | ~824 (else on the webhook-setup guard, guarded on `!enabled`) |
| `HealthResponse.smeeConfigured`    | `packages/orchestrator/src/types/api.ts`          | 210 |
| Route schema (200 + 503)           | `packages/orchestrator/src/routes/health.ts`      | 66..104 |
| Wire-through worker branch         | `packages/orchestrator/src/server.ts`             | ~669 |
| Wire-through full branch           | `packages/orchestrator/src/server.ts`             | ~702 |
| `COMPLETED_CHECK_INTERVAL = 3`     | `packages/orchestrator/src/services/label-monitor-service.ts` | 83 |

## Troubleshooting

**"I updated the config but `grep -i smee` still returns 0."**

- Verify the process is full-mode (`config.mode === 'full'`, not `'worker'`).
- Verify `config.labelMonitor === true` (else the whole block is skipped — this is a deliberate opt-out, not a degradation, and warning here would be a lie).
- Verify `config.repositories.length > 0` (empty repos is the pre-activation state; warning here would misdirect operators mid-activation).
- Check the Pino log level — the warning is at `warn`, so `LOG_LEVEL=error` will drop it.

**"`smeeConfigured` is missing from my `/health` response."**

- You built against a stale `HealthResponse` type. Rebuild.
- Fastify's response-schema validation stripped it. Check that the 200/503 schema you booted against includes `smeeConfigured: { type: 'boolean' }`.
- You wired `setupHealthRoutes` without passing `smeeConfigured` on the options bag (test harnesses). The field is intentionally omitted when unpopulated rather than defaulting to `false` — see `contracts/health-response.md` §Population.

**"The warning fires with hardcoded 30 000/90 000 even though I set `pollIntervalMs: 60000`."**

- The emit site is reading `config.monitor.pollIntervalMs` (or `monitorConfig.pollIntervalMs` after the smee-override merge). If you see hardcoded values, the field values were literals — this is a regression against `contracts/log-warning.md`.

## Related issues

- **#952** — Auto-provision smee when none is configured. This warning stays relevant even post-#952: provisioning can fail (offline, smee.io down) and fall back to polling; that fallback must be loud.
- **#953** — Adaptive polling never engages for clusters that never had a webhook.
