# Feature Specification: ## Problem

In wizard mode (`GENERACY_BOOTSTRAP_MODE=wizard`), the orchestrator's HTTP server never starts listening on port 3100

**Branch**: `567-problem-wizard-mode-generacy` | **Date**: 2026-05-11 | **Status**: Draft

## Summary

## Problem

In wizard mode (`GENERACY_BOOTSTRAP_MODE=wizard`), the orchestrator's HTTP server never starts listening on port 3100. The `createServer()` function at [packages/orchestrator/src/server.ts:307-332](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/server.ts#L307-L332) **awaits** `activate()` — which now correctly waits for user device-code approval via the polling loop in [activation/index.ts:68](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/activation/index.ts#L68). That polling loop runs for up to 10 minutes (the device code's TTL) waiting for approval.

While `activate()` is awaited, the rest of `createServer()` doesn't run — including the eventual `server.listen()` call in `startServer()` ([line 628](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/server.ts#L628)). Result: container is up, the node process is alive, but nothing is bound to port 3100.

Cascading consequences:
- Compose healthcheck (`curl -f http://localhost:3100/health`) fails with `Failed to connect to localhost port 3100`.
- Worker container's `depends_on: { orchestrator: { condition: service_healthy } }` (in the launch scaffolder's emitted compose) never satisfies.
- `docker compose up -d` reports `dependency failed to start: container ...orchestrator-1 is unhealthy`.
- Launch CLI's `startCluster()` throws → `Failed to start cluster`.
- User can't even reach the activation step in their browser, so the orchestrator's wait never gets resolved.

## Why this didn't happen before

This bug was **masked** by the `pending` vs `authorization_pending` discriminator mismatch fixed in [generacy-cloud#534](https://github.com/generacy-ai/generacy-cloud/pull/534). With that bug, `pollForApproval` failed immediately on schema parse error, the orchestrator caught the exception (line 326-330), logged "Cluster activation skipped", and proceeded to start the HTTP server. Healthcheck passed, worker started, launch CLI succeeded. Activation was effectively no-op'd.

Now that polling works correctly, the orchestrator actually waits — exposing this circular dependency.

## Verified via direct inspection

```
$ docker exec todo-list-example18-orchestrator-1 ps -ef
node     1  0  node /shared-packages/node_modules/.bin/generacy orchestrator --port 3100 ...
node   515  1  bash /usr/local/bin/post-activation-watcher.sh
$ docker exec todo-list-example18-orchestrator-1 ss -ltnp
LISTEN  127.0.0.11:40985  0.0.0.0:*  (Docker DNS only — nothing on 3100)
$ docker inspect ... --format '{{json .State.Health}}'
"Output": "curl: (7) Failed to connect to localhost port 3100 after 0 ms: Couldn't connect to server"
```

## Proposed fix

Background the activation. The HTTP server should start listening immediately so the healthcheck and worker can come up, and activation runs concurrently. When activation completes, the relay bridge initializes (currently happens synchronously after activation, line 334+).

Cleanest sketch:

```typescript
// In createServer, replace the awaited activation block (line 307-332) with:
let activationPromise: Promise<void> | null = null;
if (!isWorkerMode && !config.relay.apiKey) {
  activationPromise = activate({...})
    .then((result) => {
      config.relay.apiKey = result.apiKey;
      config.relay.clusterApiKeyId = result.clusterApiKeyId;
      // ... rest of the existing post-activation config wiring ...
      return initializeRelayBridge(server, config, ...);  // extracted from server.ts:334+
    })
    .catch((error) => {
      server.log.warn(`Cluster activation skipped: ${error}`);
    });
}

// Continue with rest of setup that doesn't depend on activation
// ...
// server.listen runs in startServer, not blocked by activation
```

This requires extracting the relay-bridge init block (lines 334 to roughly 390) into a function that takes the server + apiKey + config and wires up the relay/lease/tunnel/conversation manager. The inline state (`relayBridge`, `statusReporter` wiring, `conversationManager.setRelayBridge`) needs to be threaded through.

## Alternative shapes worth considering during clarify

- **A — Background activation, refactor relay-bridge init into a function** (described above). Cleanest separation; ~50-line extraction.
- **B — Move activation entirely outside `createServer()`.** Caller (CLI) decides whether to await activation before or after `startServer()`. More invasive contract change but conceptually cleanest.
- **C — Drop worker's `service_healthy` dependency, change to `service_started`.** Compose stops blocking on the orchestrator becoming healthy. Worker has to handle connection retries against an orchestrator that may not be up yet. But: the orchestrator IS up (process running), it just isn't listening. Worker would still hit connection-refused and need retry logic. Probably already does, but worth verifying. Less invasive but moves the problem rather than fixing it.
- **D — Dedicated lightweight healthcheck listener that comes up immediately.** A tiny socket listener on a different port, just for the healthcheck. Completely decouples healthcheck from orchestrator startup. Heavyweight infra for a startup-ordering concern.

Recommend **A**. The refactor is bounded, the state extraction is mechanical, and the architectural model ("HTTP server starts immediately, activation runs in background, relay/lease/conversation manager wire up when activation completes") matches what users expect.

## Test plan

- [ ] After fix: orchestrator container's `/health` responds within ~10s of container start (not 10+ minutes)
- [ ] `docker compose up -d` succeeds even when activation hasn't completed
- [ ] Worker container starts and operates correctly even if orchestrator is in pre-activation state (background polling)
- [ ] After user completes activation in browser, relay bridge initializes and cluster starts processing workflows
- [ ] If activation is interrupted/expired, orchestrator continues running (current `catch` block behavior preserved)
- [ ] Existing test: `Cluster activation skipped` log line still appears on activation failure

## Related

- generacy-ai/generacy-cloud#534 — the PR that exposed this bug by fixing the `pending` discriminator. (Not regressing #534 — this is a deeper bug it surfaced.)
- generacy-ai/generacy#566 — earlier fix that made orchestrator boot in wizard mode at all (label monitor graceful degrade)
- generacy-ai/cluster-base#21 — bootstrap mode env var (the wizard-mode path that exposes this orchestration ordering)
- v1.5 onboarding doc Flow B/C — describes the wizard appearing in the browser shortly after launch; with this bug, the launch CLI never reaches the activation step

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
