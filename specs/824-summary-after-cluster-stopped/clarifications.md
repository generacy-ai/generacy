# Clarifications

## Batch 1 — 2026-07-07

### Q1: Design approach — where does the resume live?
**Context**: The spec's "Design Options" section explicitly defers to the plan phase: (1) **Orchestrator-side boot resume** — orchestrator startup POSTs `/lifecycle/vscode-tunnel-start` + `/lifecycle/code-server-start` to the control-plane socket when `activated && postActivationComplete`; (2) **Control-plane self-start** — control-plane detects persisted VS Code CLI registration on its own boot and auto-starts both services. Option 1 keeps `bootstrap-complete` semantics untouched (no sentinel handling, no wizard env-file rewrite) and matches the existing `PostActivationRetryService` pattern at `packages/orchestrator/src/server.ts:470`. Option 2 changes control-plane boot semantics and requires guarding against double-start with any future orchestrator-side trigger. The choice determines which process owns the retry/failure loop and where the new structured "boot resume fired" log lands (US2 AC).
**Question**: Which design should the plan implement?
**Options**:
- A: **Orchestrator-side boot resume only** (Option 1). New logic in `server.ts` after `checkPostActivationState()` returns `needsRetry: false && activated && postActivationComplete`. Sibling of `PostActivationRetryService` (or an added method on it). Fires two lifecycle POSTs; control-plane untouched.
- B: **Control-plane self-start only** (Option 2). Control-plane's `bin/control-plane.ts` checks for persisted `~/.vscode/cli/code_tunnel.json` + activation state on boot and starts both managers directly. Orchestrator untouched.
- C: **Both** — belt-and-suspenders. Adds explicit dedup so orchestrator's POST is a no-op if control-plane already started them.

**Answer**: *Pending*

### Q2: Failure independence — does tunnel failure block code-server (and vice versa)?
**Context**: The current `bootstrap-complete` handler (`packages/control-plane/src/routes/lifecycle.ts:189-201`) starts them independently: code-server via `manager.start().catch(() => {})` (fire-and-forget, silent swallow), tunnel via `await tunnelManager.start()` inside a `try {} catch {}`. Both are "best-effort" today. If the resume path lives on the orchestrator (Q1=A/C) and issues two separate HTTP POSTs, the plan needs to decide whether one 5xx aborts the other, or both run to completion regardless. This affects the SC-003 metric ("stop/start cycles that leave code-server unreachable — 0%") when tunnel-start fails first.
**Question**: When both services need resuming and one fails, what happens to the other?
**Options**:
- A: **Independent** — both POSTs fire (in parallel or sequentially), a failure in one does NOT prevent the other. Matches current `bootstrap-complete` handler's best-effort semantics and maximizes SC-002/SC-003 coverage.
- B: **Sequential with abort** — tunnel first; if it fails, skip code-server (or vice versa). Simpler failure surface but leaves the other service down when either fails.
- C: **Atomic** — either both succeed or the resume marks the cluster degraded. Loudest failure but couples two unrelated services.

**Answer**: *Pending*

### Q3: Failure surface — which relay channel and event carries a boot-resume failure?
**Context**: FR-007 says "surfaced (e.g., via a relay event) so the failure is observable" but leaves the channel/shape open. Existing patterns: (a) `cluster.vscode-tunnel` with `status: 'error'` — already emitted by `VsCodeTunnelProcessManager` on child-process failures, so tunnel-start failure is *already* observable there without any orchestrator work; (b) `cluster.bootstrap` — used by `PostActivationRetryService.handleRetryFailure()` for `status: 'failed', reason, error` on the sibling `needsRetry` path; (c) new dedicated channel like `cluster.resume`. Choice (a) means the orchestrator does nothing special (tunnel manager already emits) but requires cloud consumers to already interpret those events; choice (b) reuses the sibling pattern and gives operators a single "boot-time recovery failed" channel to watch.
**Question**: What relay channel + event shape should a boot-resume failure produce?
**Options**:
- A: **Rely on existing per-service events** — `cluster.vscode-tunnel { status: 'error', … }` and `cluster.code-server`-equivalent (or `codeServerReady: false` in metadata) are enough. Orchestrator only logs on POST failure; no dedicated resume event.
- B: **Reuse `cluster.bootstrap`** — orchestrator emits `{ status: 'failed', reason: 'resume-failed', service: 'vscode-tunnel' | 'code-server', error }` (mirrors `PostActivationRetryService.handleRetryFailure`). Operators watch one channel for both retry paths.
- C: **New `cluster.resume` channel** — dedicated to this feature; explicit "boot-time resume attempted / succeeded / failed" events.

**Answer**: *Pending*

### Q4: Retry semantics — is the boot-resume POST single-shot or retried on transient failure?
**Context**: The sibling `PostActivationRetryService.triggerPostActivationRetry()` waits up to 15 s for the control-plane socket via `probeControlPlaneSocket`, then issues a single POST to `/lifecycle/bootstrap-complete` with a 10 s request timeout, and on 5xx calls `handleRetryFailure` (degraded status + relay event). No retry loop. The resume path could either (a) mirror this — one shot, log-and-move-on — or (b) add exponential backoff, since a boot-time transient (control-plane still starting a second worker, brief socket unavailability) is more common than a real service failure and manual `POST /lifecycle/vscode-tunnel-start` is the only current recovery path. SC-001's <60 s target is more forgiving than a strict single-shot.
**Question**: How many attempts should the boot-resume POST make before giving up and surfacing failure?
**Options**:
- A: **Single-shot, mirror existing retry service** — 15 s socket wait + 1 POST attempt + 10 s request timeout; on failure log and emit the failure event (per Q3). Simplest, matches sibling code path.
- B: **Bounded retry with backoff** — e.g., up to 3 attempts with 2 s / 4 s / 8 s backoff; only surface failure if all attempts fail. Better transient-tolerance, more code.
- C: **Retry until success or process exit** — treat this like the identity-split / credential-expiry watchers; keep trying quietly in the background until the tunnel is up. Most forgiving, most complex, most opportunities for state drift.

**Answer**: *Pending*

### Q5: Startup ordering — fire resume before or after the relay bridge is up?
**Context**: The tunnel manager emits `cluster.vscode-tunnel { status: 'starting' | 'authorization_pending' | 'connected' }` events via `getRelayPushEvent()`; if the relay bridge hasn't started yet, those events are silently dropped (see `packages/control-plane/src/relay-events.ts`). In `server.ts`, `initializeRelayBridge()` runs *before* the existing `PostActivationRetryService` block (~L470) in the existing-key path, so the sibling retry already has a live relay when it fires. If Q1=A, the new resume trigger sits in the same block and inherits that ordering. If Q1=B, control-plane's boot happens independently of the orchestrator's relay bridge, so tunnel `starting`/`connected` events may fire before the orchestrator forwards them (relay bridge not up yet) — the initial tunnel-connect event could be lost from the cloud dashboard's perspective even though the tunnel is running. This affects US2 AC ("tunnel state transitions on restart drive the same `cluster.vscode-tunnel` relay events as first-boot start").
**Question**: When the resume fires, what ordering guarantees are required relative to the relay bridge coming up?
**Options**:
- A: **Must fire after relay bridge is initialized** — orchestrator-side resume (Q1=A/C) plugs in after `initializeRelayBridge()` returns, same as `PostActivationRetryService`. Guarantees `cluster.vscode-tunnel` events reach the cloud from the very first tunnel `starting` event.
- B: **No relay-bridge ordering guarantee** — resume fires whenever the process is ready (particularly Q1=B where control-plane's boot is independent). Accept that early tunnel events may be dropped; the eventual `connected`/`disconnected` transitions from the running child process still surface later, and cloud metadata refresh (periodic) still catches up.
- C: **Buffer events until relay is up** — if resume must fire before relay bridge, buffer emitted events and flush when the bridge connects. Adds complexity but preserves the first-boot event stream exactly.

**Answer**: *Pending*
