# Research: PR-feedback migration to in-flight dedupe (#879)

## Decisions

### D1: Reuse `QueueManager.enqueueIfAbsent` — do not introduce a second dedupe layer

**Chosen**: The dedupe mechanism used by the resume path (post-#862) is `QueueManager.enqueueIfAbsent`, which is atomically checked against the in-flight `SET` via a Lua script in the Redis adapter. It's declared on the `QueueManager` interface (superset of `QueueAdapter`) at `packages/orchestrator/src/types/monitor.ts:232` and implemented in both `RedisQueueAdapter` and `InMemoryQueueAdapter`.

**Rationale**: The whole point of #862 was one dedupe mechanism across all enqueue surfaces. Introducing anything new (e.g., a distinct set for `address-pr-feedback` items) would re-fragment the state space and re-open the exact per-surface-settlement class of bugs #862 closed.

**Alternatives considered**:

- **Alt-A: Add a `command` component to `buildItemKey`** so `address-pr-feedback` items dedupe independently of `continue`/`process`. **Rejected** per clarification Q2→A. A second worker concurrently pushing feedback fixes to the same PR branch while `continue`/`process` is in flight is a race we deliberately do not create. Single-writer-per-issue matches #862's Q3 resolution.
- **Alt-B: Keep the phase-tracker key but shorten its TTL** to a value like 5m so stale keys clear on their own. **Rejected** — this is the same silent-strand failure mode with a tighter window. Still crash-shaped, still per-surface.
- **Alt-C: Add explicit `clear()` on handler start** (not just terminal exit). **Rejected** — same class of "per-surface settlement bookkeeping" this PR exists to remove.

### D2: Change field type on `PrFeedbackMonitorService` from `QueueAdapter` to `QueueManager`

**Chosen**: `QueueAdapter` (the base interface at `types/monitor.ts:175-177`) only exposes `enqueue()`. `QueueManager` (`types/monitor.ts:213-239`) extends it with `enqueueIfAbsent`, `hasInFlight`, `claim`, `release`, `complete`, and depth accessors. The monitor field must widen to `QueueManager` to call `enqueueIfAbsent`.

**Rationale**: `LabelMonitorService` already types the same field as `QueueManager` (its `enqueueIfAbsent` call at `label-monitor-service.ts:333` compiles today, confirming the wiring in `server.ts` provides a `QueueManager` in practice). This is a pure type-narrowing at the field level — no wiring change needed.

**Alternatives**:

- Add `enqueueIfAbsent` to `QueueAdapter`. **Rejected** — `QueueAdapter` is the smaller "producer" contract; `QueueManager` is the "coordinator" contract with lifecycle methods. Preserving the split matches the codebase's existing separation.

### D3: Add the `waiting-for` label **before** the enqueue call, not conditional on enqueue outcome

**Chosen**: Per clarification Q3→B, the label is added idempotently whenever trusted unresolved feedback is present, decoupled from the enqueue outcome. Move the `client.addLabels(...)` call from post-enqueue (`pr-feedback-monitor-service.ts:379-387`) to just after the Case A branch entry (after `lastZeroTrustedState.set(stateKey, false)` at line 332), before the `enqueueIfAbsent` call.

**Rationale**: Labels are the operator-facing state plane — cockpit `watch`/`status` render from them. If the enqueue drops because `continue`/`process` is already in flight for the same issue, the PR is still in a real "feedback pending" state and the label must reflect that or cockpit lies by omission. Combined with FR-009's info-log-on-drop, the operator sees: label present + repeating drop lines = feedback pending, blocked by in-flight item. This is exactly the diagnosable picture Q3 aims for.

**Alternatives**:

- **Alt-A (current behavior)**: Skip label on dedupe rejection. **Rejected** — the in-flight `continue` item doesn't add `waiting-for:address-pr-feedback`; nothing does. The label lies by omission for the duration of the in-flight item.

### D4: Convert `redis-queue-adapter.ts:140-146` (and in-memory parity) from silent/warn drop to structured `info` on the `false`-return path

**Chosen**: On `enqueueIfAbsent → false` (in-flight collision, non-error path), emit `logger.info({ itemKey, reason: 'in-flight' }, 'Dropping enqueue (item already in flight)')`. The Redis-error path (where the current `warn` sits) keeps `warn` — those are two distinct signals.

**Rationale**: Per clarification Q2→A and FR-009: a *repeating* info-log line at poll cadence is the operator's stuck-worker signal for the deferred-not-lost drop window. Silence turns Q2's dropped-then-re-detected pattern into an invisible failure mode. `info` (not `debug`) is correct because it's the visible signal we want operators to be able to grep for in normal logs; it's not a warning because the drop is by design.

**Alternatives**:

- Log at `debug`. **Rejected** — invisible in normal ops logs.
- Log at `warn`. **Rejected** — this is the designed path, not an anomaly; would train operators to ignore.

### D5: Delete `PhaseTracker` from `PrFeedbackHandler` in the same PR (per Q1→A)

**Chosen**: Remove `DEDUP_PHASE` constant (`pr-feedback-handler.ts:19`), the `clearDedupe` closure (`:110-117`), and all five `clearDedupe()` call sites (`:259`, `:289`, `:370`, `:376`, `:383`). Drop the `phaseTracker` ctor param. Update `claude-cli-worker.ts` construction.

**Rationale**: The handler was the settlement partner for a key the monitor stops writing. Retaining `phaseTracker.clear(...)` calls against a key nothing writes is exactly the "per-surface bookkeeping" FR-002 targets. FR-007's "no remaining callers for `address-pr-feedback`" is not satisfiable while these calls remain — B (defer) turns an optional follow-up into a mandatory one.

**Alternatives**:

- **Defer to follow-up**. **Rejected** per Q1→A. Deferral costs a second churn round on the same file.

### D6: Reformulate SC-004 as a code-audit test in the `trust-predicate-audit.test.ts` shape

**Chosen**: Add a new audit test file at `packages/orchestrator/src/__tests__/phase-tracker-audit.test.ts` that asserts:

1. `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — string `PhaseTracker` absent (identifier check, not literal grep of `phase-tracker`).
2. `packages/orchestrator/src/worker/pr-feedback-handler.ts` — same.
3. Under `packages/orchestrator/src/**`, no `DEDUP_PHASE` declaration remains.

**Rationale**: Per clarification Q5→B. The original SC-004 grep (`grep phase-tracker | grep address-pr-feedback`) passes **today** with 0 matches because callers reference the key indirectly via `phaseTracker.tryMarkProcessed(..., DEDUP_PHASE)` — the `phase-tracker` string only lives in the key-builder. Broadened grep (option A) has the same line-level co-occurrence flaw (`DEDUP_PHASE = 'address-pr-feedback'` and the `tryMarkProcessed` call are on separate lines). Plain string absence for `'address-pr-feedback'` can't work either — it legitimately survives as the `queueItem.command` value. The audit-test shape is the only formulation that composes cleanly with Q1→A + Q4→A.

**Alternatives** — see clarification Q5 for the full comparison; A and C both false-pass on the current codebase.

### D7: Preserve `#869` zero-trusted guard exactly — do not touch the shared predicate

**Chosen**: All changes to the zero-trusted branch (`pr-feedback-monitor-service.ts:295-323`) are limited to reordering label-add position. The trust classification (`isTrustedCommentAuthor`), the `maybePostUntrustedNotice` idempotent posting, and the `lastZeroTrustedState` transition-edge tracking are unchanged.

**Rationale**: Without this guard, self-clearing in-flight dedupe would busy-loop: zero-trusted PR enqueues → handler completes without settling anything → next poll re-enqueues. SC-005 is the regression fence. Spec Assumption 2 codifies this.

## Implementation Patterns

### Reference: label-monitor resume branch (`services/label-monitor-service.ts:332-356`)

This is the shape to copy verbatim:

```typescript
const enqueued = await this.queueManager.enqueueIfAbsent(queueItem);
if (!enqueued) {
  this.logger.info(
    {
      itemKey: `${owner}/${repo}#${issueNumber}`,
      gate: parsedName,
      reason: 'in-flight',
      source,
      owner,
      repo,
      issueNumber,
    },
    'Dropping resume event (item already in flight)',
  );
  return false;
}
```

For PR-feedback, `gate` becomes irrelevant (there's no gate label being resumed); `source` is `'webhook' | 'poll'` from `PrReviewEvent.source`. Everything else is a direct port.

### Idempotent label addition

`client.addLabels(...)` in the `gh-cli` GitHub client wraps `gh issue edit --add-label`, which is idempotent server-side (adding a label that's already present is a no-op that returns success). Reordering the call to precede `enqueueIfAbsent` requires no client-side idempotency work — the existing try/catch with warn-log-on-failure stays.

### Test fixture: use `InMemoryQueueAdapter` directly, not a mock

Existing tests hand-mock `phaseTracker`. For the migration, prefer instantiating a real `InMemoryQueueAdapter` in tests and asserting queue depth / in-flight state directly. This gives real semantics for SC-001/SC-002/SC-003 without hand-wiring a fake, and avoids the fragility of asserting against Lua-script-shaped mocks.

## Sources / References

- **#862 spec + PR**: `specs/862-found-during-cockpit-v1/` — introduced `enqueueIfAbsent` on the resume path. Q3 there codifies single-writer-per-issue itemKey semantics.
- **#869 spec + PR**: `specs/869-found-during-cockpit-v1/` — introduced the zero-trusted guard (FR-002/FR-003/FR-004) and the handler-side FR-006 settlement clears we now delete.
- **`packages/orchestrator/src/services/label-monitor-service.ts:332-356`** — reference implementation of the target pattern.
- **`packages/orchestrator/src/services/redis-queue-adapter.ts:22-30` (Lua), `:65-67` (`buildItemKey`), `:113-147` (`enqueueIfAbsent`)** — adapter contract.
- **`packages/orchestrator/src/services/in-memory-queue-adapter.ts:14, 82-105`** — in-memory parity.
- **`packages/orchestrator/src/__tests__/trust-predicate-audit.test.ts`** — audit-test shape reference for SC-004.
- **`packages/orchestrator/src/types/monitor.ts:175-239, 265-275`** — `QueueAdapter` / `QueueManager` / `PhaseTracker` interfaces.
- **Clarifications**: `specs/879-found-during-cockpit-v1/clarifications.md` (Q1→A, Q2→A, Q3→B, Q4→A, Q5→B).
