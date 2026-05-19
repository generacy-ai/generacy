# Bug Fix: Wizard-mode relay bridge initialization failure

**Branch**: `598-symptoms-after-creating-fresh` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

In wizard mode (`GENERACY_BOOTSTRAP_MODE=wizard`), the `/internal/relay-events` Fastify route is registered after `server.listen()`, causing Fastify to reject it. This silently kills the relay bridge, leaving the cluster permanently isolated from cloud. The bootstrap wizard shows "Cluster is not reachable" and all subsequent wizard steps fail with 404s.

## Root Cause

`initializeRelayBridge()` in `packages/orchestrator/src/server.ts` was historically side-effect-free (only constructed a `ClusterRelayClient`). PR #594 added a `setupInternalRelayEventsRoute(server, relayClient)` call inside it, which registers a Fastify route.

In wizard mode, the startup ordering is:
1. `createServer()` schedules background activation, returns immediately
2. `server.listen()` is called
3. Later, activation completes and runs `initializeRelayBridge()`
4. `setupInternalRelayEventsRoute()` tries to add a route **after listen** — Fastify rejects this
5. The `try/catch` swallows the error and abandons relay initialization entirely

In non-wizard mode, `initializeRelayBridge()` runs before `server.listen()`, so the bug doesn't manifest.

## Fix Strategy

**Option A (recommended)**: Register the route before `server.listen()` with a deferred relay-client binding. Introduce a mutable reference (`relayClientRef`) and update `setupInternalRelayEventsRoute` to accept a getter function. The route is registered pre-listen; `initializeRelayBridge()` assigns the client reference post-activation. Requests before relay is ready return 503.

## User Stories

### US1: New user completes bootstrap wizard

**As a** developer setting up a fresh Generacy cluster,
**I want** the bootstrap wizard to successfully connect to my cluster after activation,
**So that** I can complete the onboarding flow (credential setup, repo cloning, Ready step) without errors.

**Acceptance Criteria**:
- [ ] Wizard "Ready" step shows online status (not "Cluster is not reachable")
- [ ] No "Relay bridge not available" errors in orchestrator logs
- [ ] `/internal/relay-events` route accepts POSTs after activation completes

### US2: Non-wizard mode unaffected

**As a** developer using devcontainer or standalone mode,
**I want** relay bridge initialization to continue working as before,
**So that** this fix doesn't introduce regressions in existing deployment modes.

**Acceptance Criteria**:
- [ ] Non-wizard startup path unchanged in behavior
- [ ] Relay bridge connects to cloud on startup as before

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `/internal/relay-events` route must be registered before `server.listen()` | P0 | Core fix — prevents Fastify rejection |
| FR-002 | `setupInternalRelayEventsRoute` accepts a getter `() => ClusterRelayClient \| null` instead of direct client | P0 | Enables deferred binding |
| FR-003 | Route returns 503 with `{ error: "relay not yet initialized" }` when relay client is null | P1 | Graceful degradation before activation |
| FR-004 | `initializeRelayBridge()` assigns relay client ref after construction | P0 | Completes the deferred binding |
| FR-005 | `initializeRelayBridge()` must not call `server.post()` or any Fastify route-registration method | P1 | Prevents future wizard-mode regressions |
| FR-006 | API key for internal relay events route registered before `server.listen()` | P1 | Key must be in `apiKeyStore` before route is live |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wizard-mode relay initialization | No "Relay bridge not available" log | `docker logs <orchestrator> \| grep "Relay bridge"` |
| SC-002 | Relay connection established | "Relay connected to cloud" in logs | `docker logs <orchestrator> \| grep "Relay connected"` |
| SC-003 | Wizard Ready step | Shows online status | Browser: no 404s on `/control-plane/*` routes |
| SC-004 | Non-wizard regression | No behavioral change | Existing devcontainer startup works unchanged |

## Assumptions

- Fastify's restriction on post-listen route registration is by design and won't be relaxed
- The `ORCHESTRATOR_INTERNAL_API_KEY` env var is available at server startup (set by entrypoint script)
- The getter pattern (lazy relay client resolution) is sufficient — no need for request queuing

## Out of Scope

- Refactoring the wizard-mode activation flow beyond this specific fix
- Adding retry logic for relay connection failures
- Changes to the control-plane process or cluster-base entrypoint scripts

## Test Plan

- [ ] Fresh wizard-mode cluster: `/health` returns 200 immediately, no "Relay bridge not available" in logs
- [ ] After activation: `POST /internal/relay-events` with internal API key succeeds and forwards via relay
- [ ] After activation: logs contain "Relay bridge configured" + "Relay connected to cloud"
- [ ] Wizard "Ready" step shows online status
- [ ] No regression in non-wizard mode (devcontainer / standalone)

## Related

- #594 (introduced the `setupInternalRelayEventsRoute` side-effect)
- #595 (the merged PR)
- #572 (cluster-cloud contract umbrella)

---

*Generated by speckit*
