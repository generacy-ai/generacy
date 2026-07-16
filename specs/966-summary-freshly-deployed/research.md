# Research Notes

Feature: **VS Code Desktop tunnel hangs on "Starting tunnel…"** (#966)

## Live-cluster forensics (already captured in spec.md)

- `code tunnel` CLI running with no non-interactive token → device-code auth path.
- Alive TCP connection to `140.82.114.3:443` (GitHub device-auth endpoint); no connection to `global.rel.tunnels.api.visualstudio.com` (VS Code tunnel relay). Classic "stuck in device-code auth" signature.
- `~/.vscode/cli` contained only the tunnel lock file — no cached token to fall back to.
- Child process auth-pending for 10+ minutes, meaning the existing 30 s `deviceCodeTimer` was cancelled at the `starting → authorization_pending` transition and never re-armed.

Confirmed dropped-event pathway:
- `packages/orchestrator/src/routes/internal-relay-events.ts:43` — `if (client.isConnected)` silent drop when the relay is in any state other than `connected`.
- Orchestrator log line: `[relay] Cannot send message: not connected` during initial boot cycle, i.e. `bootstrap-complete` fired before the relay was `connected`.

## Decision 1 — Buffer location (Q1)

**Chosen**: Option A. Module-level singleton in the orchestrator process (`packages/orchestrator/src/routes/retained-tunnel-event.ts`), mirroring the existing `getRelayPushEvent`/`setRelayPushEvent` idiom in `packages/control-plane/src/relay-events.ts`.

**Rationale**:
- The writer (`/internal/relay-events` route) and reader (`RelayBridge.handleConnected`) both run in the orchestrator process. Shared in-process state is the minimum wiring.
- FR-002 forbids a new cross-process reconnect signal (`POST /lifecycle/relay-reconnect`), which rules out Option C (retain in control-plane's `VsCodeTunnelProcessManager`).
- Option B (private field on `RelayBridge` with `setRetainedTunnelEvent()` method) works but couples the route to a `RelayBridge` instance for no gain over a module-level singleton.

**Alternatives considered**:
- **Redis** — persistence across restarts. Rejected: FR out-of-scope explicitly says "Persisting the retained event across orchestrator process restarts (in-memory only; a restart resets the buffer, which is acceptable because the child process is also gone after restart)".
- **Per-clusterId keying** (`Map<clusterId, RetainedTunnelEvent>`) — multi-tenant readiness. Rejected: assumption "Only one `code tunnel` child process is expected per cluster at any moment. Multi-tenant retention (per-clusterId keying) is not required."

## Decision 2 — Retained-status eligibility (Q2)

**Chosen**: Option B. Retain `authorization_pending`, `connected`, `disconnected`, and `error`, but retain `error` only when emitted by the child-lifecycle path (spawn failure, exit-before-connected, device-code timeout, new auth-phase timeout).

Skip `error` from:
- `unregister()` cleanup (`vscode-tunnel-manager.ts:326-378`) — 3 emit sites: timeout, non-zero exit, spawn error.
- Name-collision observational emit (`vscode-tunnel-manager.ts:434`) — `"tunnel name collision"`.

**Rationale**: Replaying an `unregister()` cleanup error after reconnect could spuriously error a tunnel that is actually `connected`. Name-collision is observational, not a state transition.

**Implementation choice**: string-match on the `error` field against a module-level `NON_LIFECYCLE_ERROR_MARKERS` constant. Alternative — adding a new `source` or `kind` field to the `VsCodeTunnelEvent` payload — was rejected because the wire contract with the cloud UI is out of scope ("no new SSE frame type or discriminator field is added"). String-match is brittle in principle; mitigated by an eligibility test that feeds each of the four exact strings and asserts rejection, so a rename in `vscode-tunnel-manager.ts` breaks the test loudly.

## Decision 3 — Slot semantics (Q3)

**Chosen**: Option C. Single slot per tunnel with terminal-beats-pending precedence.

**Rationale**: FR-005 says "at most one retained event per tunnel per event-class, latest wins" and US2 says "only the latest actionable status per tunnel matters" — both rule out Option B's multi-slot audit trail. Between A (latest-wins) and C (terminal precedence), the visible behavior is identical in the happy path, but this is a reliability bugfix where cross-reconnect ordering is exactly what's unreliable. C encodes the precedence explicitly: a late/re-emitted `authorization_pending` never clobbers a `connected` state, so the UI never shows a device code for an already-authorized tunnel.

**Precedence table** (see plan.md "Retention slot state transitions" for full matrix):
- `connected`/`disconnected`/`error` overwrite an earlier `authorization_pending`.
- Among terminals (`connected`/`disconnected`/`error`), latest wins.
- `authorization_pending` overwrites only an earlier `authorization_pending` or empty slot.

## Decision 4 — Auth-phase timeout scope (Q4)

**Chosen**: Option C. Introduce distinct `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS = 300_000` (5 min) armed on transition to `authorization_pending`. Preserve the existing 30 s `DEFAULT_DEVICE_CODE_TIMEOUT_MS` (renamed conceptually as the "starting-phase" timer, though the export name stays for backward compatibility) for the "spawned but never printed a code" broken-CLI case.

**Rationale**:
- Live hang was 10+ min in `authorization_pending` after the 30 s starting timer had already been cancelled at the transition. Any fix that only extends the starting timer would either fire during legitimate user browser interaction (option A/B: 30-60 s total) or fail to fire in the observed hang (unchanged behavior).
- Human latency P99 for opening a browser, logging into GitHub, and typing an 8-char code is well below 5 min.
- GitHub device codes remain valid ~15 min, so 5 min is comfortably under the natural expiry.
- Two phases with genuinely different expected durations warrant two constants — encoding "the CLI is broken" (30 s, unlikely-and-fast) vs. "the human is slow" (5 min, expected-and-slow) as one budget conflates them.

**Constant name**: `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` (not `DEFAULT_AUTH_PHASE_TIMEOUT_MS`) — keeps the "device-code" prefix consistent with the existing `DEFAULT_DEVICE_CODE_TIMEOUT_MS` so operators grep-find them together.

**Not chosen: PostgreSQL/Redis-backed retention of the timeout** — timers reset when the process restarts, but so does the child process, so a fresh spawn re-arms both timers naturally. Acceptable for the same reason the retained event itself is in-memory.

## Decision 5 — Fresh-emit on user re-trigger (Q5)

**Chosen**: Option A. Emit a fresh `starting` event and return; keep the child.

**Rationale**:
- The `starting`-with-live-child case is the exact click-into-silence gap (FR-003).
- Option C (kill + respawn) discards a healthy child that is likely about to print its device code within seconds, wasting a spawn cycle and dropping any partial progress.
- Option B (emit nothing) is the current broken behavior.
- With FR-004's new pending-phase timeout in place, a genuinely stuck child still surfaces a terminal `error` after 5 min, so A carries no permanent-hang risk.

**Insertion point**: the new branch goes *before* the existing `authorization_pending && deviceCode` and `connected` branches at `vscode-tunnel-manager.ts:143-163`. Since the outer condition is on `this.status`, an `else if (this.status === "starting")` is well-typed and touches only one file.

## Reference sources

- `packages/orchestrator/src/routes/internal-relay-events.ts` — drop site (line 43).
- `packages/orchestrator/src/services/relay-bridge.ts` — reconnect handler (line 197).
- `packages/control-plane/src/services/vscode-tunnel-manager.ts` — emit sites (all `emitTunnelEvent(...)` calls) and existing timeout pattern (lines 259-289).
- `packages/control-plane/src/relay-events.ts` — pattern precedent for `get`/`set` module-level singleton (existing `getRelayPushEvent`/`setRelayPushEvent`).
- `packages/orchestrator/src/services/status-reporter.ts` — pattern precedent for `pushStatus('ready')` in `handleConnected`.
- Prior related bugs: #519 (tunnel handler), #584 (VS Code CLI tunnel manager introduction), #608 (tunnel-name derivation), #618 (project-id derivation, later reverted), #831 (start() early-return rework — the immediate predecessor commit `aef8f58a` that shaped the current code path). Each of these motivates a specific line-number reference in the spec.

## Non-decisions explicitly deferred to follow-ups (per spec §Out of Scope)

- Cloud-side `use-vscode-tunnel.ts` client-side timeout and Firestore `vscodeTunnelStatus` fallback — separate issue in `generacy-cloud` (per one-issue-per-repo convention).
- General-purpose retained/replay layer for other `cluster.*` channels — would touch `cluster.audit`, `cluster.credentials`, `cluster.bootstrap`, `cluster.identity-split`. Each has different semantics (audit batches are already flushed, credentials are cache-refreshable, bootstrap events are terminal). Case-by-case, not a shared abstraction.
- Persistence across orchestrator process restart — in-memory only.
- Multi-tenant per-clusterId keying — single-tunnel-per-cluster assumption stands.
- Changes to `code tunnel` CLI parser or flags — no CLI-format regression in scope.
- Gating `bootstrap-complete` on relay-connected (option 2 in the issue body) — the reliable-delivery approach (FR-001/FR-002) subsumes it.
