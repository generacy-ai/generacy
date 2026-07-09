# Clarifications

## Batch 1 — 2026-07-09

### Q1: Handler-side settlement cleanup scope
**Context**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:110-117` calls `phaseTracker.clear(owner, repo, issueNumber, DEDUP_PHASE)` at **five** terminal exit paths (added in #869 FR-006 as the settlement obligation paired with the monitor's `tryMarkProcessed`). Once the monitor stops writing the `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` key (FR-002), those handler clears become no-ops against a key nothing writes. FR-002 says "No settlement/clear-on-exit paths for that key remain" but names only `pr-feedback-monitor-service.ts` in FR-001/FR-002 file scope; FR-007 broadens to "no remaining `phase-tracker:*:address-pr-feedback` writes anywhere in the repo" and phrases the PhaseTracker follow-up as "no remaining callers for `address-pr-feedback`". Handler holds `DEDUP_PHASE = 'address-pr-feedback'` at line 19 and is one such caller.
**Question**: Does this PR also delete `pr-feedback-handler.ts`'s `clearDedupe`/`DEDUP_PHASE` (all 5 exit-path calls + the constant), or leave them as dead-code for a follow-up?
**Options**:
- A: Remove in this PR — handler was the settlement partner for a key nobody writes; retaining dead `phaseTracker.clear()` calls is exactly the "per-surface bookkeeping" FR-002 targets, and it satisfies FR-007's "no remaining callers for address-pr-feedback" in one shot.
- B: Leave in this PR — spec's Proposal names only the monitor as the migration site; handler cleanup ships in the follow-up that removes the class.

**Answer**: *Pending*

### Q2: `buildItemKey` granularity vs. cross-phase collision
**Context**: `buildItemKey` in `redis-queue-adapter.ts:65` and `in-memory-queue-adapter.ts:14` returns `${owner}/${repo}#${issueNumber}` — with **no** `command` component. The resume path enqueues `command: 'continue'` items; the label-monitor's process branch enqueues `command: 'process'`; PR-feedback wants to enqueue `command: 'address-pr-feedback'`. All three share one itemKey per issue. If a `continue` is already in-flight for issue N and PR feedback arrives on the linked PR, `enqueueIfAbsent` will return `false` and the `address-pr-feedback` item is silently dropped (fail-safe path in `redis-queue-adapter.ts:143`). Assumption 4 in the spec says "at the `<owner>:<repo>:<issue>` granularity (or equivalent) without collision against other phases" — but the current key **does** collide across commands.
**Question**: Is per-issue single-in-flight the intended semantics, or should `buildItemKey` be extended to include `command` so `address-pr-feedback` can co-exist with an in-flight `continue`/`process`?
**Options**:
- A: Keep per-issue single-in-flight (do not change `buildItemKey`) — one workflow item per issue at a time is the design; a PR-feedback trigger during an in-flight `continue`/`process` is dropped and re-detected on the next poll after the item completes. This is what "or equivalent" in Assumption 4 covers.
- B: Extend `buildItemKey` to include `command` — `address-pr-feedback` can enqueue concurrently with `continue`/`process` on the same issue. Also changes resume-path collision semantics.
- C: Something else — specify.

**Answer**: *Pending*

### Q3: `waiting-for:address-pr-feedback` label on dedupe rejection
**Context**: Current code at `pr-feedback-monitor-service.ts:381` adds the `waiting-for:address-pr-feedback` label **only after a successful new enqueue** (`isNew === true`). After migration, `enqueueIfAbsent` can return `false` because an item is already in-flight for this issue (webhook+poll race, or an in-flight `continue` if we pick Q2=A). The PR still has unresolved trusted feedback — the operator arguably wants the "waiting-for" label visible whenever that state holds, regardless of enqueue outcome. On the other hand, current behavior (skip label on dedupe rejection) is the only precedent, and the in-flight item that owns the feedback work will drive its own labels.
**Question**: When `enqueueIfAbsent` returns `false` because of an in-flight collision, should the `waiting-for:address-pr-feedback` label still be added idempotently?
**Options**:
- A: No — preserve current behavior; skip both enqueue and label on dedupe rejection. The in-flight item owns state.
- B: Yes — always add the label idempotently when unresolved trusted feedback is present, decoupling label state from enqueue outcome.

**Answer**: *Pending*

### Q4: `PhaseTracker` constructor dependency on the monitor
**Context**: After migration, `PrFeedbackMonitorService` no longer calls any `phaseTracker.*` method. The `PhaseTracker` is currently injected via its constructor and wired in `server.ts`. Leaving the field in place is dead DI but harmless; removing it changes the constructor signature and every test that stubs the monitor.
**Question**: Should the `PhaseTracker` constructor field/parameter be removed from `PrFeedbackMonitorService` in this PR?
**Options**:
- A: Remove — drop the constructor field, update `server.ts` wiring, update tests. No dead DI.
- B: Keep — leave the field/parameter for now; drop it in the follow-up that deletes `PhaseTracker` altogether.

**Answer**: *Pending*

### Q5: SC-004 grep audit reformulation
**Context**: SC-004 as written — `grep -R "phase-tracker" packages/orchestrator | grep address-pr-feedback` — passes **today** (0 matches). The literal string `phase-tracker` appears only in `phase-tracker-service.ts:37` (the key builder), never in callers. Callers reach the key indirectly via `phaseTracker.tryMarkProcessed(owner, repo, issueNumber, DEDUP_PHASE)`. The intent of SC-004 is clearly "no code path writes an `address-pr-feedback` phase-tracker key," but the literal grep can't detect that.
**Question**: How should SC-004 be reformulated so it actually detects the target?
**Options**:
- A: Broaden the grep — `grep -R -E "(tryMarkProcessed|markProcessed|phase-tracker)" packages/orchestrator | grep address-pr-feedback` returns 0 matches. (Catches API callers plus the raw string.)
- B: Replace with an AST/pattern check — assert `DEDUP_PHASE = 'address-pr-feedback'` and any `phaseTracker.tryMarkProcessed(..., 'address-pr-feedback')` calls are absent from `packages/orchestrator/src/**`.
- C: Leave SC-004 as-is (already passing at the string level) — treat it as satisfied and rely on Q1/FR-002 for the substantive check.

**Answer**: *Pending*
