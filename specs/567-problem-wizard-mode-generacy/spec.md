# Feature Specification: Background Activation in Wizard Mode

Orchestrator blocks HTTP server startup on cluster activation polling, causing healthcheck timeout and cascading container failures in wizard mode.

**Branch**: `567-problem-wizard-mode-generacy` | **Date**: 2026-05-11 | **Status**: Draft

## Summary

In wizard mode (`GENERACY_BOOTSTRAP_MODE=wizard`), `createServer()` in `packages/orchestrator/src/server.ts` awaits `activate()` before calling `server.listen()`. The `activate()` function polls for up to 10 minutes waiting for the user to complete device-code approval in-browser. During this wait, port 3100 is never bound, so the Docker healthcheck (`curl -f http://localhost:3100/health`) fails, the worker container never starts (due to `service_healthy` dependency), and the launch CLI throws `Failed to start cluster`. The user can never reach the browser activation step because the CLI fails first — a circular dependency.

This was previously masked by a schema parse error in the cloud's `pending` discriminator (fixed in generacy-cloud#534), which caused `pollForApproval` to fail immediately and skip activation. Now that polling works correctly, the blocking await is exposed.

**Recommended fix**: Background the activation call so the HTTP server starts immediately. Extract relay-bridge initialization into a function that runs after activation completes asynchronously (Approach A from the issue).

## User Stories

### US1: First-time cluster launch in wizard mode

**As a** developer running `npx generacy launch` for the first time,
**I want** the orchestrator container to become healthy immediately after starting,
**So that** the worker container can start, the CLI succeeds, and I can complete the device-code activation flow in my browser.

**Acceptance Criteria**:
- [ ] Orchestrator's `/health` endpoint responds within ~10s of container start, regardless of activation state
- [ ] `docker compose up -d` succeeds without waiting for activation to complete
- [ ] Worker container starts even while orchestrator is in pre-activation (polling) state

### US2: Activation completes after server is already running

**As a** developer who has just approved the device code in the browser,
**I want** the relay bridge and conversation manager to initialize automatically,
**So that** the cluster begins processing workflows without requiring a container restart.

**Acceptance Criteria**:
- [ ] After user completes activation in browser, relay bridge connects and cluster becomes fully operational
- [ ] No manual intervention or container restart required after activation approval

### US3: Activation failure does not crash the orchestrator

**As a** developer whose activation attempt expires or fails,
**I want** the orchestrator to continue running and serving HTTP requests,
**So that** I can retry activation or debug the issue without losing the running container.

**Acceptance Criteria**:
- [ ] If activation times out or errors, orchestrator logs a warning and continues running
- [ ] `Cluster activation skipped` log line still appears on activation failure (backward-compatible behavior)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `activate()` must not block `server.listen()` — run activation as a background promise | P0 | Core fix |
| FR-002 | Extract relay-bridge init (server.ts ~L334-390) into a callable function `initializeRelayBridge()` | P1 | Required by FR-001 to wire relay after async activation |
| FR-003 | On activation success, call `initializeRelayBridge()` to set up relay, lease manager, tunnel handler, conversation manager | P1 | Current inline code moved into the extracted function |
| FR-004 | On activation failure, log warning and continue — do not crash or block the server | P1 | Preserves existing catch-block behavior |
| FR-005 | `/health` endpoint must respond successfully even when activation is pending | P1 | Decouples healthcheck from activation state |
| FR-006 | Unhandled promise rejection from background activation must be caught (no process crash) | P1 | `.catch()` on the background promise |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Healthcheck response time after container start | < 15 seconds | `time curl http://localhost:3100/health` after `docker compose up` |
| SC-002 | `docker compose up -d` exit code in wizard mode | 0 (success) | Run launch flow end-to-end with wizard mode |
| SC-003 | Relay bridge operational after activation approval | Connected within 30s of approval | Check relay logs for connection established |
| SC-004 | Zero `ECONNREFUSED` errors from worker on startup | 0 errors | Worker container logs during startup |

## Assumptions

- The orchestrator's HTTP routes (health, lifecycle, etc.) do not require activation to have completed — they can serve responses in a pre-activation state
- The relay bridge, conversation manager, and status reporter are the only components that depend on activation results (apiKey, clusterApiKeyId)
- Worker container already has retry logic for connecting to the orchestrator (so even if there's a brief window, it recovers)

## Out of Scope

- Changing the compose healthcheck strategy (e.g., switching to `service_started`) — the fix should make `service_healthy` work correctly
- Adding a separate healthcheck listener on a different port (Approach D — over-engineered)
- Moving activation outside `createServer()` entirely (Approach B — more invasive, deferred)
- Post-activation credential cache reload (separate issue)

## Related

- generacy-ai/generacy-cloud#534 — the PR that exposed this bug by fixing the `pending` discriminator
- generacy-ai/generacy#566 — earlier fix for label monitor in wizard mode
- generacy-ai/cluster-base#21 — bootstrap mode env var
- v1.5 onboarding doc Flow B/C — wizard appearing in browser shortly after launch

---

*Generated by speckit*
