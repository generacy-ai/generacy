# Implementation Plan: Post-Activation Retry on Cluster Restart

**Feature**: Fix post-activation never re-running after container restart when first-boot setup failed
**Branch**: `652-repro-1-launch-cluster`
**Status**: Complete

## Summary

The orchestrator's post-activation flow is gated on `/tmp/generacy-bootstrap-complete`, which is wiped on container restart. When first-boot post-activation fails (bad branch, network blip, missing creds) and the user restarts the cluster, the trigger file never reappears because the wizard is skipped (cluster already activated). Post-activation is permanently blocked.

The fix: track post-activation completion on the data volume (`/var/lib/generacy/post-activation-complete`). On restart, if the cluster is already activated but post-activation never completed, replay the full `bootstrap-complete` lifecycle action — which re-unseals credentials, writes the sentinel, starts code-server/tunnel, and triggers the post-activation script.

## Scope Split

Per clarification Q1, this is a **split implementation**:

| Repo | Responsibility |
|------|---------------|
| **generacy** (this branch) | Orchestrator startup detection + retry trigger. Detects "activated but post-activation incomplete" state and replays `bootstrap-complete` lifecycle action. Error propagation via status + relay events. |
| **cluster-base** (companion PR) | Shell script writes `/var/lib/generacy/post-activation-complete` flag at end of successful `entrypoint-post-activation.sh`. Defensive cleanup (empty dirs, wrong-repo detection). |

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Framework**: Fastify (orchestrator), native `node:http` (control-plane)
- **Key packages**: `packages/orchestrator/`, `packages/control-plane/`
- **Existing patterns**: StatusReporter, relay event IPC, lifecycle action handler, activation module

## Architecture Decision: Replay Full Lifecycle Action (Q2)

The retry path replays `POST /lifecycle/bootstrap-complete` against the local control-plane socket rather than just touching the trigger file. This:
- Re-unseals credentials from encrypted store (handles "user fixed creds then restarted" scenario per Q4)
- Starts code-server and VS Code tunnel
- Writes the `/tmp/generacy-bootstrap-complete` sentinel (which the existing watcher picks up)
- Uses the same code path as first-boot — no parallel retry mechanism to maintain

## Project Structure

### Modified Files

```
packages/orchestrator/src/server.ts
  └── Add post-activation state check after activation (both sync and background paths)
  └── Call triggerPostActivationRetry() when activated + incomplete

packages/orchestrator/src/services/post-activation-retry.ts  [NEW]
  └── checkPostActivationState(): reads /var/lib/generacy/post-activation-complete
  └── triggerPostActivationRetry(): POST /lifecycle/bootstrap-complete to control-plane
  └── Emits relay events and pushes status on failure

packages/control-plane/src/routes/lifecycle.ts
  └── No changes needed — bootstrap-complete handler already does everything:
      unseal creds, write sentinel, start code-server, start tunnel
```

### New Files

```
packages/orchestrator/src/services/post-activation-retry.ts
  └── PostActivationRetryService class
  └── Encapsulates state detection, retry trigger, error propagation
```

### Companion (cluster-base, separate PR)

```
entrypoint-post-activation.sh
  └── Add: touch /var/lib/generacy/post-activation-complete (last line on success)
  └── Add: defensive cleanup for partial state before retry
```

## Implementation Flow

### Startup Decision Tree

```
orchestrator starts
  ├── No API key file → wizard mode (first boot)
  │   └── arm watcher, wait for wizard trigger (unchanged)
  │
  └── API key exists → already activated
      ├── /var/lib/generacy/post-activation-complete exists
      │   └── skip post-activation (normal restart, unchanged)
      │
      └── /var/lib/generacy/post-activation-complete absent
          └── NEW: wait for control-plane socket, then replay bootstrap-complete
```

### Retry Sequence

1. Orchestrator startup detects: API key exists + completion flag absent
2. Wait for control-plane socket to be ready (existing `probeControlPlaneSocket()` pattern)
3. `POST /lifecycle/bootstrap-complete` to local control-plane socket (with internal actor headers)
4. Control-plane handler: re-unseals credentials → writes sentinel → starts code-server/tunnel
5. Post-activation watcher (already armed) detects sentinel → runs post-activation script
6. On success: cluster-base script writes `/var/lib/generacy/post-activation-complete`
7. On failure: orchestrator pushes `degraded` status + emits `cluster.bootstrap` relay event

### Error Propagation (Q5: Both Status + Relay Event)

On retry failure:
- Push `degraded` status via `StatusReporter.pushStatus('degraded', reason)` (existing pattern)
- Emit `cluster.bootstrap` relay event with failure details via relay IPC endpoint (existing `POST /internal/relay-events` pattern)
- Log structured error visible in `docker compose logs`

## Key Design Decisions

1. **State file location**: `/var/lib/generacy/post-activation-complete` on the data volume (survives restart, consistent with existing `/var/lib/generacy/` convention for `cluster-api-key`, `cluster.json`, `credentials.dat`)

2. **Retry is fire-and-forget**: The orchestrator triggers the lifecycle action and continues starting up. The post-activation watcher handles the actual script execution. Success/failure is propagated asynchronously via the completion flag and status reporter.

3. **No retry loop**: Single retry attempt per startup. If post-activation fails again, the user gets a clear status (`degraded` with reason) and can fix-and-restart again. Avoids infinite retry storms.

4. **Control-plane readiness gate**: The retry must wait for the control-plane socket before sending the lifecycle action. Uses existing `probeControlPlaneSocket()` polling pattern from `startServer()`.

5. **Internal actor context**: The retry lifecycle call needs actor headers. Use a synthetic internal actor (similar to relay-forwarded requests) with `x-generacy-actor-user-id: system` and `x-generacy-actor-session-id: post-activation-retry`.

## Testing Strategy

| Scenario | How to test |
|----------|-------------|
| First-boot success | Verify completion flag written, no retry on next start |
| First-boot failure + restart | Mock missing completion flag + existing API key → verify lifecycle action replayed |
| Multi-restart no-op | Completion flag exists → verify no lifecycle action call |
| Control-plane not ready | Probe returns false → verify retry waits then proceeds |
| Retry failure | Mock lifecycle action failure → verify degraded status pushed |
| Credential refresh | Verify `writeWizardEnvFile()` called on retry (re-unseal, not reuse stale) |

## Dependencies

- **cluster-base companion PR**: Writes the completion flag. Without it, every restart will retry (safe but wasteful — the retry is idempotent).
- No new npm dependencies required.
- No database or schema changes.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Retry runs before control-plane is ready | Gated on `probeControlPlaneSocket()` with existing timeout pattern |
| Race between retry and manual wizard | API key check prevents retry in wizard mode; wizard creates flag normally |
| Completion flag written but setup actually partial | cluster-base script writes flag as last line — shell `set -e` prevents partial success |
| Stale credentials on retry | Always re-unseal from encrypted store (Q4 decision) |
