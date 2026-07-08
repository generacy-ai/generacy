# Research: Pause-paired resume-dedupe clear

**Feature**: `849-found-during-cockpit-v1`
**Related**: [spec.md](./spec.md), [clarifications.md](./clarifications.md), [plan.md](./plan.md)

## Problem framing

`PhaseTrackerService` implements *cycle-scoped* dedupe with a *time-scoped* invalidation strategy. The two scopes don't line up:

- **Cycle**: a single pause → resume pair. Duplicate resume events *within one cycle* (double-clicked approval button, webhook + poll race, retry) should be deduped.
- **Time**: 24h TTL. If a legitimate second pause on the same `(issue, gate)` occurs *within* 24h, the residual key from the previous cycle blocks the second cycle's resume.

The `type === 'process'` path in `label-monitor-service.ts:278-280` already recognizes this mismatch and works around it by clearing the process-scoped dedupe before checking it. The `type === 'resume'` path does not, which is exactly the bug.

Two clear-shaped fixes were possible:

1. **Resume-check side** (mirror the existing `process` pattern): the `resume` branch of `processLabelEvent` also clears before checking.
2. **Pause side** (this spec's choice): clear the paired dedupe key at the moment of pause.

The spec §Summary chose Option 2. Q3 is agnostic on *how* to wire it but explicitly picks Option 2 as the direction. Rationale below.

## Decision: Pause-side clear (Option 2)

**Chosen**: pair the DEL with the pause lifecycle. `LabelManager.onGateHit` clears the paired `resume:<gate>` key after successful label-apply.

**Rejected: Resume-check-side clear (Option 1)** — mirrors the `process` pattern. Simpler code change (one line at `label-monitor-service.ts:277-282`), one file touched. **Why rejected**:
- Loses the paired-lifecycle *contract*: pause and resume become independently-scoped events again. If someone later changes the resume detection path (a new event source, a new label shape), the clear moves with the resume path and can silently break.
- Removes the *single-cycle* protection that the dedupe was designed to give: within one cycle, a duplicate resume trigger would clear the key and re-enqueue. The current `process` pattern accepts this trade-off because process events are inherently retry-safe (labels are removed after processing). Resume events are not retry-safe in the same way — a second enqueue of the same resume mid-cycle would spawn a duplicate worker.
- Q3 explicitly excludes this direction: "Not fixing the `type === 'process'` clear pattern at `label-monitor-service.ts:273-282` (already correct; only the resume side needs the paired clear)."

**Chosen** (Option 2): pair with pause.
- Preserves single-cycle dedupe (FR-008 / SC-003). Within one cycle, no fresh pause has fired → no clear has run → duplicate resumes are still deduped by the existing `isDuplicate()` check.
- Encodes the invariant *at the pause site*: any future pause path inherits the paired-clear by construction (or its absence becomes visible at review — see plan §Risk 1).
- Requires zero change to the resume path. The dedupe write on resume (`markProcessed` at `label-monitor-service.ts:339`) stays exactly as it is.

## Decision: DEL after label-apply success (Q1→A / FR-009)

**Chosen**: `retryWithBackoff(removeLabels + addLabels)` runs unchanged; DEL runs after the retry block returns success.

**Rejected: DEL first** — clears the stale dedupe before it can matter. **Why rejected**:
- Introduces a NEW failure mode: DEL succeeds, `addLabels` exhausts retries and throws, `waiting-for:<gate>` was never applied on GitHub. Now a stale `completed:<gate>` from the previous cycle can enqueue a resume for a pause that doesn't exist. The pre-fix behavior at least *stranded silently* — an operator could see the stuck state on GitHub. DEL-first *unstrand-with-ghost-resume* would spawn a worker for an invalid state.
- The dedupe key is cheap; the pause label is expensive (retries against GitHub, source-of-truth for the workflow state). Sequencing DEL after the expensive operation means the DEL is a downstream consequence of the pause, not a precondition.

**Rejected: DEL inside `retryWithBackoff`, both operations retried in lockstep** — DEL retries would delay the pause on Redis outages. **Why rejected**:
- FR-003 explicitly says DEL failure is swallowed at `warn`. Retrying inside `retryWithBackoff` would mean the DEL either (a) blocks pause success on Redis health, or (b) throws after retry exhaustion, causing pause to throw, which loses the pause labels on GitHub over a *Redis* problem. Neither is acceptable.
- Q2→A (below) makes this concrete: DEL is one-shot, absorbed by TTL if it fails.

**Chosen** (Q1→A): label-apply first, DEL after. Asymmetric partial failure. `addLabels` throws → DEL never runs → dedupe persists to TTL → pre-fix behavior for that one pause (annoying but known). DEL throws → pause labels are already applied → warn log fires → TTL absorbs the miss. Neither failure mode is new; both are pre-existing states this fix handles gracefully.

## Decision: DEL is one-shot best-effort (Q2→A / FR-010)

**Chosen**: single `phaseTracker.clear(...)` call; errors caught and logged at `warn`.

**Rejected: retry alongside label-op** — see Q1→A discussion; conflicts with FR-003.

**Rejected: one-shot with inline mini-retry (2 attempts, 100ms backoff)** — complexity purchasing almost nothing.
- The transient-Redis-blip window is short. A mini-retry converts "1 in N pauses fall back to TTL" into "1 in N² pauses fall back to TTL." N is small (Redis in-cluster, sub-ms typical), so the outcome is 1 in a very large number vs. 1 in a slightly larger number — both are dominated by the TTL backstop.
- Adds branching in the paired-clear code that must be tested, adds decisions ("what's the right backoff?") that must be defended in review.

**Chosen** (Q2→A): one-shot, best-effort. `PhaseTrackerService.clear()` already has its own internal try/catch → warn (phase-tracker-service.ts:74-78); the paired-clear's try/catch is defense-in-depth. Result: the DEL is *at most* one Redis round-trip, does not block pause success, and is fully covered by the FR-006 TTL backstop.

## Decision: Wiring via narrow callback (Q3→A)

**Chosen**: `clearResumeDedupe?: (gate: string) => Promise<void>` optional constructor arg on `LabelManager`. Worker (`claude-cli-worker.ts:406`) closes over `phaseTracker.clear(item.owner, item.repo, item.issueNumber, ` `resume:${gate}` `)`.

**Rejected: inject `PhaseTracker` into `LabelManager`** — simpler at the call site (`this.phaseTracker.clear(...)` in `onGateHit`), but drags a service dep into the label layer. **Why rejected**:
- `LabelManager` today has zero Redis / phase-tracker dependency (constructor: `GitHubClient`, `owner`, `repo`, `issueNumber`, `Logger`). Adding a `PhaseTracker` field would require every construction site — including the `label-manager.test.ts:21` helper — to supply a stub. It also couples `LabelManager` to the specific `PhaseTracker` interface shape, which is defined in the monitor package (`packages/orchestrator/src/types/monitor.ts:241`). Two abstractions the label layer doesn't need to know about.
- The whole `PhaseTracker` interface is 4 methods; `LabelManager` needs 1. Injecting the wide interface for the narrow use is API-inversion.

**Rejected: caller-side DEL** — invoke `phaseTracker.clear(...)` inside `phase-loop.ts` (or wherever `onGateHit` is invoked) *after* `onGateHit` returns. **Why rejected**:
- Splits the paired-lifecycle contract across two files. Future maintainers adding a new pause path can wire `LabelManager.onGateHit` without noticing that the DEL half sits elsewhere.
- Loses the observability guarantee: FR-011's info log has to live at the paired-clear site to be *informative* ("Cleared paired resume dedupe on pause" — the "on pause" is only true when we're at the pause site).

**Chosen** (Q3→A): narrow callback. `LabelManager` stays storage-agnostic; the worker closes over `phaseTracker.clear` at wiring time; test setups add an optional stub function. The invariant lives on `LabelManager.onGateHit` where any new pause path will discover it.

## Decision: Dedicated log lines on paired-clear (Q4→A / FR-011)

**Chosen**: `logger.info(...)` with fixed message text "Cleared paired resume dedupe on pause" on success, `logger.warn(...)` with the same fields plus `error` on swallow.

**Rejected: no dedicated log** — rely on existing `Gate hit: ...` line plus `PhaseTrackerService.clear()`'s internal `Cleared dedup key` info log. **Why rejected**:
- `PhaseTrackerService.clear()`'s log line says nothing about caller intent. Grepping for `Cleared dedup key` would surface every `process` clear too, and the `resume` clears from monitor path — non-diagnostic.
- SC-002 needs a mechanism-side signal (did the paired-clear run?), not a symptom-side signal (are operators still running `redis-cli DEL`?).

**Rejected: metric only** (counter increment, no log line). **Why rejected**:
- This repo doesn't have a shared metrics sink; adopting one for this fix expands scope.
- Log grep is the incumbent observability path for this codebase (see `Failed command`, `Gate hit`, `Duplicate event detected` patterns). Metric-only would be inconsistent.

**Chosen** (Q4→A): dedicated info + warn lines. Fields chosen for grep-ability by the `(owner, repo, issueNumber, gate)` tuple that operators use in `redis-cli DEL` today: `owner`, `repo`, `issueNumber`, `phase`, `gateLabel`. Message text "Cleared paired resume dedupe on pause" is unique enough for structured-log queries; "on pause" disambiguates from the `process` clear's `Cleared dedup key`.

## Implementation patterns referenced

- **`retryWithBackoff` around GitHub ops** (`label-manager.ts:241-269`) — 3 attempts, 1s/2s/4s delays. Existing pattern for GitHub API flakes. The paired-clear intentionally does NOT wrap in this — DEL is one-shot per FR-010.
- **`ensureCleanup` swallow-and-warn** (`label-manager.ts:202-223`) — the `try { ... } catch (error) { logger.warn({error: String(error), ...}, '...') }` pattern for non-fatal errors. The paired-clear's error-swallow mirrors this exact shape.
- **`processLabelEvent` clear-before-check** (`label-monitor-service.ts:278-280`) — the pre-existing `process` clear. The paired-clear is a lifecycle-symmetric complement to it: instead of clearing before the *check* on the resume side, we clear at the *pause* on the worker side. Two independent sites (FR-005).
- **`ClaudeCliWorkerDeps` optional-field pattern** (`claude-cli-worker.ts:107-114`) — existing precedent for feature-flagged worker capabilities (`jobEventEmitter`, `tokenProvider`). `phaseTracker` follows the same shape.
- **`PhaseTrackerService.clear()` no-throw contract** (`phase-tracker-service.ts:63-79`) — the internal try/catch guarantees `clear()` never rejects. Belt-and-suspenders: the caller-side try/catch in `onGateHit` still exists in case the callback is swapped for a different implementation later.

## Sources

- `packages/orchestrator/src/services/phase-tracker-service.ts` — dedupe key layout, TTL, clear/isDuplicate/markProcessed semantics
- `packages/orchestrator/src/services/label-monitor-service.ts:260-345` — `processLabelEvent`, the existing `process` clear pattern, `markProcessed` after enqueue
- `packages/orchestrator/src/worker/label-manager.ts:78-97` — `onGateHit`, the fix site
- `packages/orchestrator/src/worker/claude-cli-worker.ts:405-412` — `new LabelManager(...)` wiring
- `packages/orchestrator/src/server.ts:346-347` — full-mode `PhaseTrackerService` instantiation (mirrored by the worker-mode change)
- `packages/orchestrator/src/types/monitor.ts:241-251` — `PhaseTracker` interface
- Live incident: christrudelpw/sniplink#2 (cited in spec §Summary) — the operator-visible manifestation that motivated this fix
- Adjacent completed epics: #822, #841, #845, #847 — patterns for spec/plan/data-model/contracts shape and phase-loop test conventions
