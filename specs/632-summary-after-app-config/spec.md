# Feature Specification: App-Config Secrets Env Renderer

**Branch**: `632-summary-after-app-config` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

App-config secrets entered via the UI are stored in the encrypted `ClusterLocalBackend` (`credentials.dat`) but never materialized as env vars for running processes. Non-secret env vars correctly land in `/var/lib/generacy-app-config/env`, but secrets are only accessible through the credhelper per-session render flow — unusable by long-running user services (e.g., a LiveKit voice agent) that need stable env-var availability from startup.

**Fix**: The control-plane daemon renders a derived `secrets.env` file on tmpfs from the encrypted backend at boot and on every secret mutation, making secrets consumable via `env_file:` / `source` just like non-secrets.

## User Stories

### US1: Long-Running Service Operator

**As a** cluster user running a compose'd service (e.g., LiveKit voice agent),
**I want** secret env vars configured via the app-config UI to be available as process env vars,
**So that** my services can consume API keys and tokens without relying on per-session credhelper flows.

**Acceptance Criteria**:
- [ ] After entering `SERVICE_ANTHROPIC_API_KEY` (secret) in the UI, the value is available at `/run/generacy-app-config/secrets.env`
- [ ] Sourcing the file (`set -a; source secrets.env`) makes the key available to child processes
- [ ] The file is re-rendered from the encrypted backend on every daemon restart (no persistence on disk)

### US2: Cluster Administrator

**As a** cluster administrator,
**I want** plaintext secrets to exist only in volatile memory (tmpfs),
**So that** the encrypted-at-rest security model is preserved.

**Acceptance Criteria**:
- [ ] `secrets.env` lives on tmpfs (`/run/`), not the persistent volume
- [ ] File mode is `0640`, owned by `node:node`
- [ ] Container teardown wipes the file (tmpfs semantics)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | New file at `/run/generacy-app-config/secrets.env`, tmpfs-backed, mode `0640` | P1 | Plaintext in memory only |
| FR-002 | At daemon startup, after `ClusterLocalBackend.init()`, walk `values.yaml` for `secret: true` entries, decrypt each, write combined file atomically | P1 | Temp + rename + fd-based lock |
| FR-003 | On `PUT /app-config/env` with `secret: true`, update `secrets.env` atomically | P1 | Same mechanism as `AppConfigEnvStore` |
| FR-004 | On `DELETE /app-config/env/:name` for a secret entry, remove from `secrets.env` | P1 | |
| FR-005 | Non-secret PUT/DELETE operations must NOT touch `secrets.env` | P1 | Correctness invariant |
| FR-006 | File format: bare `KEY="escaped-value"\n` lines, compatible with `env_file:` / `source` | P1 | Same format as existing `env` file |
| FR-007 | Partial unseal failures write partial file + log warning (fail-forward) | P2 | Mirrors wizard-env-writer pattern |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Secret availability | 100% of `secret: true` entries in `values.yaml` appear in `secrets.env` | Unit test: startup rendering |
| SC-002 | Atomic writes | Zero partial-read races | Unit test: temp+rename pattern verified |
| SC-003 | No disk persistence | `secrets.env` on tmpfs only | Manual: verify mount point |
| SC-004 | Format compatibility | File is source-able by bash and docker `env_file:` | Manual: `set -a; source secrets.env` |

## Architecture

### File Layout

```
/run/generacy-app-config/          # tmpfs mount (companion cluster-base issue)
  secrets.env                       # rendered secret env vars (mode 0640)

/var/lib/generacy-app-config/       # persistent volume (existing)
  env                               # non-secret env vars (existing)
  values.yaml                       # metadata for all entries (existing)
```

### Data Flow

1. **Boot path**: daemon starts -> `ClusterLocalBackend.init()` -> read `values.yaml` -> filter `secret: true` -> `fetchSecret()` each -> atomic write `secrets.env`
2. **PUT path**: `PUT /app-config/env` with `secret: true` -> store in encrypted backend -> update `values.yaml` -> atomic rewrite `secrets.env`
3. **DELETE path**: `DELETE /app-config/env/:name` for secret -> remove from encrypted backend -> update `values.yaml` -> atomic rewrite `secrets.env`

### Security Model

- Encrypted backend (`credentials.dat`) remains the source of truth
- `secrets.env` is a derived, volatile view — exists in memory only
- Same trade-off documented in #622: plaintext on tmpfs readable by workflow uid
- Alternative rejected: mixing secrets into existing `env` file (puts plaintext on persistent volume)

## Assumptions

- `ClusterLocalBackend` is initialized and unsealed before secrets rendering runs
- `values.yaml` metadata reliably tracks which entries are `secret: true`
- Companion cluster-base/cluster-microservices issue provides the tmpfs mount at `/run/generacy-app-config/`
- Entrypoint scripts in cluster-base source both env files (`env` and `secrets.env`)

## Out of Scope

- Merging secrets into the existing non-secret `env` file (rejected trade-off)
- Cloud-side changes (UI already handles secret flag correctly)
- Cluster-base/cluster-microservices tmpfs mount (companion issue: cluster-base#38)
- Post-bootstrap credential edit cache reload for credhelper-daemon

## Test Plan

- [ ] Unit: at daemon startup with secrets in the backend, `/run/generacy-app-config/secrets.env` is rendered with all secret entries
- [ ] Unit: on `PUT /app-config/env` with `secret: true`, the secrets file is updated atomically
- [ ] Unit: on `DELETE` of a secret, the entry is removed from the secrets file
- [ ] Unit: non-secret PUTs do NOT touch the secrets file
- [ ] Integration: after a fresh boot of a previously-configured cluster, the secrets file is re-rendered from the encrypted backend without any user action
- [ ] Manual: on a cluster where the user filled `SERVICE_ANTHROPIC_API_KEY` via the UI, `sh -c 'set -a; source /run/generacy-app-config/secrets.env; env | grep SERVICE_ANTHROPIC'` shows the value

## Related

- generacy-ai/generacy#622 — original app-config feature; introduced encrypted-backend path for secrets but didn't render them
- generacy-ai/generacy-cloud#583 — UI side
- Companion: generacy-ai/cluster-base#38 (and cluster-microservices via sync) — adds tmpfs mount and sources both env files from entrypoint scripts
- Reported during app-config testing on 2026-05-15

---

*Generated by speckit*
