# Bug Fix: Control-plane daemon resolves cluster.yaml relative to CWD, missing the project subdir

**Branch**: `630-summary-control-plane-daemon` | **Date**: 2026-05-15 | **Status**: Draft

## Summary

The control-plane daemon's `readManifest()` (`packages/control-plane/src/routes/app-config.ts:48-66`) reads `.generacy/cluster.yaml` relative to either `process.env.GENERACY_PROJECT_DIR` or `process.cwd()`. Neither resolves correctly in the standard cluster layout:

- The daemon is spawned by the orchestrator entrypoint with **CWD = `/workspaces`** (not the project root).
- `GENERACY_PROJECT_DIR` is **not set** in the orchestrator environment.

So `readManifest()` looks for `/workspaces/.generacy/cluster.yaml`, which doesn't exist. The actual project file lives at `/workspaces/<project-name>/.generacy/cluster.yaml`. The endpoint silently returns `null` — the bootstrap wizard's AppConfigStep and the Settings → App config tab both show "No environment variables configured" no matter what the user puts in their `cluster.yaml`.

## Root Cause

`getGeneracyDir()` (or equivalent path resolution) uses a 2-tier fallback:
1. `process.env.GENERACY_PROJECT_DIR` (not set in production clusters)
2. `process.cwd()` (resolves to `/workspaces`, not the project root)

The daemon is spawned from the orchestrator entrypoint which has CWD `/workspaces`. The project's `.generacy/` directory lives one level deeper at `/workspaces/<project-name>/.generacy/`.

## Repro

On a freshly-bootstrapped staging cluster:

```bash
# Control-plane daemon is healthy, route is registered — but manifest is null
docker exec <orchestrator> sh -c 'curl --silent --unix-socket /run/generacy-control-plane/control.sock \
  -H "x-control-plane-actor: {\"id\":\"test\"}" \
  http://localhost/app-config/manifest'
# → null

# The cluster.yaml exists in the correct project subdir
docker exec <orchestrator> cat /workspaces/onboarding-test-1/.generacy/cluster.yaml
# → channel: preview / workers: ... / appConfig: { schemaVersion: "1", env: [...], files: [...] }

# Copying to the CWD-relative path makes it work (confirming path resolution is the issue)
docker exec -u root <orchestrator> sh -c \
  'mkdir -p /workspaces/.generacy && cp /workspaces/onboarding-test-1/.generacy/cluster.yaml /workspaces/.generacy/'
# Retry → returns the manifest JSON correctly
```

## User Stories

### US1: Cluster admin sees app config in wizard and settings

**As a** cluster admin bootstrapping a new project,
**I want** the AppConfigStep in the bootstrap wizard (and the Settings → App config tab) to display environment variables defined in my `cluster.yaml`,
**So that** I can review and confirm the app configuration before completing setup.

**Acceptance Criteria**:
- [ ] `GET /app-config/manifest` returns the parsed `appConfig` section from `cluster.yaml` on a freshly-bootstrapped cluster without any env-var workaround.
- [ ] The bootstrap wizard's AppConfigStep renders the configured env vars and files.

### US2: Robust path discovery across deployment modes

**As a** platform operator deploying clusters in various configurations,
**I want** the daemon to discover the project root automatically via multiple fallback strategies,
**So that** the manifest endpoint works regardless of how the daemon process is spawned.

**Acceptance Criteria**:
- [ ] `GENERACY_PROJECT_DIR` is honored when set (explicit override).
- [ ] `WORKSPACE_DIR` is used as fallback when `GENERACY_PROJECT_DIR` is unset.
- [ ] Glob-based discovery finds a single `/workspaces/*/.generacy/cluster.yaml` match.
- [ ] Multiple glob matches produce a warning and fall back to CWD-relative.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `getGeneracyDir()` checks `GENERACY_PROJECT_DIR` env var first | P1 | Already exists but var is not set |
| FR-002 | Falls back to `${WORKSPACE_DIR}/.generacy` when `GENERACY_PROJECT_DIR` unset | P1 | Matches orchestrator conventions |
| FR-003 | Falls back to glob `/workspaces/*/.generacy/cluster.yaml`, picks single match | P1 | Auto-discovery for standard layout |
| FR-004 | Logs warning on zero or multiple glob matches, falls back to CWD-relative | P2 | Backwards compatibility |
| FR-005 | Path resolution result is cached (resolved once at startup or first call) | P2 | Avoid repeated glob I/O |

## Fix Approach

### Option A — daemon discovers the project root (preferred)

Make `getGeneracyDir()` use a 4-tier fallback:

1. `GENERACY_PROJECT_DIR` → use directly.
2. `WORKSPACE_DIR` → use `${WORKSPACE_DIR}/.generacy`.
3. Glob `/workspaces/*/.generacy/cluster.yaml` → pick single match, extract parent.
4. CWD-relative `.generacy` → backwards-compatible last resort.

This is forward-compatible: if the cluster image later sets `GENERACY_PROJECT_DIR`, the explicit path wins. If it doesn't, auto-discovery handles the common case.

### Option B — cluster-image side fix (defense-in-depth)

The orchestrator entrypoint in cluster-base already derives `/workspaces/<project-name>` from `REPO_URL`. It could `export GENERACY_PROJECT_DIR=/workspaces/<project-name>` before spawning the daemon.

**Recommendation**: Ship Option A. Option B is a nice-to-have in the cluster-base repo.

## Test Plan

- [ ] Unit: `getGeneracyDir()` returns `GENERACY_PROJECT_DIR` value when set.
- [ ] Unit: with `GENERACY_PROJECT_DIR` unset and `WORKSPACE_DIR` set, returns `${WORKSPACE_DIR}/.generacy`.
- [ ] Unit: with neither set and a single `/workspaces/*/.generacy/cluster.yaml`, glob-resolves it.
- [ ] Unit: with neither set and multiple matches, logs warning and returns CWD-relative fallback.
- [ ] Integration: on a fresh cluster, `GET /app-config/manifest` returns parsed `appConfig` without workaround.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Manifest endpoint returns config on fresh cluster | 100% of bootstrapped clusters | Manual QA on staging |
| SC-002 | No regression when `GENERACY_PROJECT_DIR` is explicitly set | Pass | Unit tests |
| SC-003 | Zero silent failures — logs emitted on fallback paths | All fallback paths logged | Log inspection |

## Assumptions

- The standard cluster layout places the project at `/workspaces/<project-name>/`.
- Only one project directory exists under `/workspaces/` in the standard layout (glob picks single match).
- `WORKSPACE_DIR` env var convention is stable in the orchestrator environment.

## Out of Scope

- Cluster-base entrypoint changes (Option B) — separate repo, separate PR.
- Multi-project cluster support (multiple `.generacy/` dirs under `/workspaces/`).
- Changes to the `appConfig` schema or YAML parsing logic (confirmed working).
- The adjacent envelope bug (fixed in #626).

## Related

- Originally introduced in #622 (control-plane manifest route).
- Adjacent to the now-closed envelope bug in #626 — same handler, different layer.
- Reported during cluster app-config testing on 2026-05-15.

---

*Generated by speckit*
