# Clarifications: #465 Credentials Architecture — Phase 3

## Batch 1 — 2026-04-13

### Q1: Entrypoint Wrapper Lifecycle
**Context**: The spec says "create a small shell script (or inline script)" that sources `$GENERACY_SESSION_DIR/env` before exec. The deployment model matters: a static file shipped with the orchestrator is simpler but less flexible; a dynamically generated file per session needs a write location and cleanup strategy.
**Question**: Should the entrypoint wrapper be a static script bundled with the orchestrator package (e.g., `scripts/credhelper-entrypoint.sh`), or dynamically written into the session directory at launch time? If static, where should it live in the repo?
**Options**:
- A: Static script in `packages/orchestrator/scripts/credhelper-entrypoint.sh`
- B: Dynamically written to `<session_dir>/entrypoint.sh` by the interceptor
- C: Inline as a shell `-c` wrapper (no file on disk)

**Answer**: *Pending*

### Q2: Launch Failure vs Graceful Degradation
**Context**: The spec requires "clear error" when the credhelper is unavailable, but doesn't specify whether `launch()` should throw (aborting the workflow step) or degrade gracefully (launch without credentials). This distinction matters for production resilience — a transient credhelper outage could either block all workflows or allow them to proceed with reduced permissions.
**Question**: When `request.credentials` is set but the credhelper daemon is unavailable or `beginSession` fails, should `launch()` throw an error (failing the workflow step) or proceed without credentials (logging a warning)?
**Options**:
- A: Throw — if credentials were requested, they are required; failing to obtain them is a hard error
- B: Degrade — log a warning and launch without credentials/uid/gid
- C: Configurable — add a `required: boolean` field to credentials config

**Answer**: *Pending*

### Q3: Session ID Generation Strategy
**Context**: The control socket client calls `beginSession(role, sessionId)` but the spec doesn't define how `sessionId` is generated. The choice affects debuggability (human-readable IDs are easier to correlate in logs) and uniqueness guarantees (UUIDs vs. composite keys).
**Question**: How should the session ID be generated? Should it be a random UUID, or derived from workflow context (e.g., `{workflowId}-{stepIndex}-{timestamp}`)?
**Options**:
- A: Random UUID (e.g., `crypto.randomUUID()`)
- B: Composite key from workflow context for easier debugging
- C: Let the credhelper daemon assign the ID (change API to return it from beginSession)

**Answer**: *Pending*

### Q4: Client Protocol — HTTP vs Raw JSON
**Context**: The spec describes a "JSON-over-Unix-socket" protocol for the control socket client, but the credhelper daemon (from #461) implements HTTP-over-Unix-socket with endpoints `POST /sessions` and `DELETE /sessions/:id`. Using the wrong protocol will cause connection failures.
**Question**: Should the control socket client use HTTP-over-Unix-socket (matching the daemon's actual API) rather than raw JSON-over-Unix-socket as described in the spec? If HTTP, should we use Node.js built-in `http` module or a lightweight client?
**Options**:
- A: HTTP-over-Unix-socket using Node.js built-in `http` module (matches daemon, zero dependencies)
- B: HTTP-over-Unix-socket using a lightweight client like `undici`
- C: Raw JSON-over-Unix-socket (would require changing the daemon)

**Answer**: *Pending*

### Q5: Orphaned Session Cleanup
**Context**: The spec says `endSession` is called "on subprocess exit via LaunchHandle process event." However, if the orchestrator itself crashes or the process is killed with SIGKILL, the exit handler won't fire, leaving orphaned sessions. The credhelper daemon has session expiry (`expiresAt`), but the spec doesn't address whether the orchestrator needs its own cleanup mechanism.
**Question**: Is the credhelper daemon's built-in session expiry sufficient for handling orphaned sessions, or should the orchestrator implement its own cleanup sweep (e.g., on startup, reconcile active sessions)?
**Options**:
- A: Rely on credhelper daemon's session expiry — no orchestrator-side cleanup needed
- B: Add orchestrator startup reconciliation that calls endSession for stale sessions
- C: Both — daemon expiry as safety net, orchestrator reconciliation as best-effort

**Answer**: *Pending*
