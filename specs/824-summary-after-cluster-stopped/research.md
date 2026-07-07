# Research: Orchestrator boot-time service resume

**Feature**: `824-summary-after-cluster-stopped` | **Date**: 2026-07-07

## Decision 1 — Where does the resume policy live?

**Decision**: Orchestrator-side. New `BootResumeService` in `packages/orchestrator/src/services/`, wired into `server.ts` right after `PostActivationRetryService` in the "existing API key" branch, executed only in the `needsRetry === false && activated && postActivationComplete` branch. Control-plane stays a pure executor of lifecycle actions.

**Rationale**:
- Locates the resume policy next to its sibling policy (`checkPostActivationState`), keeping both boot-time recovery predicates in one file (`server.ts`). Discoverability wins.
- The orchestrator already owns the relay-bridge lifecycle; running resume *after* `initializeRelayBridge()` (Decision 5) is free — no early-event-dropping problem.
- `bootstrap-complete` semantics stay untouched. No sentinel handling, no wizard env-file rewrite, no peer-repo re-clone. All of those are correctly one-shot side-effects of first bootstrap, not restart.
- No double-start guard needed against a hypothetical future control-plane-side trigger.

**Alternatives considered**:
- **Control-plane self-start on boot** (Q1→B). Rejected: control-plane boot happens independently of the relay bridge, so initial `cluster.vscode-tunnel { status: 'starting' }` events would drop; requires guarding against any future orchestrator-side trigger; splits the boot-recovery policy into two files.
- **Both, with dedup** (Q1→C). Rejected: adds complexity for no benefit. Idempotency of `start()` already makes double-fire safe; the additional dedup layer is dead weight until a real second caller exists.

**References**: clarifications.md Q1 → A. `packages/orchestrator/src/server.ts:470` (sibling site). `packages/control-plane/src/routes/lifecycle.ts:189-201` (idempotent `start()` in `bootstrap-complete`).

---

## Decision 2 — Failure independence between the two POSTs

**Decision**: Independent, best-effort. Both POSTs fire concurrently via `Promise.allSettled([tunnelPost, codeServerPost])`. A failure in either does NOT block or short-circuit the other. Each failure emits its own `cluster.bootstrap` event with a `service` discriminator.

**Rationale**:
- Matches today's `bootstrap-complete` handler shape (`lifecycle.ts:189-201`): code-server via `manager.start().catch(() => {})`, tunnel via `try { await tunnelManager.start() } catch {}`. Both best-effort, both independent.
- SC-003 (0% stop/start cycles leaving code-server unreachable) requires that a tunnel failure NOT cascade into a skipped code-server start.
- `Promise.allSettled` is the right primitive here — `Promise.all` would short-circuit on first rejection, which is the wrong semantics.

**Alternatives considered**:
- **Sequential with abort** (Q2→B). Rejected: leaves the other service down whenever either fails. Directly regresses SC-002 or SC-003 depending on order.
- **Atomic** (Q2→C). Rejected: couples two unrelated services; a tunnel failure would falsely mark the cluster degraded even though code-server is up.

**References**: clarifications.md Q2 → A. `packages/control-plane/src/routes/lifecycle.ts:189-201` (existing best-effort pattern in `bootstrap-complete`).

---

## Decision 3 — Failure surface: which relay channel + shape?

**Decision**: Reuse `cluster.bootstrap`, mirroring `PostActivationRetryService.handleRetryFailure()`. Emit `{ status: 'failed', reason: 'resume-failed', service: 'vscode-tunnel' | 'code-server', error }` on each failing POST. Success and no-op paths emit nothing on `cluster.bootstrap` — per-service success signals still flow through `cluster.vscode-tunnel` (from the tunnel manager) and `codeServerReady` metadata as they do on first boot.

**Rationale**:
- If the POST itself fails (socket unreachable / 5xx), the child-process managers never run, so the existing per-service channels (`cluster.vscode-tunnel { status: 'error' }`) are never emitted. FR-007 (observable failure) would be silently violated without an explicit emit here.
- Reusing `cluster.bootstrap` gives operators a single channel to watch for both boot-time recovery paths (sibling `post-activation-incomplete` retry + this new `resume-failed` path).
- The `service` field is new-vs-sibling but naturally-typed — the sibling emits a single event because it kicks a single umbrella action (`bootstrap-complete`); the resume emits per-service events because it kicks per-service actions. Discriminator is required by definition, not decoration.
- Once a POST succeeds, downstream child-process failures still surface on `cluster.vscode-tunnel` / `codeServerReady: false` as they do today. No new channel needed for the runtime failure case.

**Alternatives considered**:
- **Rely on per-service events only** (Q3→A). Rejected: fails to emit anything when the POST itself fails, because the per-service manager never runs. Violates FR-007.
- **New `cluster.resume` channel** (Q3→C). Rejected: no rationale to invent a channel; the sibling retry service already emits `resume-adjacent` events on `cluster.bootstrap`. Operators get a single mental model.

**References**: clarifications.md Q3 → B. `packages/orchestrator/src/services/post-activation-retry.ts:95-104` (`handleRetryFailure` shape).

---

## Decision 4 — Single-shot vs bounded retry vs background watcher

**Decision**: Single-shot. Envelope: 15 s `probeControlPlaneSocket` wait + 1 POST attempt with 10 s `req.setTimeout()`. Failures log + emit the `cluster.bootstrap { status: 'failed' }` event and stop. Manual UI Restart remains the backstop.

**Rationale**:
- Matches `PostActivationRetryService.triggerPostActivationRetry()` (`post-activation-retry.ts:57-93`) exactly — same mental model for operators and reviewers.
- The dominant boot transient is "control-plane socket not ready yet." The 15 s probe wait already absorbs that: `probeControlPlaneSocket` polls every 1 s.
- Once the socket is ready, POSTs that merely fire-and-forget a local child spawn are highly reliable. Bounded retry (Q4→B) buys little for the added code.
- A background watcher (Q4→C) invites state drift: what happens when the user hits UI Restart mid-watcher-cycle? What about when they issue `generacy stop` while a watcher is still trying? The state machine explodes.
- Both `start()` methods are idempotent. A rare miss is observable (via `cluster.bootstrap { status: 'failed' }`) and manually recoverable (UI Restart). If telemetry later shows real POST-level flakiness, promoting to bounded retry (Q4→B) is a clean follow-up.

**Alternatives considered**:
- **Bounded retry with backoff** (Q4→B). Rejected pre-emptively; promote only if real telemetry shows POST-level flakiness.
- **Background watcher** (Q4→C). Rejected: state-drift risk and mental-model divergence from sibling service.

**References**: clarifications.md Q4 → A. `packages/orchestrator/src/services/post-activation-retry.ts:57-93` (existing single-shot envelope).

---

## Decision 5 — Startup ordering: before or after the relay bridge?

**Decision**: After `initializeRelayBridge()`. Same block as `PostActivationRetryService`. The tunnel manager's first `cluster.vscode-tunnel { status: 'starting' }` event reaches the relay client and forwards to the cloud.

**Rationale**:
- `getRelayPushEvent()` in `packages/control-plane/src/relay-events.ts` returns `undefined` until the orchestrator's relay-events HTTP route callback has been wired via `setRelayPushEvent()`. If the tunnel manager emits before that wiring, the event is silently dropped.
- US2 AC ("tunnel state transitions on restart drive the same `cluster.vscode-tunnel` relay events as first-boot start") requires the initial `starting` event to reach the cloud.
- Free with Decision 1: since the resume sits in the same block as `PostActivationRetryService`, and that block runs after `initializeRelayBridge()` completes, ordering is already correct.
- No buffering / replay layer needed. The relay-bridge init path is single-shot and completes before the block reaches the new resume-service instantiation.

**Alternatives considered**:
- **No relay-bridge ordering guarantee** (Q5→B). Rejected: silently loses the initial connect event from the cloud dashboard's view.
- **Buffer events until relay is up** (Q5→C). Rejected: not needed since Decision 1 gives us the ordering for free. Adds complexity for zero benefit.

**References**: clarifications.md Q5 → A. `packages/orchestrator/src/server.ts:448-488` (relay-bridge + retry block ordering).

---

## Implementation patterns to follow

- **Service class shape**: copy `PostActivationRetryService` verbatim in constructor + private helpers. Diverge in `triggerBootResume()` (Promise.allSettled instead of single POST) and `handleResumeFailure()` (per-service payload) and the omitted `StatusReporter` call (Decision 3 — no cluster.status transition).
- **Lifecycle POST**: reuse the exact `http.request({ socketPath, path, method: 'POST', headers })` block from `PostActivationRetryService.sendLifecycleAction()`. Path becomes `/lifecycle/vscode-tunnel-start` or `/lifecycle/code-server-start`. Body is `JSON.stringify({ action })` (no additional fields; both handlers ignore the body when the action-name-in-URL matches).
- **Relay event emit**: use the same `sendRelayEvent` callback that `server.ts` builds around `relayClientRef` for `PostActivationRetryService`. Wire identically — same nullable-callback pattern.
- **Wiring in `server.ts`**: add an `else if` after the existing `if (postActivationState.needsRetry) { ... }` block, guarded on `postActivationState.activated && postActivationState.postActivationComplete`. Both branches share the same `retryService` predicate output; do not compute state twice.
- **Test shape**: mirror `packages/orchestrator/src/__tests__/post-activation-retry.test.ts`. Mock `probeControlPlaneSocket` for the socket-wait branch. Stand up a temporary `net.createServer` on a `unixSocketPath` for the POST branch (as the sibling test does at line ~180 onward). Assert both POSTs fired, per-service failure surfaces don't cross-contaminate, and no retry loop exists.

## Key references

- **Issue**: [#824](https://github.com/generacy-ai/generacy/issues/824)
- **Sibling code**: `packages/orchestrator/src/services/post-activation-retry.ts` — model to mirror.
- **Sibling test**: `packages/orchestrator/src/__tests__/post-activation-retry.test.ts` — test scaffolding to mirror.
- **Existing lifecycle handlers**: `packages/control-plane/src/routes/lifecycle.ts` — `code-server-start` at L31–45, `vscode-tunnel-start` at L77–91, `bootstrap-complete` at L~140–205.
- **Idempotent managers**:
  - `packages/control-plane/src/services/vscode-tunnel-manager.ts` (`VsCodeTunnelProcessManager.start()`).
  - `packages/control-plane/src/services/code-server-manager.ts` (`CodeServerProcessManager.start()`).
- **Prior art PR #652**: fixed the `needsRetry === true` restart path. This issue is the mirror gap for the `needsRetry === false` restart path.
- **Related issue #604**: device-code race — separate; may cause orphan tunnel child on device-code timeout even after this fix lands.
