# Implementation Plan: Fix Orchestrator Resume Flow

**Branch**: `215-summary-when-orchestrator` | **Date**: 2026-02-21

## Summary

Three interacting bugs prevent the orchestrator from resuming correctly after `completed:clarification` is added to an issue. This plan fixes all three by:

1. Adding a persistent `workflow:` label applied on `process:` events, so resume events resolve the correct `workflowName`
2. Moving `waiting-for:` label removal from the label monitor to the worker, eliminating the race condition
3. Introducing a unified `GATE_MAPPING` that maps gate names to both their owning phase and the resume-from phase, replacing the fragmented `reviewToPhase` map

## Technical Context

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **Packages**: `packages/orchestrator`, `packages/workflow-engine`
- **Test framework**: Vitest (globals, node environment)
- **Key patterns**: Class-based services with constructor injection, Zod schemas for config

## Architecture Overview

```
Label Monitor                    Worker (ClaudeCliWorker)
  │                                │
  ├── parseLabelEvent()            ├── getIssue() → labels
  │   └── includes issueLabels     │
  ├── processLabelEvent()          ├── phaseResolver.resolveStartPhase()
  │   ├── resolveWorkflowFromLabels│   ├── resolveFromContinue()
  │   │   (reads workflow:* label) │   │   └── uses GATE_MAPPING
  │   ├── enqueue(QueueItem)       │   └── resolveFromProcess()
  │   └── apply workflow: label    │       └── uses GATE_MAPPING
  │       on process events        │
  │                                ├── labelManager.onResumeStart()  ← NEW
  │   (NO waiting-for: removal)    │   └── removes waiting-for: + agent:paused
  │                                │
  │                                └── phaseLoop.executeLoop()
  │                                    └── gateChecker.checkGate(workflowName)
```

## Implementation Phases

### Phase 1: Add `workflow:` labels to label definitions

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

Add two new labels to `WORKFLOW_LABELS` after the process trigger labels (after line 75):

```typescript
// Workflow identity labels (persist for issue lifetime)
{ name: 'workflow:speckit-feature', color: '6F42C1', description: 'Speckit feature workflow' },
{ name: 'workflow:speckit-bugfix', color: '6F42C1', description: 'Speckit bugfix workflow' },
```

Color `6F42C1` (purple) — implementer's choice per Q7.

---

### Phase 2: Add `issueLabels` to `LabelEvent` interface

**File**: `packages/orchestrator/src/types/monitor.ts` (line 100-115)

Add `issueLabels` field to the `LabelEvent` interface:

```typescript
export interface LabelEvent {
  type: 'process' | 'resume';
  owner: string;
  repo: string;
  issueNumber: number;
  labelName: string;
  parsedName: string;
  source: 'webhook' | 'poll';
  issueLabels: string[];  // All labels on the issue at detection time
}
```

This is a non-breaking additive change. Both callers (webhook route at `routes/webhooks.ts:97-105` and smee receiver at `services/smee-receiver.ts:204-212`) already have `issueLabels` available and pass it to `parseLabelEvent`.

---

### Phase 3: Fix label monitor — workflow resolution, `workflow:` label, and `waiting-for:` removal

**File**: `packages/orchestrator/src/services/label-monitor-service.ts`

**Change A** — Include `issueLabels` in returned `LabelEvent` from `parseLabelEvent()`:

In both return branches of `parseLabelEvent()` (lines 117-125 for `process`, lines 136-144 for `resume`), add `issueLabels` to the returned object:

```typescript
// Process event return (line 117):
return {
  type: 'process',
  owner, repo, issueNumber, labelName,
  parsedName: workflowName,
  source,
  issueLabels,  // NEW
};

// Resume event return (line 137):
return {
  type: 'resume',
  owner, repo, issueNumber, labelName,
  parsedName: phaseName,
  source,
  issueLabels,  // NEW
};
```

**Change B** — Add `resolveWorkflowFromLabels()` private helper:

```typescript
/**
 * Resolve workflow name from a workflow:* label on the issue.
 * Falls back to 'speckit-feature' for backward compatibility.
 */
private resolveWorkflowFromLabels(issueLabels: string[]): string {
  const WORKFLOW_LABEL_PREFIX = 'workflow:';
  const workflowLabel = issueLabels.find(l => l.startsWith(WORKFLOW_LABEL_PREFIX));
  if (workflowLabel) {
    return workflowLabel.slice(WORKFLOW_LABEL_PREFIX.length);
  }
  return 'speckit-feature';
}
```

**Change C** — Use resolved workflow name in `processLabelEvent()` (around lines 186-195):

```typescript
// Resolve workflow name: for process events, use parsedName directly;
// for resume events, read the workflow:* label from the issue.
const workflowName = type === 'resume'
  ? this.resolveWorkflowFromLabels(event.issueLabels)
  : parsedName;

if (type === 'resume' && !event.issueLabels.some(l => l.startsWith('workflow:'))) {
  this.logger.warn(
    { owner, repo, issueNumber, defaultedTo: 'speckit-feature' },
    'No workflow: label found on issue, defaulting to speckit-feature',
  );
}

const queueItem: QueueItem = {
  owner, repo, issueNumber,
  workflowName,  // Now correct for both process and resume
  command: type === 'process' ? 'process' : 'continue',
  priority: Date.now(),
  enqueuedAt: new Date().toISOString(),
};
```

**Change D** — Apply `workflow:` label on `process:` events (line ~222):

```typescript
// Current:
await client.addLabels(owner, repo, issueNumber, [AGENT_IN_PROGRESS_LABEL]);

// New:
await client.addLabels(owner, repo, issueNumber, [
  AGENT_IN_PROGRESS_LABEL,
  `workflow:${parsedName}`,
]);
```

**Change E** — Remove the `waiting-for:` label removal on resume events (lines 229-239):

Delete the entire `else if (type === 'resume')` block. The worker will now handle this removal.

---

### Phase 4: Add unified `GATE_MAPPING` and rewrite phase resolver

**File**: `packages/orchestrator/src/worker/phase-resolver.ts`

**Change A** — Add exported `GATE_MAPPING` constant:

```typescript
/**
 * Unified mapping from gate names to phase information.
 * - phase: the workflow phase this gate belongs to (for resolveFromProcess normalization)
 * - resumeFrom: the phase to start from when the gate is satisfied (for resolveFromContinue)
 */
export const GATE_MAPPING: Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }> = {
  'clarification':          { phase: 'clarify',    resumeFrom: 'plan' },
  'spec-review':            { phase: 'specify',    resumeFrom: 'clarify' },
  'clarification-review':   { phase: 'clarify',    resumeFrom: 'plan' },
  'plan-review':            { phase: 'plan',       resumeFrom: 'tasks' },
  'tasks-review':           { phase: 'tasks',      resumeFrom: 'implement' },
  'implementation-review':  { phase: 'implement',  resumeFrom: 'validate' },
  'manual-validation':      { phase: 'validate',   resumeFrom: 'validate' },
};
```

**Change B** — Rewrite `resolveFromContinue()`:

No longer depends on `waiting-for:*` labels. Uses `GATE_MAPPING` + `completed:*` labels. Iterates latest-phase-first so the most advanced gate wins.

```typescript
private resolveFromContinue(labels: string[]): WorkflowPhase {
  const completedSet = new Set<string>();
  for (const label of labels) {
    if (label.startsWith('completed:')) {
      completedSet.add(label.slice('completed:'.length));
    }
  }

  // Find the most advanced gate that was completed.
  for (let i = PHASE_SEQUENCE.length - 1; i >= 0; i--) {
    for (const [gateName, mapping] of Object.entries(GATE_MAPPING)) {
      if (mapping.phase === PHASE_SEQUENCE[i] && completedSet.has(gateName)) {
        return mapping.resumeFrom;
      }
    }
  }

  // Fallback: use the process resolver
  return this.resolveFromProcess(labels);
}
```

**Change C** — Update `resolveFromProcess()` to normalize gate names:

```typescript
private resolveFromProcess(labels: string[]): WorkflowPhase {
  // Check for an active phase label (unchanged)
  for (const label of labels) {
    if (label.startsWith('phase:')) {
      const phase = label.slice('phase:'.length) as WorkflowPhase;
      if (PHASE_SEQUENCE.includes(phase)) {
        return phase;
      }
    }
  }

  // Find the last completed phase and return the next one
  const completedPhases = new Set<string>();
  for (const label of labels) {
    if (label.startsWith('completed:')) {
      const name = label.slice('completed:'.length);
      completedPhases.add(name);
      // Normalize gate names to phase names via GATE_MAPPING
      const mapping = GATE_MAPPING[name];
      if (mapping) {
        completedPhases.add(mapping.phase);
      }
    }
  }

  if (completedPhases.size > 0) {
    for (const phase of PHASE_SEQUENCE) {
      if (!completedPhases.has(phase)) {
        return phase;
      }
    }
    return 'validate';
  }

  return 'specify';
}
```

Remove the `reviewToPhase` map (lines 88-95) — replaced by `GATE_MAPPING`.

---

### Phase 5: Add `onResumeStart()` to label manager and call from worker

**File**: `packages/orchestrator/src/worker/label-manager.ts`

Add new method after `onWorkflowComplete()`:

```typescript
/**
 * Called at the start of a resume (continue command) before the phase loop.
 *
 * Removes stale `waiting-for:*` and `agent:paused` labels that were set
 * when the workflow paused at a gate.
 */
async onResumeStart(): Promise<void> {
  await this.retryWithBackoff(async () => {
    const issue = await this.github.getIssue(this.owner, this.repo, this.issueNumber);
    const currentLabels = issue.labels
      .map((l) => typeof l === 'string' ? l : l.name);

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
  });
}
```

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

After creating sub-components (step 7, around line 253) and before executing the phase loop (step 8, line 257), add:

```typescript
// 7b. On resume, clean up gate labels before starting the phase loop
if (item.command === 'continue') {
  await labelManager.onResumeStart();
}
```

---

### Phase 6: Update PR feedback monitor

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`

Update `resolveWorkflowName()` (line ~473-505) to check `workflow:*` labels first:

```typescript
// Primary: persistent workflow:* label (authoritative)
for (const label of issue.labels) {
  if (label.name.startsWith('workflow:')) {
    return label.name.slice('workflow:'.length);
  }
}

// Fallback: existing logic for pre-migration issues (unchanged)
for (const label of issue.labels) { ... }
```

---

### Phase 7: Update existing tests

Tests that assert the current buggy behavior need updating.

**File**: `tests/unit/services/label-monitor-service.test.ts`

1. **All `parseLabelEvent` tests**: Add `issueLabels` to expected event objects.
   - Line 92: expect includes `issueLabels: ['process:speckit-feature']`
   - Line 133: expect includes `issueLabels: ['process:speckit-bugfix']`

2. **All `processLabelEvent` tests**: Add `issueLabels` to event inputs.
   - Lines 143-151, 176-183, 195-201, 213-221: Add `issueLabels: []` or appropriate labels.

3. **`'should enqueue continue command for resume event'`** (line 268):
   - Add `issueLabels: ['completed:spec-review', 'waiting-for:spec-review', 'workflow:speckit-feature']` to event.
   - Change expected `workflowName` from `'spec-review'` to `'speckit-feature'`.

4. **`'should remove waiting-for:* label on resume'`** (line 289):
   - **Rewrite** to assert `removeLabels` is NOT called for resume events (label monitor no longer removes it).

5. **`'should use resume dedup key prefix'`** (line 307):
   - Add `issueLabels` to event input.

6. **`resume detection` tests** (lines 237-254): Add `issueLabels` to expected parseLabelEvent outputs.

7. **`deduplication integration` tests** (lines 425-470): Add `issueLabels` to event inputs.

8. **`webhook integration` tests** (lines 477-494): Add `issueLabels` to expected parseLabelEvent outputs.

9. **`'should enqueue a process event and update labels'`** (line 142):
   - Update `addLabels` expectation to include `workflow:speckit-feature` alongside `agent:in-progress`.

**File**: `src/worker/__tests__/phase-resolver.test.ts`

1. **`'returns "clarify" when waiting-for:clarification and completed:clarification are present'`** (line 59):
   - Change expected result from `'clarify'` to `'plan'`. This is the core behavioral fix.
   - The test description should also be updated.

2. **`'falls back to process resolution when no matching waiting-for/completed pair exists'`** (line 107):
   - Currently passes `['waiting-for:clarification', 'completed:specify']` → returns `'clarify'`.
   - After the fix: `resolveFromContinue` finds no gate match, falls back to `resolveFromProcess`, finds `completed:specify` → returns `'clarify'`. **Same result, no change needed.**

3. **Add new tests** (see Phase 8).

**File**: `src/worker/__tests__/claude-cli-worker.test.ts`

1. **`'starts from clarify when continue command and waiting-for:clarification labels present'`** (line 265):
   - After the fix, `completed:clarification` resolves to start phase `'plan'` via `GATE_MAPPING`.
   - Update assertion: first spawn should use `/speckit:plan` instead of `/speckit:clarify`.
   - Update test description.

---

### Phase 8: Add new tests

**File**: `src/worker/__tests__/phase-resolver.test.ts` (add to existing file)

```typescript
describe('GATE_MAPPING integration', () => {
  it.each([
    ['clarification', 'plan'],
    ['spec-review', 'clarify'],
    ['clarification-review', 'plan'],
    ['plan-review', 'tasks'],
    ['tasks-review', 'implement'],
    ['implementation-review', 'validate'],
  ])('continue with completed:%s resolves to %s', (gateName, expectedPhase) => {
    expect(
      resolver.resolveStartPhase([`completed:${gateName}`], 'continue'),
    ).toBe(expectedPhase);
  });

  it('does not require waiting-for: labels for continue resolution', () => {
    expect(
      resolver.resolveStartPhase(
        ['completed:specify', 'completed:clarification'],
        'continue',
      ),
    ).toBe('plan');
  });

  it('resolveFromProcess normalizes gate names via GATE_MAPPING', () => {
    expect(
      resolver.resolveStartPhase(
        ['completed:specify', 'completed:clarification'],
        'process',
      ),
    ).toBe('plan');
  });

  it('picks the most advanced gate when multiple are completed', () => {
    expect(
      resolver.resolveStartPhase(
        ['completed:spec-review', 'completed:plan-review'],
        'continue',
      ),
    ).toBe('tasks');
  });
});
```

**File**: `src/worker/__tests__/label-manager.test.ts` (add to existing file)

```typescript
describe('onResumeStart', () => {
  it('removes waiting-for:* and agent:paused labels', async () => {
    const lm = createLabelManager();
    mockGithub.getIssue.mockResolvedValue({
      labels: [
        { name: 'waiting-for:clarification' },
        { name: 'agent:paused' },
        { name: 'completed:specify' },
      ],
    });

    await lm.onResumeStart();

    expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
      'waiting-for:clarification',
      'agent:paused',
    ]);
  });

  it('is a no-op when no stale labels exist', async () => {
    const lm = createLabelManager();
    mockGithub.getIssue.mockResolvedValue({
      labels: [{ name: 'completed:specify' }, { name: 'bug' }],
    });

    await lm.onResumeStart();

    expect(mockGithub.removeLabels).not.toHaveBeenCalled();
  });
});
```

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Add `issueLabels` to `LabelEvent` interface | The label monitor already has `issueLabels` at detection time. Threading them through avoids an extra API call. |
| Default to `speckit-feature` when no `workflow:` label | Pragmatic backward compatibility for pre-existing issues (Q3: Option D). Warning log makes it visible. |
| Apply `workflow:` label in label monitor on `process:` events | Workflow name is known at detection time (Q4: Option A). Guarantees label exists before any worker runs. |
| Unified `GATE_MAPPING` replaces `reviewToPhase` | Self-documenting structure with `phase` + `resumeFrom` eliminates ambiguity (Q2: Option B). |
| `resolveFromContinue` returns next phase (e.g., `'plan'`), not gated phase (`'clarify'`) | The clarify phase already ran. Returning `'clarify'` would re-trigger the `always` gate → infinite loop (Q1: Option A). |
| `resolveFromContinue` iterates latest-phase-first | When multiple `completed:` gate labels exist, the most advanced gate is the one just satisfied. |
| `onResumeStart()` removes ALL `waiting-for:*` labels | Simpler than tracking specific gates. At resume time, all gate pauses should be cleared (Q10: Option A). |
| Only handle `always` gates | `on-questions` and `on-failure` aren't implemented. Don't design for hypotheticals (Q8: Option A). |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Pre-existing issues lack `workflow:` label | Default to `speckit-feature` with warning log. All current workflows are `speckit-feature`. |
| `LabelEvent` interface change breaks callers | Additive field. All callers already have `issueLabels` available. |
| Multiple `completed:` labels cause wrong resume phase | `resolveFromContinue` iterates latest-to-earliest in `PHASE_SEQUENCE`, most advanced gate wins. |
| `onResumeStart()` called for non-gate resumes | Safe — checks for labels before removing. |
| Label sync deploys before code | New `workflow:*` labels are inert until the label monitor applies them. |
| Existing tests assert buggy behavior | All affected tests identified in Phase 7. |

## Files Changed (Summary)

| File | Change Type |
|------|-------------|
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | Add `workflow:speckit-feature` and `workflow:speckit-bugfix` labels |
| `packages/orchestrator/src/types/monitor.ts` | Add `issueLabels` field to `LabelEvent` |
| `packages/orchestrator/src/services/label-monitor-service.ts` | Fix `workflowName` resolution, apply `workflow:` label, stop removing `waiting-for:` on resume |
| `packages/orchestrator/src/worker/phase-resolver.ts` | Add `GATE_MAPPING`, rewrite `resolveFromContinue` and `resolveFromProcess` |
| `packages/orchestrator/src/worker/label-manager.ts` | Add `onResumeStart()` method |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Call `onResumeStart()` before phase loop for `continue` commands |
| `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` | Read `workflow:*` label in `resolveWorkflowName()` |
| `tests/unit/services/label-monitor-service.test.ts` | Update expectations for `issueLabels`, fix `workflowName` and `waiting-for:` assertions |
| `src/worker/__tests__/phase-resolver.test.ts` | Fix `clarify`→`plan` assertion, add `GATE_MAPPING` tests |
| `src/worker/__tests__/claude-cli-worker.test.ts` | Fix resume test assertion (`clarify`→`plan`) |
| `src/worker/__tests__/label-manager.test.ts` | Add `onResumeStart()` tests |
