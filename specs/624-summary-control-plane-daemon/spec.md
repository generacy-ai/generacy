# Control-plane daemon crash resilience and orchestrator fail-fast

**Branch**: `624-summary-control-plane-daemon` | **Date**: 2026-05-15 | **Status**: Draft

## Summary

The control-plane daemon crashes entirely when `AppConfigEnvStore.init()` cannot mkdir its storage directory (`EACCES`). The orchestrator's entrypoint script treats this as a warning and continues startup, leaving the cluster in a zombie state: relay connected, control-plane dead, every `/control-plane/*` request returns 502. Two fixes are needed: (1) graceful degradation in the daemon's init chain so non-critical store failures don't crash the whole process, and (2) fail-fast in the orchestrator entrypoint when the control-plane socket never appears.

## Repro

Hit on staging during new-project onboarding (cluster-base preview image). Bootstrap wizard's GitHub App step fails with "Cluster disconnected. Please try again." because the 502 from the dead control-plane is indistinguishable from a relay disconnect in the web UI.

## User Stories

### US1: Operator diagnosing a broken cluster

**As a** cluster operator,
**I want** the cluster to fail visibly (exit non-zero, appear offline in cloud UI) when the control-plane daemon cannot start,
**So that** I can immediately identify and fix the root cause instead of debugging a zombie cluster that looks healthy but silently drops every control-plane request.

**Acceptance Criteria**:
- [ ] Orchestrator entrypoint exits non-zero if control-plane socket doesn't appear within timeout
- [ ] Cloud UI shows cluster as offline/error rather than connected
- [ ] Control-plane log includes a structured error message identifying which init step failed

### US2: Developer adding a new control-plane store

**As a** developer adding a new storage backend to the control-plane daemon,
**I want** non-critical store init failures to degrade gracefully rather than crash the entire daemon,
**So that** a permission issue in one store doesn't take down credentials, lifecycle, and all other control-plane functionality.

**Acceptance Criteria**:
- [ ] AppConfigEnvStore.init() catches EACCES and falls back to a tmpfs-backed path (e.g., `/tmp/generacy-app-config/`)
- [ ] A clear warning log is emitted when fallback is used
- [ ] Core stores (credential backend, server socket) remain fatal — daemon exits if those fail
- [ ] Non-critical store failures are surfaced via a structured error/warning, not swallowed silently

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `AppConfigEnvStore.init()` catches `EACCES` on mkdir and falls back to a tmpfs path (`/tmp/generacy-app-config/`) with a warning log | P1 | Same fallback for `AppConfigFileStore` |
| FR-002 | Control-plane entrypoint classifies init errors as fatal vs non-fatal; only fatal errors trigger `process.exit(1)` | P1 | Fatal: credential backend init, server socket bind. Non-fatal: app-config stores |
| FR-003 | Orchestrator entrypoint exits non-zero when control-plane socket doesn't appear within timeout | P1 | Currently logs WARNING and continues |
| FR-004 | Control-plane socket wait timeout is configurable via env var (default ≥ 15s) | P2 | Current hardcoded 10s is too short for first-run plugin loading |
| FR-005 | Daemon logs structured init result showing which stores initialized successfully and which fell back | P2 | Aids debugging without requiring container shell access |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | EACCES on app-config dir does not crash daemon | Daemon stays running, serves credentials/lifecycle | Unit test: mock EACCES on mkdir, assert server.start() still called |
| SC-002 | Missing control-plane socket causes orchestrator exit | Exit code ≠ 0 within timeout period | Integration test: don't start control-plane, assert orchestrator exits |
| SC-003 | Zero zombie-state clusters | Cluster either fully online or offline in cloud UI | Regression test: EACCES scenario, verify cloud sees cluster as error/offline |

## Assumptions

- The cluster-base image fix (pre-creating `/var/lib/generacy-app-config` with correct ownership) is a separate PR in the cluster-base repo; this issue handles the in-repo resilience changes only.
- `AppConfigEnvStore` and `AppConfigFileStore` are non-critical for the daemon's core mission (credentials + lifecycle). Falling back to `/tmp/` is acceptable because app-config data is reconstructible from the cloud.
- The orchestrator entrypoint script that spawns the control-plane daemon lives in the cluster-base image repo, but the orchestrator's own health/readiness logic (in this repo) should also reflect control-plane availability.

## Out of Scope

- Cloud UI changes to distinguish 502-from-control-plane vs. relay-disconnected (generacy-cloud#586).
- Cluster-base image fix to pre-create the directory with correct permissions.
- Changing the control-plane daemon from a sidecar process to an in-process module.
- Retry/restart logic for the control-plane daemon (supervisor-style restarts).

## Files of Interest

- `packages/control-plane/src/services/app-config-env-store.ts` — `init()` method with the throwing `mkdir`
- `packages/control-plane/bin/control-plane.ts` — daemon entrypoint, sequential init chain with single `.catch(exit 1)`
- `packages/orchestrator/src/services/status-reporter.ts` — fire-and-forget status push (swallows errors)
- `packages/orchestrator/src/server.ts` — relay bridge setup, control-plane socket path usage

---

*Generated by speckit*
