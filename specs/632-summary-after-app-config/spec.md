# Feature Specification: ## Summary

After the app-config UI flow (generacy-ai/generacy#622, generacy-ai/generacy-cloud#583) shipped, non-secret env vars do get written to `/var/lib/generacy-app-config/env` correctly — but secret env vars only land in the encrypted `ClusterLocalBackend`

**Branch**: `632-summary-after-app-config` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

## Summary

After the app-config UI flow (generacy-ai/generacy#622, generacy-ai/generacy-cloud#583) shipped, non-secret env vars do get written to `/var/lib/generacy-app-config/env` correctly — but secret env vars only land in the encrypted `ClusterLocalBackend`. **Nothing renders them back into a form that a running process can consume.** A user who fills `SERVICE_ANTHROPIC_API_KEY` (secret) and `LIVEKIT_URL` (non-secret) in the UI ends up with the latter as a usable env var but the former effectively unreachable.

Verified on a freshly-bootstrapped staging cluster:

```
$ docker exec <orchestrator> ls /var/lib/generacy-app-config/
env             # contains: LIVEKIT_URL="..."
values.yaml     # records all three (including secrets) — metadata only, no values

$ docker exec <orchestrator> cat /var/lib/generacy-app-config/env
LIVEKIT_URL="wss://..."
# (no SERVICE_ANTHROPIC_API_KEY, no TWILIO_AUTH_TOKEN)
```

The encrypted backend (`credentials.dat`) has the values but exposes them only via the credhelper's per-workflow-session render flow. Long-running user services (the canonical motivating example: a LiveKit voice agent compose'd into the cluster) need stable env-var availability from the moment they start, not per-session-only.

## Scope

Render app-config secrets to a sibling env file at boot and on every PUT, so they're consumable by processes that source it the same way they source the non-secret file.

### Proposed shape

- New file: `/run/generacy-app-config/secrets.env` (tmpfs, NOT the persistent volume), mode `0640`, owned by `node:node`. Tmpfs because plaintext secrets shouldn't persist to disk — they re-render from the encrypted backend on every boot.
- Format: same as `/var/lib/generacy-app-config/env` — bare `KEY="escaped-value"\n` lines compatible with `env_file:` / `source`.
- Lifecycle:
  - At control-plane daemon startup, after `ClusterLocalBackend` is unsealed, walk `values.yaml.env` for entries where `secret: true`, decrypt each, write the combined file atomically (temp + rename, fd-based lock).
  - On `PUT /app-config/env` with `secret: true`, also update the secrets file via the same atomic-rewrite mechanism `AppConfigEnvStore` already uses.
  - On `DELETE /app-config/env/:name` for a secret, remove from the secrets file.
- A docker-compose tmpfs entry in cluster-base / cluster-microservices is required to back this path — tracked as a companion issue in those repos.

### Trade-off framing

The architecture decision in generacy-ai/generacy#622 already documented that `env`-exposure of secrets puts plaintext on tmpfs readable by the workflow uid. This issue applies the same trade-off to app-config secrets:

- **Tmpfs at `/run/generacy-app-config/secrets.env`**: plaintext exists in memory only, owned by `node:node`, mode `0640`. Wiped on container teardown.
- **Encrypted backend remains the source of truth.** The secrets file is a derived view, re-rendered at boot.

Alternative considered and rejected: render secrets into the existing `/var/lib/generacy-app-config/env` alongside non-secrets. Simpler for user services (one env_file), but puts plaintext secrets on the persistent volume — meaningfully weaker than the encrypted backend at-rest model. The team can revisit if usability of two env_files becomes annoying; the schema is forward-compatible either way.

## Test plan
- [ ] Unit: at daemon startup with secrets in the backend, `/run/generacy-app-config/secrets.env` is rendered with all secret entries.
- [ ] Unit: on `PUT /app-config/env` with `secret: true`, the secrets file is updated atomically.
- [ ] Unit: on `DELETE` of a secret, the entry is removed from the secrets file.
- [ ] Unit: non-secret PUTs do NOT touch the secrets file.
- [ ] Integration: after a fresh boot of a previously-configured cluster, the secrets file is re-rendered from the encrypted backend without any user action.
- [ ] Manual: on a cluster where the user filled SERVICE_ANTHROPIC_API_KEY via the UI, `sh -c 'set -a; source /run/generacy-app-config/secrets.env; env | grep SERVICE_ANTHROPIC'` shows the value.

## Related
- generacy-ai/generacy#622 — original feature; introduced the encrypted-backend path for secrets but didn't render them.
- generacy-ai/generacy-cloud#583 — UI side.
- Companion: generacy-ai/cluster-base#38 (and cluster-microservices via sync) — adds the tmpfs mount and sources both env files from entrypoint scripts.
- Reported during app-config testing on 2026-05-15 when secrets entered via the UI didn't surface as env vars to processes.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
