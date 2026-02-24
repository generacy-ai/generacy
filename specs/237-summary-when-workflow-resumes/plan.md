# Implementation Plan: Add agent:in-progress Label on Workflow Resume

**Branch**: `237-summary-when-workflow-resumes` | **Date**: 2026-02-24 | **Status**: Ready for Implementation

## Summary

This plan addresses a label state machine gap where workflow resume events remove `agent:paused` but never add `agent:in-progress`, leaving issues without an agent status label during active execution. The fix is straightforward: add 2 lines to `LabelManager.onResumeStart()` and update 2 test cases to verify the new behavior.

**Current flow**: Resume → remove `agent:paused` and `waiting-for:*` → (no agent status) → phase starts
**Fixed flow**: Resume → remove `agent:paused` and `waiting-for:*` → add `agent:in-progress` → phase starts

## Technical Context

### Technology Stack
- **Language**: TypeScript
- **Framework**: Node.js worker service (orchestrator package)
- **Testing**: Vitest
- **GitHub Integration**: Custom GitHubClient wrapper using `gh` CLI
- **Logging**: Pino logger

### Key Components

1. **LabelManager** (`packages/orchestrator/src/worker/label-manager.ts`)
   - Manages all GitHub issue label transitions throughout workflow lifecycle
   - Uses `retryWithBackoff()` for resilient GitHub API calls (3 attempts, exponential backoff)
   - Enforces label state machine: `agent:in-progress` → phase labels → gates/completion/error

2. **Worker** (`packages/orchestrator/src/worker/claude-cli-worker.ts`)
   - Calls `labelManager.onResumeStart()` at line 259 when `item.command === 'continue'`
   - Call happens **before** the phase loop begins (line 257 comment confirms this)
   - Already integrated for feature #215 (added `onResumeStart()` to clean up gate labels)

3. **Label State Machine**
   - `process` event: `agent:in-progress` added immediately (label-monitor-service.ts:314)
   - `resume` event: `agent:in-progress` **missing** (this bug)
   - Phase execution: `phase:<name>` labels track progress
   - Gates: `waiting-for:*` + `agent:paused` labels
   - Completion: `agent:in-progress` removed
   - Error: `agent:error` replaces `agent:in-progress`

### Architecture Context

```
label-monitor-service.ts:processLabelEvent()
│
├── type === 'process'
│   └── Adds: ['agent:in-progress', 'workflow:*']
│   └── Removes: [trigger label, 'agent:error', 'completed:*']
│
└── type === 'resume'
    └── Enqueues worker item (label management deferred to worker)
        │
        └── claude-cli-worker.ts (line 259)
            └── labelManager.onResumeStart()  ← FIX HERE
                ├── Removes: ['waiting-for:*', 'agent:paused']
                └── ADD: ['agent:in-progress']  ← NEW
```

**Why fix in `onResumeStart()` instead of `processLabelEvent()`?**
- `onResumeStart()` already owns the paused → active state transition
- Keeps label removal and addition atomic within same `retryWithBackoff()` block
- Avoids race conditions between monitor service and worker
- Consistent with feature #215 design (comment at label-monitor-service.ts:324-326)

## Implementation Phases

### Phase 1: Update `LabelManager.onResumeStart()` method
**File**: `packages/orchestrator/src/worker/label-manager.ts`
**Lines**: 145-164

**Changes**:
1. After the label removal block (line 161), add label addition logic
2. Add info-level log message for observability
3. Call `addLabels()` with `['agent:in-progress']`

**Modified code** (lines 145-167):
```typescript
async onResumeStart(): Promise<void> {
  await this.retryWithBackoff(async () => {
    const issue = await this.github.getIssue(this.owner, this.repo, this.issueNumber);
    const currentLabels = issue.labels.map((l) =>
      typeof l === 'string' ? l : l.name,
    );

    const labelsToRemove = currentLabels.filter(
      (l) => l.startsWith('waiting-for:') || l === 'agent:paused',
    );

    if (labelsToRemove.length > 0) {
      this.logger.info(
        { labels: labelsToRemove, issue: this.issueNumber },
        'Resume: removing waiting-for and agent:paused labels',
      );
      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, labelsToRemove);
    }

    // Add agent:in-progress to reflect active workflow state
    this.logger.info(
      { issue: this.issueNumber },
      'Resume: adding agent:in-progress label',
    );
    await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress']);
  });
}
```

**Implementation notes**:
- Both `removeLabels` and `addLabels` wrapped in same `retryWithBackoff()` call ensures atomicity
- `addLabels()` is idempotent — adding an already-present label is safe (verified in GitHubClient)
- Log message format matches existing patterns (see `onPhaseStart()` line 45-48)
- Total addition: **4 lines** (comment, log, addLabels call)

### Phase 2: Update test suite
**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
**Lines**: 148-183

#### Change 2a: Update existing test to verify `addLabels` call
**Test**: `onResumeStart > removes waiting-for:* and agent:paused labels when present`
**Lines**: 149-167

**Current assertion** (line 162-166):
```typescript
expect(mockGithub.getIssue).toHaveBeenCalledWith('owner', 'repo', 42);
expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'waiting-for:clarification',
  'agent:paused',
]);
```

**Add new assertion** (after line 166):
```typescript
expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'agent:in-progress',
]);
```

#### Change 2b: Update edge case test for no stale labels
**Test**: `onResumeStart > does not call removeLabels when no stale labels exist`
**Lines**: 169-183

**Current behavior**: Test verifies `removeLabels` is NOT called when no stale labels exist
**New requirement**: Even when no stale labels exist, `agent:in-progress` should still be added

**Updated test logic**:
1. Keep existing mock setup (lines 170-177)
2. Keep existing assertion for `removeLabels.not.toHaveBeenCalled()` (line 182)
3. **Add new assertion** (after line 182):
```typescript
expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'agent:in-progress',
]);
```

**Rationale**: Edge case where labels were manually cleaned up but workflow is still resuming — `agent:in-progress` must be added to reflect active state.

### Phase 3: Verification
**Manual Testing Plan**:
1. Create test issue with `process:speckit-feature` label
2. Wait for workflow to hit clarification gate (adds `agent:paused`, `waiting-for:clarification`)
3. Provide clarification answers to trigger resume event
4. **Verify**: During plan/implement phases, issue shows `agent:in-progress` label
5. **Verify**: On completion, `agent:in-progress` is removed

**Unit Test Verification**:
```bash
cd packages/orchestrator
pnpm test -- label-manager.test.ts
```

**Expected output**:
- `✓ onResumeStart > removes waiting-for:* and agent:paused labels when present`
- `✓ onResumeStart > does not call removeLabels when no stale labels exist`
- All 20+ other tests pass (no regression)

## API Contracts

No API changes required. This fix uses existing `GitHubClient` methods:
- `addLabels(owner, repo, issueNumber, labels)` — already used throughout LabelManager
- Idempotent operation (safe to call multiple times with same label)

## Data Models

No schema changes. Uses existing label conventions:
- `agent:in-progress` — defined in label-monitor-service.ts constants
- Part of existing label state machine (already used for `process` events)

## Key Technical Decisions

| Decision | Rationale | Trade-offs |
|----------|-----------|------------|
| **D1: Add label in `onResumeStart()` instead of `processLabelEvent()`** | `onResumeStart()` already owns the paused → active transition. Keeps operations atomic within same retry block. Consistent with feature #215 design. | Could have added in monitor service (mirroring process event flow), but would create race condition with worker removing labels. |
| **D2: Add label unconditionally (not just when stale labels exist)** | Resume always means workflow is becoming active, regardless of prior label state. Handles edge case where labels were manually cleaned. Simpler logic. | Could check for `agent:paused` presence first, but unnecessary complexity. |
| **D3: Wrap removal and addition in same `retryWithBackoff()` call** | Ensures atomicity — both operations retry together if GitHub API fails. Avoids partial state (labels removed but not added). | Could have separate retry blocks, but reduces consistency guarantees. |
| **D4: Use info-level logging** | Matches existing log levels for label operations (see `onPhaseStart()`, `onGateHit()`). Critical for debugging label state issues. | No downside — info logs are standard for normal operations. |

### Alternative Considered: Add label in monitor service

```typescript
// label-monitor-service.ts:processLabelEvent() — REJECTED
if (type === 'resume') {
  await client.addLabels(owner, repo, issueNumber, ['agent:in-progress']);
}
```

**Why rejected**:
1. Creates race condition: Monitor service adds label → Worker removes stale labels → Worker might accidentally remove `agent:in-progress` if timing is unlucky
2. Violates separation of concerns: Feature #215 established that worker owns resume label management (comment at line 324-326)
3. Less atomic: Label addition happens separately from label removal, increasing window for inconsistent state

## Risk Mitigation

| Risk | Impact | Likelihood | Mitigation | Verification |
|------|--------|------------|------------|--------------|
| **R1: Race condition between removal and addition** | Medium — Issue shows no agent status briefly | Low | Both operations in same `retryWithBackoff()` block | Unit test mocks verify call order |
| **R2: GitHub API rate limiting** | Low — Extra API call per resume | Very Low | No new API calls added (addLabels batches labels). Retry logic already handles 503s. | Load testing on staging |
| **R3: Test flakiness from retry logic** | Low — Tests timeout or fail intermittently | Low | Existing tests already mock `sleep()` to bypass delays (see line 219, 263) | CI runs confirm stability |
| **R4: Regression in process event flow** | High — New issues don't get agent:in-progress | Very Low | Zero changes to process event path. Existing tests cover it. | Run full test suite |
| **R5: Label already exists (idempotency)** | None — GitHub API handles gracefully | Low | `addLabels()` in gh-cli.ts is idempotent (verified in GitHubClient implementation) | Manual testing edge case |
| **R6: Breaking change to label state machine** | Medium — Unexpected behavior in other components | Very Low | Adding `agent:in-progress` makes resume path consistent with process path (desired behavior) | Integration test on staging |

### Rollback Plan
If issues arise after deployment:
1. **Immediate**: Revert commit (single file change, easy rollback)
2. **Monitoring**: Watch for orphaned `agent:in-progress` labels (Grafana dashboard)
3. **Manual cleanup**: Script to remove stale labels if needed

## Success Criteria

| ID | Metric | Target | Measurement Method |
|----|--------|--------|-------------------|
| **SC-001** | Resume events add `agent:in-progress` | 100% | Manual test: trigger gate → resume → verify label during execution |
| **SC-002** | No regression in process events | 100% | Existing unit tests pass without modification (19 tests) |
| **SC-003** | `onResumeStart()` test coverage | 100% | New assertions verify `addLabels` called with correct arguments |
| **SC-004** | Label state consistency | 100% | Both process and resume paths show `agent:in-progress` before phase execution |
| **SC-005** | Production monitoring | 0 orphaned labels | Grafana query: issues with `agent:in-progress` but no active workflow job |

## Implementation Checklist

### Code Changes
- [ ] Modify `label-manager.ts:onResumeStart()` (lines 162-163)
  - [ ] Add comment explaining label addition
  - [ ] Add info log for label addition
  - [ ] Call `github.addLabels()` with `['agent:in-progress']`
- [ ] Update test: `removes waiting-for:* and agent:paused labels when present` (line ~166)
  - [ ] Add assertion verifying `addLabels` called with `['agent:in-progress']`
- [ ] Update test: `does not call removeLabels when no stale labels exist` (line ~182)
  - [ ] Add assertion verifying `addLabels` called even when no stale labels

### Testing
- [ ] Run unit tests: `pnpm test -- label-manager.test.ts`
- [ ] Verify 2 updated tests pass
- [ ] Verify all existing tests pass (no regression)
- [ ] Manual integration test:
  - [ ] Create test issue with workflow trigger
  - [ ] Wait for clarification gate
  - [ ] Provide clarification (triggers resume)
  - [ ] Verify `agent:in-progress` appears during plan phase
  - [ ] Verify label removed on completion

### Documentation
- [ ] Update spec.md status to "Implemented" when done
- [ ] Document decision rationale in commit message
- [ ] Add entry to CHANGELOG (if applicable)

### Deployment
- [ ] Create PR with changes (2 files modified)
- [ ] Verify CI/CD pipeline passes
- [ ] Deploy to staging environment
- [ ] Monitor Grafana for orphaned labels (24 hours)
- [ ] Deploy to production
- [ ] Verify on real issue (e.g., issue #235 or similar workflow)

## Files Modified

| File | Lines Changed | Change Type | Description |
|------|---------------|-------------|-------------|
| `packages/orchestrator/src/worker/label-manager.ts` | 162-167 | Addition (+4 lines) | Add `agent:in-progress` label in `onResumeStart()` |
| `packages/orchestrator/src/worker/__tests__/label-manager.test.ts` | 166-167, 182-183 | Addition (+2 assertions) | Update 2 tests to verify `addLabels` called |

**Total impact**: 2 files, +6 lines, 0 breaking changes

## Dependencies

**Internal**:
- `@generacy-ai/workflow-engine` — GitHubClient interface (no changes needed)

**External**:
- GitHub CLI (`gh`) — Label operations use existing commands (no version changes)

**Testing**:
- Vitest (existing setup, no new dependencies)

## Timeline Estimate

| Phase | Estimated Time | Notes |
|-------|----------------|-------|
| Phase 1: Update `onResumeStart()` | 5 minutes | Straightforward code addition |
| Phase 2: Update tests | 10 minutes | 2 simple assertion additions |
| Phase 3: Verification | 15 minutes | Run tests + manual integration test |
| PR review & merge | 30 minutes | Small change, fast review cycle |
| **Total** | **~1 hour** | Including testing and verification |

---

## Appendix: Label State Machine

### Complete State Machine (After Fix)

```
┌─────────────────────────────────────────────────────────┐
│                    Workflow Lifecycle                    │
└─────────────────────────────────────────────────────────┘

[Trigger Label Added]
        │
        ├── process event
        │   └── label-monitor-service adds 'agent:in-progress'
        │
        └── resume event
            └── worker.onResumeStart() adds 'agent:in-progress' ← FIX
        │
        ▼
[Phase Loop Begins]
        │
        ├── onPhaseStart('specify')
        │   └── adds 'phase:specify'
        │
        ├── onPhaseComplete('specify')
        │   └── adds 'completed:specify', removes 'phase:specify'
        │
        ├── [Gate Check: clarification needed?]
        │   └── YES → onGateHit('clarify', 'waiting-for:clarification')
        │       └── adds 'agent:paused', 'waiting-for:clarification'
        │       └── removes 'phase:clarify', 'completed:clarify'
        │       └── [Workflow Pauses]
        │           └── [Clarification Provided]
        │               └── resume event → onResumeStart()
        │                   └── removes 'agent:paused', 'waiting-for:*'
        │                   └── adds 'agent:in-progress' ← FIX
        │                   └── [Phase Loop Resumes]
        │
        ├── onPhaseStart('plan')
        │   └── adds 'phase:plan', removes 'phase:specify'
        │
        ├── ... (more phases)
        │
        ├── [Error during phase?]
        │   └── YES → onError(phase)
        │       └── adds 'agent:error'
        │       └── removes 'phase:<current>', 'agent:in-progress'
        │
        └── [All Phases Complete]
            └── onWorkflowComplete()
                └── removes 'agent:in-progress'
```

### Label Ownership Matrix

| Label Pattern | Added By | Removed By | Lifecycle |
|---------------|----------|------------|-----------|
| `agent:in-progress` | monitor service (process) OR worker (resume) | `onWorkflowComplete()`, `onError()` | Active execution |
| `agent:paused` | `onGateHit()` | `onResumeStart()` | Waiting for human input |
| `agent:error` | `onError()` | monitor service (next process event) | Workflow failed |
| `phase:<name>` | `onPhaseStart()` | `onPhaseComplete()`, `onGateHit()` | Current phase |
| `completed:<name>` | `onPhaseComplete()` | monitor service (next process event) | Phase finished |
| `waiting-for:<gate>` | `onGateHit()` | `onResumeStart()` | Paused at gate |
| `workflow:<name>` | monitor service (process event) | Never (permanent) | Workflow type |

---

*Generated by Claude Code on 2026-02-24*
