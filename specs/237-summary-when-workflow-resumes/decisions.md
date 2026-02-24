# Architectural Decision Record (ADR)

**Feature**: 237-summary-when-workflow-resumes
**Date**: 2026-02-24
**Status**: Accepted

## Context

Workflows can pause at gates (e.g., clarification, tasks-review) and resume when human input is provided. The label state machine correctly adds `agent:in-progress` for process events but not for resume events, creating inconsistent visibility into workflow state.

**Current behavior**:
- Process event: `agent:in-progress` added by monitor service
- Resume event: `agent:paused` removed, but no `agent:in-progress` added

**Problem**: Users can't tell if a workflow is actively running after a resume event.

---

## Decision 1: Where to Add the Label

### Options Considered

#### Option A: Add in Monitor Service (Rejected)
**Location**: `label-monitor-service.ts:processLabelEvent()`

**Pros**:
- Mirrors process event logic (lines 313-316)
- Centralizes label addition in one place
- Simpler: no worker changes needed

**Cons**:
- Creates race condition with worker's `onResumeStart()`
- Worker removes stale labels → Monitor adds `agent:in-progress` → Timing-dependent
- Violates separation of concerns established in feature #215
- Comment at line 324-326 explicitly defers resume label management to worker

**Analysis**:
```typescript
// monitor service adds label
await client.addLabels(owner, repo, issueNumber, ['agent:in-progress']);

// ... worker starts processing ...

// worker removes stale labels (race condition!)
await this.github.removeLabels(owner, repo, issueNumber, labelsToRemove);
```

If `labelsToRemove` filter is too broad, it might accidentally remove the just-added `agent:in-progress`.

#### Option B: Add in Worker's `onResumeStart()` (ACCEPTED)
**Location**: `label-manager.ts:onResumeStart()`

**Pros**:
- ✅ `onResumeStart()` already owns the paused → active transition
- ✅ Atomic operation: removal and addition in same `retryWithBackoff()` block
- ✅ Consistent with feature #215 design philosophy
- ✅ No race conditions: both operations in same place
- ✅ Worker controls timing (after stale label removal, before phase loop)

**Cons**:
- Slightly less obvious when reading monitor service code
- Worker now has two responsibilities (remove stale + add status)

**Analysis**:
```typescript
await this.retryWithBackoff(async () => {
  // 1. Remove stale labels
  await this.github.removeLabels(/* ... */);

  // 2. Add status label (atomic with removal)
  await this.github.addLabels(/* ... */, ['agent:in-progress']);
});
```

Both operations retry together. No race condition window.

### Decision
**ACCEPTED: Option B** — Add label in `LabelManager.onResumeStart()`

**Rationale**:
1. Atomicity: Both label operations in same retry block
2. Consistency: Feature #215 established worker owns resume label management
3. Safety: No race condition between monitor and worker
4. Ownership: `onResumeStart()` semantically represents the transition to active state

---

## Decision 2: Conditional vs. Unconditional Label Addition

### Options Considered

#### Option A: Only Add If Stale Labels Existed (Rejected)
```typescript
if (labelsToRemove.length > 0) {
  await this.github.removeLabels(/* ... */);
  await this.github.addLabels(/* ... */, ['agent:in-progress']);
}
```

**Pros**:
- Symmetric: only add label if we removed labels
- Fewer API calls when no stale labels

**Cons**:
- Doesn't handle edge case: manual label cleanup before resume
- More complex logic: couples addition to removal
- Inconsistent: process events always add label unconditionally

#### Option B: Always Add Label (ACCEPTED)
```typescript
if (labelsToRemove.length > 0) {
  await this.github.removeLabels(/* ... */);
}
// Always add, regardless of removal
await this.github.addLabels(/* ... */, ['agent:in-progress']);
```

**Pros**:
- ✅ Handles edge case: resume after manual label cleanup
- ✅ Simpler logic: addition independent of removal
- ✅ Idempotent: safe to add already-present label
- ✅ Consistent: resume always means "now active"

**Cons**:
- Extra API call if label already exists (mitigated by idempotency)

### Decision
**ACCEPTED: Option B** — Always add label unconditionally

**Rationale**:
1. Correctness: Resume always transitions to active state (semantic meaning)
2. Robustness: Handles edge case where labels manually cleaned
3. Simplicity: Decouples addition from removal (easier to reason about)
4. Safety: `addLabels()` is idempotent (no harm if label already present)

**Edge case handled**:
```
User manually removes agent:paused → Resume event →
Worker's onResumeStart() still adds agent:in-progress ✅
```

---

## Decision 3: Single vs. Separate Retry Blocks

### Options Considered

#### Option A: Separate Retry Blocks (Rejected)
```typescript
// Remove stale labels
await this.retryWithBackoff(async () => {
  await this.github.removeLabels(/* ... */);
});

// Add status label (separate retry)
await this.retryWithBackoff(async () => {
  await this.github.addLabels(/* ... */);
});
```

**Pros**:
- Independent failure handling for each operation
- Can retry each operation with different strategies

**Cons**:
- Less atomic: partial failure leaves issue with no agent status
- More complex error handling: what if first succeeds, second fails?
- Inconsistent with existing patterns (`onPhaseComplete`, `onGateHit`)

**Failure scenario**:
```
Block 1: removeLabels() → ✅ Success
Block 2: addLabels() → ❌ Fails after 3 retries → throws

Result: Issue has NO agent status label (worse than original bug!)
```

#### Option B: Single Retry Block (ACCEPTED)
```typescript
await this.retryWithBackoff(async () => {
  await this.github.removeLabels(/* ... */);
  await this.github.addLabels(/* ... */);
});
```

**Pros**:
- ✅ Atomic: both operations succeed or both retry
- ✅ Simpler error handling: single failure mode
- ✅ Consistent with existing patterns (3 other methods use this)
- ✅ Idempotency ensures correctness on retry

**Cons**:
- If removal succeeds but addition fails, removal is retried unnecessarily
  (mitigated: removal is idempotent, so retry is a no-op)

### Decision
**ACCEPTED: Option B** — Single `retryWithBackoff()` block

**Rationale**:
1. Atomicity: Both operations retry as a unit → consistent final state
2. Patterns: Matches `onPhaseComplete()`, `onGateHit()`, `onError()`
3. Safety: Idempotency of both operations ensures correctness on retry
4. Simplicity: Single failure path, easier to debug

**Retry behavior verified in existing test** (`label-manager.test.ts:292-308`):
```typescript
it('succeeds on second attempt after first addLabels call throws', async () => {
  mockGithub.addLabels
    .mockRejectedValueOnce(new Error('GitHub API 503'))
    .mockResolvedValueOnce(undefined);

  await lm.onPhaseComplete('plan');

  expect(mockGithub.addLabels).toHaveBeenCalledTimes(2);
  expect(mockGithub.removeLabels).toHaveBeenCalledTimes(2);  // ← Both retry!
});
```

---

## Decision 4: Log Level for Label Addition

### Options Considered

#### Option A: Debug Level (Rejected)
```typescript
this.logger.debug({ issue: this.issueNumber }, 'Resume: adding agent:in-progress label');
```

**Pros**:
- Less log volume in production
- Matches typical "verbose detail" usage

**Cons**:
- Inconsistent with other label operations (all use `info`)
- Harder to debug label state issues in production
- Label transitions are operationally significant (not debug detail)

#### Option B: Info Level (ACCEPTED)
```typescript
this.logger.info({ issue: this.issueNumber }, 'Resume: adding agent:in-progress label');
```

**Pros**:
- ✅ Consistent with other label operations (`onPhaseStart`, `onGateHit`, etc.)
- ✅ Operationally significant: label state drives workflow visibility
- ✅ Easier debugging: always visible in production logs

**Cons**:
- Slightly higher log volume (mitigated: label transitions are infrequent)

### Decision
**ACCEPTED: Option B** — Use `info` level logging

**Rationale**:
1. Consistency: All label operations in `LabelManager` use `info` level
2. Operational significance: Label state affects user-visible workflow status
3. Debuggability: Critical for diagnosing label state issues in production

**Examples from codebase**:
- `onPhaseStart()` line 45: `info` level
- `onGateHit()` line 83: `info` level
- `onResumeStart()` line 157 (removal): `info` level

---

## Decision 5: Test Strategy

### Options Considered

#### Option A: Add New Test Cases (Rejected)
Create new test cases:
- `onResumeStart > adds agent:in-progress when stale labels exist`
- `onResumeStart > adds agent:in-progress when no stale labels exist`

**Pros**:
- Clearer separation of concerns (removal vs. addition)
- More granular test coverage

**Cons**:
- Duplicates existing test setup/structure
- More test maintenance burden
- Existing tests already verify the full flow

#### Option B: Update Existing Test Cases (ACCEPTED)
Add assertions to existing tests:
- Test 1: Verify `addLabels` called (with stale labels)
- Test 2: Verify `addLabels` called (without stale labels)

**Pros**:
- ✅ Minimal changes: +2 assertions (one per test)
- ✅ Tests full flow: removal + addition
- ✅ Easier to maintain: fewer test cases
- ✅ Consistent with test structure (tests already verify removal)

**Cons**:
- Each test verifies multiple behaviors (less granular)

### Decision
**ACCEPTED: Option B** — Update existing test cases

**Rationale**:
1. Minimal impact: Only 2 new assertions needed
2. Completeness: Verifies full `onResumeStart()` behavior in one test
3. Maintainability: Fewer tests to maintain
4. Coverage: Both edge cases covered (with/without stale labels)

---

## Cross-Cutting Concerns

### Idempotency

**Design principle**: All label operations must be idempotent (safe to retry)

**Evidence**:
- `removeLabels()`: Silently ignores already-absent labels (verified in `gh-cli.ts`)
- `addLabels()`: GitHub API silently ignores already-present labels
- Comment in `label-manager.ts:173-176` documents this guarantee

**Implication for our fix**: Retry logic can safely re-execute both operations without side effects.

### Retry Strategy

**Current implementation**: 3 attempts with exponential backoff (1s, 2s, 4s)

**Analysis**:
- Sufficient for transient GitHub API failures (503, network errors)
- Final attempt throws error (workflow fails visibly, not silently)
- Existing tests mock `sleep()` to avoid timing dependencies

**Implication for our fix**: No changes needed to retry strategy. Existing behavior covers our use case.

### Performance

**API calls added**: 1 additional `addLabels()` call per resume event

**Impact analysis**:
- Resume events are infrequent (~1-5 per workflow run)
- `addLabels()` batches multiple labels (no extra network round-trip)
- GitHub API rate limit: 5000 req/hour (our addition is negligible)

**Conclusion**: Performance impact is negligible.

---

## Alternatives Rejected

### Alternative 1: Label Replacement API
Create a custom `replaceLabels()` method that atomically replaces labels in one call.

**Rejected because**:
- Over-engineering for a simple fix
- GitHub API doesn't have native label replacement
- Would require custom implementation (more code, more risk)
- Existing `removeLabels` + `addLabels` pattern is well-tested

### Alternative 2: State Machine Refactor
Refactor entire label state machine into a formal state machine class with transitions.

**Rejected because**:
- Out of scope for this bug fix
- Would require extensive refactoring (high risk)
- Current pattern is working well (just missing one transition)
- Future improvement, not a blocker for this fix

### Alternative 3: Configuration-Based Labels
Make label state machine configurable via JSON/YAML config files.

**Rejected because**:
- Over-engineering for current requirements
- No evidence of frequent label state changes
- Adds complexity without clear benefit
- Hard-coded labels are easier to grep/understand

---

## Consequences

### Positive
✅ Resume events now consistent with process events
✅ Users can reliably track workflow state at all times
✅ Label state machine is complete (no gaps)
✅ Fix is minimal, low-risk, and follows existing patterns

### Negative
⚠️ Slightly higher log volume (one extra log line per resume)
⚠️ One additional GitHub API call per resume (negligible)

### Neutral
- Worker now has two responsibilities in `onResumeStart()` (remove + add)
- Test suite slightly longer (2 more assertions)

---

## Future Considerations

### Monitoring
Add Grafana dashboard to track label state metrics:
- Count of issues with `agent:in-progress` (should match active workflows)
- Duration issues spend in each agent state
- Alert on orphaned `agent:in-progress` labels (indicates label cleanup failure)

### Validation
Add integration test to CI/CD pipeline:
- Automatically verify label transitions on test issues
- Catch regressions before production deployment

### Documentation
Update architecture docs to document complete label state machine:
- All label types and their meanings
- State transition diagram
- Ownership (who adds/removes each label type)

---

## References

- **Feature #215**: Added `onResumeStart()` method for gate label cleanup
- **Issue #235**: Real-world example of label state gap (triggered this fix)
- **label-monitor-service.ts:324-326**: Comment deferring resume label management to worker
- **label-manager.ts:173-176**: Idempotency documentation
- **label-manager.test.ts:292-308**: Retry behavior validation

---

## Approval

**Decision Made By**: Claude Code (Architectural Analysis Agent)
**Date**: 2026-02-24
**Status**: Ready for Implementation

**Review Notes**:
- Decisions follow principle of least surprise
- Consistent with existing codebase patterns
- Risk level: LOW
- Rollback: Simple (single commit revert)

---

*ADR created by Claude Code on 2026-02-24*
