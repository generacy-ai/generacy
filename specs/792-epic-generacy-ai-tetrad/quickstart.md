# Quickstart: Cockpit Orchestrator Tier

## Prerequisites

- Cockpit installed and `generacy cockpit status` already works against your GitHub setup.
- A running orchestrator on the same host (`http://127.0.0.1:3100`).
- An orchestrator API token. The cluster issues these on activation; you can read it from your container or set it manually for local dev.

## 1. Token setup (FR-008, Q3 → A)

Two ways to provide the token. **The env var always wins.**

### Option 1 — env var (recommended)

```bash
export ORCHESTRATOR_API_TOKEN=<paste-token>
generacy cockpit status
```

The token is read fresh on every invocation. Rotate it by re-exporting before the next call. `watch` reads the token once at startup — restart `watch` after rotation.

### Option 2 — cockpit config (fallback)

In your cockpit config:

```yaml
orchestrator:
  baseUrl: http://127.0.0.1:3100   # default; override if not local
  token: <paste-token>
```

If both are set, the env var wins.

## 2. One-shot status

```bash
generacy cockpit status --epic owner/repo#42
```

Last line of the output:

```
... existing issue/PR table ...
orchestrator: 7 jobs, 2 active workers
```

If the orchestrator is unreachable, the footer becomes one of:

- `orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)`
- `orchestrator: (unavailable — cloud-unreachable)`
- `orchestrator: (unavailable — timeout)` (orchestrator hung > 1500 ms)
- `orchestrator: (unavailable — http-error)` (e.g. wrong token → 401)

Exit code is **always 0** for orchestrator-related conditions. Operators see one short warning on stderr the first time the orchestrator fails per invocation; subsequent failures are silent.

## 3. JSON envelope

```bash
generacy cockpit status --epic owner/repo#42 --json | jq .orchestrator
```

```json
{ "available": true, "jobs": 7, "workers": 2 }
```

Or when unavailable:

```json
{ "available": false, "reason": "cloud-unreachable" }
```

## 4. Streaming watch (NDJSON)

```bash
generacy cockpit watch --epic owner/repo#42
```

Existing GH transition events (`label-change`, `pr-checks`, etc.) flow as before. A new event type appears:

```jsonc
// at startup (baseline)
{"type":"orchestrator-counts","jobs":7,"workers":2}

// ...only emitted again when jobs OR workers changes
{"type":"orchestrator-counts","jobs":8,"workers":2}
{"type":"orchestrator-counts","jobs":8,"workers":3}
```

If the orchestrator is unreachable:

```jsonc
{"type":"orchestrator-counts","available":false,"reason":"cloud-unreachable"}
```

Once an unreachable line is emitted, the next line is only emitted on a real state transition (back to reachable, or a different reason). The GH poll loop continues uninterrupted regardless of orchestrator state.

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Footer reads `(no token; set ORCHESTRATOR_API_TOKEN to enable)` | Neither env var nor config has the token | `export ORCHESTRATOR_API_TOKEN=...` or set `orchestrator.token` in cockpit config |
| Footer reads `(unavailable — http-error)` | Token rejected (401/403), or wrong path/route | Verify token; verify `cockpit.config.orchestrator.baseUrl` matches the running orchestrator |
| Footer reads `(unavailable — cloud-unreachable)` | Orchestrator not running on configured `baseUrl` | `docker compose ps`; check orchestrator port (default 3100) |
| Footer reads `(unavailable — timeout)` | Orchestrator running but a request took > 1500 ms | Check orchestrator load; persistent timeouts may indicate queue or DB pressure |
| `status --json` always shows `workers: 0` even when work is running | You are on a pre-#792 build with the latent always-`0` bug | Upgrade to a build that includes this change (consumes `{count}` from `/dispatch/queue/workers`) |
| stderr printed an unavailable warning but the next failures are silent | Working as designed (FR-013) | One warning per invocation; subsequent failures in the same `status`/`watch` invocation are suppressed |

## 6. What this tier does **not** do

- Does not write to the orchestrator (read-only).
- Does not surface per-job or per-worker detail — counts only.
- Does not discover tokens from cloud-managed clusters / installation tokens.
- Does not stream from `/events` (SSE) — `status` is one-shot; `watch` polls.
- Does not add color to the footer line (plain ASCII).
