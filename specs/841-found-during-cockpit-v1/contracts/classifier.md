# Contract: `classify()` — `packages/cockpit/src/state/classifier.ts`

**Feature**: #841 | **Branch**: `841-found-during-cockpit-v1`

## Signature (unchanged)

```ts
export function classify(labels: Iterable<string>): ClassifyResult;

export interface ClassifyResult {
  state: CockpitState;
  sourceLabel: string;
}
```

## Input

- `labels` — any `Iterable<string>` of GitHub label names. Duplicates are tolerated; deduplication is the classifier's responsibility (existing behaviour).

## Output invariants

1. `state` is a member of the (now-widened) `CockpitState` union: `'pending' | 'active' | 'waiting' | 'error' | 'terminal' | 'stage-complete' | 'unknown'`.
2. `sourceLabel` is empty string `''` iff `state === 'unknown'` and every input label was `'unknown'` (or the input was empty). Otherwise it is a member of the input set.
3. `mapLabelToState(sourceLabel) === state`. (The source label always maps to the winning tier.)
4. Among all recognised labels, `sourceLabel` is the tie-break winner per `compareSourceLabels()`.

## Tier selection (updated)

For the set of recognised (non-`unknown`) input labels:

1. Group by tier via `mapLabelToState()`.
2. Pick the tier with the **lowest** `TIER_RANK` (0=terminal ... 6=unknown).
3. Within that tier, pick the `sourceLabel` per `compareSourceLabels()`:
   - `waiting` tier — pipeline order via `WAITING_PIPELINE_ORDER`, then `workflowLabelIndex` fallback (unchanged).
   - **`stage-complete` tier — NEW: pipeline order via `STAGE_COMPLETE_PIPELINE_ORDER` (latest-phase-wins), then `workflowLabelIndex` fallback.**
   - all other tiers — `workflowLabelIndex` (unchanged).

## Terminal set

A `completed:*` label maps to `terminal` iff it is a member of the explicit set:

```text
{ 'completed:validate', 'completed:epic-approval', 'completed:children-complete' }
```

Every other `completed:*` label maps to `stage-complete`. This is a **closed** enumeration in code; adding a fourth terminal requires editing `TERMINAL_COMPLETED_LABELS` in `label-map.ts`.

## Regression scenarios (also test cases)

### FR-007 — waiting beats demoted completed

**Input**: `['completed:specify', 'waiting-for:clarification', 'agent:in-progress', 'agent:paused']`
**Output**: `{ state: 'waiting', sourceLabel: 'waiting-for:clarification' }`
**Why**: `waiting` (rank 2) beats `stage-complete` (rank 5). Within `waiting`, `'waiting-for:clarification'` is the only member — trivially chosen.

### FR-008 — completed:validate stays terminal

**Input**: `['completed:validate']`
**Output**: `{ state: 'terminal', sourceLabel: 'completed:validate' }`
**Why**: `completed:validate ∈ TERMINAL_COMPLETED_LABELS` → `terminal`.

### FR-009a — single demoted completed maps to stage-complete

**Input**: `['completed:specify']`
**Output**: `{ state: 'stage-complete', sourceLabel: 'completed:specify' }`
**Why**: `completed:specify ∉ TERMINAL_COMPLETED_LABELS` → `stage-complete` fallback rule.

### FR-009b — latest-phase-wins tie-break

**Input**: `['completed:specify', 'completed:plan']`
**Output**: `{ state: 'stage-complete', sourceLabel: 'completed:plan' }`
**Why**: Both map to `stage-complete`. In `STAGE_COMPLETE_PIPELINE_ORDER`, `'completed:plan'` (index 5) precedes `'completed:specify'` (index 10). Lower index wins.

### Additional canary cases

- `['completed:epic-approval', 'completed:implement']` → `{ state: 'terminal', sourceLabel: 'completed:epic-approval' }` — terminal outranks stage-complete regardless of pipeline order.
- `['completed:children-complete']` → `{ state: 'terminal', sourceLabel: 'completed:children-complete' }` — epic rollup unaffected.
- `['failed:plan', 'completed:specify']` → `{ state: 'error', sourceLabel: 'failed:plan' }` — error beats stage-complete.
- `[]` → `{ state: 'unknown', sourceLabel: '' }` — unchanged empty-input behaviour.

## Compatibility notes

- **Union widening is source-compatible** for all existing callers: any `switch (state)` without a `case 'stage-complete':` still compiles (the arm is treated as `never`-fall-through). Strict-mode exhaustiveness checks (e.g., `assertNever(state)`) will surface a type error and prompt the caller to add the arm.
- **Runtime behaviour** for callers that route only on `state === 'terminal'` changes: issues previously classified as `terminal` due to `completed:specify`/`completed:plan`/etc. will now classify as `stage-complete`. This is the intended behaviour change of #841.
- **`ClassifyResult` field names / types** are unchanged.

## Non-goals

- No change to `WORKFLOW_LABELS` definitions.
- No change to `docs/label-protocol.md` (rev 3 state table is authoritative — spec Assumption 1).
- No new labels created or removed.
- No `cockpit status` CLI rendering changes beyond the new bucket entry (cosmetic follow-up).
