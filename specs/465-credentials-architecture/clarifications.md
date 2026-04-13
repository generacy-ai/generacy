# Clarifications: #465 Credentials Architecture — Phase 3

## Batch 1 — 2026-04-13

### Q1: Entrypoint Wrapper Lifecycle
**Context**: The spec says "create a small shell script (or inline script)" that sources `$GENERACY_SESSION_DIR/env` before exec. The deployment model matters: a static file shipped with the orchestrator is simpler but less flexible; a dynamically generated file per session needs a write location and cleanup strategy.
**Question**: Should the entrypoint wrapper be a static script bundled with the orchestrator package (e.g., `scripts/credhelper-entrypoint.sh`), or dynamically written into the session directory at launch time? If static, where should it live in the repo?
**Options**:
- A: Static script in `packages/orchestrator/scripts/credhelper-entrypoint.sh`
- B: Dynamically written to `<session_dir>/entrypoint.sh` by the interceptor
- C: Inline as a shell `-c` wrapper (no file on disk)

**Answer**: C — inline as a shell `-c` wrapper (no file on disk).**

The interceptor wraps the command:
```typescript
const wrappedCommand = 'sh';
const wrappedArgs = ['-c', `. "\$GENERACY_SESSION_DIR/env" && exec ${command} ${args.map(shellEscape).join(' ')}`];
```

No file to write, no permissions to set, no cleanup. The env file is already in the session directory (written by the credhelper daemon). We just need to source it before exec. An inline wrapper does this with zero disk footprint.

Static file (A) requires knowing its path at runtime and distributing it. Dynamic file (B) requires write, chmod, and cleanup. Both add complexity for no benefit when `-c` works fine.

Edge case: if args contain shell-special characters, they need escaping. Use a `shellEscape()` helper or pass the original command/args as positional parameters to the wrapper script (`sh -c '. "$GENERACY_SESSION_DIR/env" && exec "$@"' _ command arg1 arg2`).

---

### Q2: Launch Failure vs Graceful Degradation
**Context**: The spec requires "clear error" when the credhelper is unavailable, but doesn't specify whether `launch()` should throw (aborting the workflow step) or degrade gracefully (launch without credentials). This distinction matters for production resilience — a transient credhelper outage could either block all workflows or allow them to proceed with reduced permissions.
**Question**: When `request.credentials` is set but the credhelper daemon is unavailable or `beginSession` fails, should `launch()` throw an error (failing the workflow step) or proceed without credentials (logging a warning)?
**Options**:
- A: Throw — if credentials were requested, they are required; failing to obtain them is a hard error
- B: Degrade — log a warning and launch without credentials/uid/gid
- C: Configurable — add a `required: boolean` field to credentials config

**Answer**: A — throw. Credentials are required if requested.**

The whole point of the credentials architecture is "least privilege by construction." If a role was configured (via `defaults.role` in `.generacy/config.yaml`), the developer explicitly opted in to credential scoping. Running without credentials when they were expected silently reverts to the old env-var behavior — which is exactly what the system is designed to move away from.

The error should be clear and actionable:
```
CredhelperUnavailableError: cannot begin session for role 'developer' — 
  credhelper not responding at /run/generacy-credhelper/control.sock
  (is the credhelper daemon running? check worker container entrypoint)
```

The orchestrator decides whether to retry or surface the error to the user. Graceful degradation (B) would undermine the security model. Configurable (C) adds complexity for a situation that indicates a broken container, not a feature choice.

---

### Q3: Session ID Generation Strategy
**Context**: The control socket client calls `beginSession(role, sessionId)` but the spec doesn't define how `sessionId` is generated. The choice affects debuggability (human-readable IDs are easier to correlate in logs) and uniqueness guarantees (UUIDs vs. composite keys).
**Question**: How should the session ID be generated? Should it be a random UUID, or derived from workflow context (e.g., `{workflowId}-{stepIndex}-{timestamp}`)?
**Options**:
- A: Random UUID (e.g., `crypto.randomUUID()`)
- B: Composite key from workflow context for easier debugging
- C: Let the credhelper daemon assign the ID (change API to return it from beginSession)

**Answer**: B — composite key from workflow context.**

Session IDs appear in log messages, session directory paths, error messages, and audit logs. A human-readable composite key makes debugging dramatically easier — you see `/run/generacy-credhelper/sessions/wf-abc123-1713052800/` and immediately know which workflow it belongs to.

Pattern: `{agentId}-{workflowId}-{timestamp}-{random4}`

- `agentId`: from `AGENT_ID` env var (set by devcontainer-refactor-plan, equals `$HOSTNAME`)
- `workflowId`: from the workflow being executed (available in the orchestrator)
- `timestamp`: epoch seconds for temporal ordering
- `random4`: 4-char random suffix for uniqueness within the same second

Example: `worker-7f2a-wf-pr-review-42-1713052800-x9k2`

A random UUID (A) requires cross-referencing logs to find the workflow. Daemon-assigned IDs (C) would require an API change and the orchestrator still has better context for naming.

---

### Q4: Client Protocol — HTTP vs Raw JSON
**Context**: The spec describes a "JSON-over-Unix-socket" protocol for the control socket client, but the credhelper daemon (from #461) implements HTTP-over-Unix-socket with endpoints `POST /sessions` and `DELETE /sessions/:id`. Using the wrong protocol will cause connection failures.
**Question**: Should the control socket client use HTTP-over-Unix-socket (matching the daemon's actual API) rather than raw JSON-over-Unix-socket as described in the spec? If HTTP, should we use Node.js built-in `http` module or a lightweight client?
**Options**:
- A: HTTP-over-Unix-socket using Node.js built-in `http` module (matches daemon, zero dependencies)
- B: HTTP-over-Unix-socket using a lightweight client like `undici`
- C: Raw JSON-over-Unix-socket (would require changing the daemon)

**Answer**: A — HTTP via Node.js built-in `http` module.**

The daemon (#461, Q1) resolved to HTTP-over-Unix-socket. The client should match:

```typescript
const response = await new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: CONTROL_SOCKET_PATH,
    path: '/sessions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, resolve);
  req.on('error', reject);
  req.end(JSON.stringify({ role, session_id: sessionId }));
});
```

Zero dependencies. Node's `http` module handles Unix sockets natively via `socketPath`. `undici` (B) adds a dependency for the same result. Raw JSON (C) contradicts the daemon's HTTP design.

---

### Q5: Orphaned Session Cleanup
**Context**: The spec says `endSession` is called "on subprocess exit via LaunchHandle process event." However, if the orchestrator itself crashes or the process is killed with SIGKILL, the exit handler won't fire, leaving orphaned sessions. The credhelper daemon has session expiry (`expiresAt`), but the spec doesn't address whether the orchestrator needs its own cleanup mechanism.
**Question**: Is the credhelper daemon's built-in session expiry sufficient for handling orphaned sessions, or should the orchestrator implement its own cleanup sweep (e.g., on startup, reconcile active sessions)?
**Options**:
- A: Rely on credhelper daemon's session expiry — no orchestrator-side cleanup needed
- B: Add orchestrator startup reconciliation that calls endSession for stale sessions
- C: Both — daemon expiry as safety net, orchestrator reconciliation as best-effort

**Answer**: A — rely on daemon expiry only.**

The daemon already has session expiry with auto-cleanup + warning (#461 Q2, answer C). This handles every scenario where `endSession` doesn't fire: orchestrator crash, SIGKILL, worker crash, any unexpected exit.

Adding orchestrator startup reconciliation (B/C) means:
- New API endpoint on the daemon to enumerate active sessions
- Orchestrator needs to know which sessions it owns vs. other orchestrators'
- Additional state management and failure modes
- All for a problem the daemon's 30-second sweeper already solves

The daemon's sweeper is the single source of truth for session cleanup. The credential TTLs are already designed to cover expected workflow durations. Keep it simple — one cleanup mechanism, one owner.
