# Clarifications

## Batch 1 — 2026-07-08

### Q1: DEL / label-add ordering and partial-failure semantics
**Context**: FR-001–FR-003 anchor the fix at `LabelManager.onGateHit()` — apply `waiting-for:<gate>` **and** DEL the paired `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` key. FR-003 covers the "DEL fails" case (log warn, swallow, pause still succeeds). The reverse partial-failure — DEL succeeded, but `github.addLabels(waiting-for:<gate>)` fails after the retry budget — is unspecified. In that state we've cleared the dedupe key for a pause that never actually manifested on the issue; a stale resume label from an earlier cycle (or an operator re-adding `completed:<gate>` on the old pause) could now enqueue an unwanted resume until the workflow retries. The current `onGateHit()` wraps both `removeLabels` + `addLabels` in `retryWithBackoff` (label-manager.ts:78-97), so ordering the DEL relative to the retry block is a real design choice.
**Question**: In what order should the DEL and the `waiting-for:<gate>` label-apply run, and what should happen if `addLabels` fails after DEL succeeded?
**Options**:
- A: **Label-apply first, DEL after.** `retryWithBackoff` around the existing `removeLabels` + `addLabels` runs unchanged; DEL fires only after `addLabels` returns success. If `addLabels` exhausts retries and throws, DEL never runs — dedupe survives until TTL (fix reverts to backstop for that pause only). Matches FR-003's "pause labels are the source of truth" phrasing.
- B: **DEL first, then label-apply.** Clears the stale dedupe before it can matter. If `addLabels` then fails, dedupe is lost for that gate until the next pause attempt succeeds — a stray resume could enqueue in the interim.
- C: **DEL alongside label-apply, both inside the retry block.** DEL is retried in lockstep with label ops; but FR-003 says DEL failure is swallowed at warn, which conflicts with retrying it.

**Answer**: *Pending*

### Q2: DEL retry policy on transient Redis failure
**Context**: FR-003 says "If the Redis `DEL` fails (transient error, Redis down), the pause MUST still succeed — the failure is logged at `warn` and swallowed." Existing `PhaseTrackerService.clear()` behavior is single-shot best-effort. `LabelManager.onGateHit()` currently wraps GitHub API calls in `retryWithBackoff` for transient network flakes. The spec doesn't say whether the paired DEL gets the same retry treatment or is one-shot.
**Question**: Should the paired DEL be one-shot (best-effort, matches `PhaseTrackerService.clear()`) or share the label-op's `retryWithBackoff`?
**Options**:
- A: **One-shot, best-effort.** Single `phaseTracker.clear(...)` call; any error is caught and logged at `warn`. Simplest, matches existing `PhaseTrackerService.clear()` contract. If a transient Redis blip happens exactly at DEL time, the fix falls back to TTL for that one pause.
- B: **Retried alongside the label op** (inside `retryWithBackoff`). Higher chance the DEL lands, but conflicts with FR-003's "swallowed" phrasing and means a truly-down Redis blocks the pause via the retry budget.
- C: **One-shot with an inline mini-retry** (e.g., 2 attempts, short backoff), still swallowing terminal failure.

**Answer**: *Pending*

### Q3: Where the DEL capability is wired into `LabelManager`
**Context**: `LabelManager` today has zero Redis / `PhaseTrackerService` dependency (constructor: `GitHubClient`, `owner`, `repo`, `issueNumber`, `Logger` — label-manager.ts:15-22). The spec anchors the fix at `LabelManager.onGateHit()` but leaves the wiring open. `PhaseTrackerService` lives in `packages/orchestrator/src/services/`; `LabelManager` lives in `packages/orchestrator/src/worker/`. Introducing a direct `PhaseTrackerService` field changes the worker-layer's dep graph and test surface.
**Question**: How does `LabelManager.onGateHit()` obtain the DEL capability?
**Options**:
- A: **Inject a narrow callback** — e.g., `clearResumeDedupe?: (gate: string) => Promise<void>` — in the `LabelManager` constructor. Worker (`claude-cli-worker.ts:406`) closes over `phaseTracker.clear(owner, repo, issue, ` `resume:${gate}` `)`. `LabelManager` stays Redis-free; existing tests need only add an optional stub.
- B: **Inject `PhaseTrackerService`** directly into `LabelManager`. Simpler at the call site but drags a service dep into the label layer; test setups need a real/mocked `PhaseTrackerService`.
- C: **Move the DEL to the caller** (`phase-loop.ts` or wherever `onGateHit` is invoked). Keeps `LabelManager` unchanged, but splits the paired-lifecycle contract across two files — future maintainers can add a new pause path without noticing the DEL half.

**Answer**: *Pending*

### Q4: Observability — dedicated log line on paired-clear?
**Context**: SC-002 targets "0 manual `redis-cli DEL phase-tracker:…:resume:…` interventions" and proposes measurement via "search operator runbooks and support logs for the `redis-cli DEL phase-tracker:` command." That measures the *symptom*. If operators or a future incident want to confirm the paired-clear actually ran on a given pause, there's no signal today — `PhaseTrackerService.clear()` doesn't advertise the caller's intent.
**Question**: Should `LabelManager.onGateHit()` emit a dedicated log line (e.g., `info: "Cleared paired resume dedupe on pause: <gate>"` with `phase`, `gateLabel`, `issueNumber`) when the DEL runs?
**Options**:
- A: **Yes, dedicated info log** on every successful paired-clear, and a `warn` log on swallowed DEL failure. Cheap; makes SC-002 verifiable by log grep instead of runbook grep; matches the `logger.info(...)` cadence already present in `onGateHit`.
- B: **No dedicated log** — the paired-clear is an internal implementation detail; existing `Gate hit: ...` log line is enough. `PhaseTrackerService.clear()`'s own logging (if any) covers the rest.
- C: **Structured metric only** (counter increment on paired-clear success/failure), no log line. Higher-value for dashboards, but this repo doesn't have a shared metrics sink so this expands scope.

**Answer**: *Pending*
