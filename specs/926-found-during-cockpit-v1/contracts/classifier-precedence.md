# Contract — Classifier Precedence Behavior

**Surface**: `packages/cockpit/src/state/precedence.ts` `WAITING_PIPELINE_ORDER` + `compareSourceLabels`, consumed by the cockpit state classifier (`packages/cockpit/src/state/classifier.ts`, callers via `classify(labels)`).

## Post-change contract

### Precedence table

```ts
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',        // index 0
  'waiting-for:address-pr-feedback',    // index 1  ← #926
  'waiting-for:spec-review',            // index 2
  'waiting-for:clarification',          // index 3
  'waiting-for:plan-review',            // index 4
  'waiting-for:tasks-review',           // index 5
  'waiting-for:implementation-review',  // index 6
  'waiting-for:manual-validation',      // index 7
];
```

### Classifier behavior — required outputs

Given `classify(labels)` returns `{ state, sourceLabel, ... }`, the following MUST hold after the change:

| Input labels | Expected `state` | Expected `sourceLabel` | Rationale |
|---|---|---|---|
| `['waiting-for:implementation-review', 'waiting-for:address-pr-feedback']` | `'waiting'` | `'waiting-for:address-pr-feedback'` | SC-001, FR-002 |
| `['waiting-for:implementation-review']` (after `address-pr-feedback` removed) | `'waiting'` | `'waiting-for:implementation-review'` | SC-001 |
| `['blocked:stuck-feedback-loop', 'waiting-for:address-pr-feedback']` | `'waiting'` | `'blocked:stuck-feedback-loop'` | Q1 answer preserves this invariant |
| `['blocked:stuck-feedback-loop', 'waiting-for:address-pr-feedback', 'waiting-for:implementation-review']` | `'waiting'` | `'blocked:stuck-feedback-loop'` | pause outranks activity outranks passive |
| `['waiting-for:address-pr-feedback']` (alone) | `'waiting'` | `'waiting-for:address-pr-feedback'` | trivially wins its own bucket |
| `['waiting-for:address-pr-feedback', 'waiting-for:spec-review']` | `'waiting'` | `'waiting-for:address-pr-feedback'` | active > passive (Q1→A, generalised) |

### Classifier behavior — invariants NOT to break

- Every existing `waiting-for:*` pairwise ordering in the current codebase MUST be preserved relative to itself (only insertion, no reordering of the existing seven entries).
- Unlisted gates continue to fall back to `WORKFLOW_LABELS` index (compareSourceLabels branch at line 82 of the pre-change file, semantically unchanged).
- `STAGE_COMPLETE_PIPELINE_ORDER` is unchanged.
- `TIER_RANK` is unchanged.

### Event-plane implications (derived)

- The `issue-transition` event is emitted when the curated `sourceLabel` changes across two consecutive label-set snapshots.
- **Add edge**: label-set transitions from `{implementation-review}` to `{implementation-review, address-pr-feedback}`. Pre-change: `sourceLabel` stays `implementation-review` (no event). Post-change: `sourceLabel` changes to `address-pr-feedback` → exactly one `issue-transition` event with `to = waiting-for:address-pr-feedback`.
- **Remove edge**: label-set transitions from `{implementation-review, address-pr-feedback}` back to `{implementation-review}`. Pre-change: `sourceLabel` stays `implementation-review` (no event). Post-change: `sourceLabel` changes from `address-pr-feedback` back to `implementation-review` → exactly one `issue-transition` event with `to = waiting-for:implementation-review`.

**No change to the event payload shape.** Only the frequency/timing of emitted events changes.

## Failure modes

- **Test failure**: any of the six required outputs above return a different `sourceLabel` → the classifier or precedence table has a bug or the change is incomplete. Break the build.
- **Silent regression**: an existing classifier assertion in `packages/cockpit/src/__tests__/classifier.test.ts` starts producing a different sourceLabel → the insertion accidentally displaced a listed gate. Break the build.
