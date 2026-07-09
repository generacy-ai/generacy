# Data Model: `cockpit resume <issue-ref>` — re-arm a failed phase

## Overview

The `resume` verb is a pure CLI surface with no persisted state. Its "data model" is the label set it reads and writes on a GitHub issue, plus the intermediate types the classifier and gate-inversion helper use.

## Core Types

### `PrecedingGate`

Result of `resolvePrecedingGate` — the gate whose completion causes the resolver to pick the failed phase as `startPhase`.

**TypeScript** (`packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts` — new export):

```ts
export interface PrecedingGate {
  /** Gate name — e.g. "implementation-review", "tasks-review". */
  name: string;
  /** Full label name "waiting-for:<name>". */
  waitingLabel: string;
  /** Full label name "completed:<name>". */
  completedLabel: string;
  /** The phase this gate belongs to (from GATE_MAPPING[name].phase). */
  sourcePhase: WorkflowPhase;
  /** True when sourcePhase === the phase being re-entered (documented tie-break). */
  isSelfLoop: boolean;
}

export type ResolvePrecedingGateResult =
  | { kind: 'found'; gate: PrecedingGate }
  | { kind: 'no-preceding-gate'; targetPhase: WorkflowPhase };
```

**Validation rules**:
- `name` MUST be a non-empty string matching a key of the effective `GATE_MAPPING` (workflow-overlaid).
- `waitingLabel` MUST equal `"waiting-for:${name}"`.
- `completedLabel` MUST equal `"completed:${name}"`.
- `sourcePhase` MUST be one of `PHASE_SEQUENCE` (or `getPhaseSequence(workflowName)` for workflow-scoped).
- `isSelfLoop` MUST be `sourcePhase === targetPhase` (the phase argument passed to `resolvePrecedingGate`).

### `LabelSet` (implicit — the type of `gh.fetchIssueLabels().labels`)

The raw GitHub label set. Not redefined here — used verbatim as `string[]`.

### `ResumeClassification`

Internal discriminator for `runResume`'s decision branches.

**TypeScript** (`packages/generacy/src/cli/commands/cockpit/resume.ts` — internal):

```ts
type ResumeClassification =
  | { kind: 'no-op'; reason: 'no-failed-label' }
  | { kind: 'happy-path'; failedPhase: WorkflowPhase; gate: PrecedingGate; labelsToAdd: string[]; labelsToRemove: string[] }
  | { kind: 'refuse-multiple-failed'; failedLabels: string[] }
  | { kind: 'refuse-unknown-phase'; failedLabel: string }
  | { kind: 'refuse-no-preceding-gate'; failedPhase: WorkflowPhase }
  | { kind: 'refuse-conflicting-waiting'; failedPhase: WorkflowPhase; conflictingLabel: string; expectedLabel: string };
```

**Validation rules**:
- Exactly one `kind` applies to any input label set.
- `happy-path.labelsToAdd` MUST equal `[gate.waitingLabel, gate.completedLabel, 'agent:paused']` (order preserved for the log line).
- `happy-path.labelsToRemove` MUST include `` `failed:${failedPhase}` `` and MAY include `agent:error` and `` `phase:${failedPhase}` `` only when present in the fetched label set (defensive).
- Refusal kinds MUST carry sufficient evidence to reconstruct the operator-facing message with no follow-up API call.

## Entities on the GitHub Side

### Input labels (read via `gh.fetchIssueLabels`)

Any subset of `WORKFLOW_LABELS`. Recognized by the classifier:

- `failed:<phase>` where `<phase>` is one of `specify | clarify | plan | tasks | implement | validate`.
- `agent:error` — defensive marker, cleared but not required.
- `agent:paused` — should NOT be present on a failed issue (per `onError` label transitions); if present alongside `failed:*`, it's not blocking — the additions call is idempotent.
- `phase:<phase>` — defensive marker, cleared if present.
- `completed:<earlier-phase>` — preserved untouched (per Q5).
- `waiting-for:<any-gate>` — presence of any `waiting-for:*` triggers the FR-004(d) refusal branch UNLESS the label equals the derived `<preceding-gate>` (idempotent re-run).
- `workflow:<name>` — used to resolve the effective gate mapping.

### Output label set (post-resume)

Given input `{failed:<phase>, agent:error?, phase:<phase>?, workflow:<name>, completed:<earlier-phase>*}`, the terminal on-issue state is:

```
{
  waiting-for:<preceding-gate>,     // NEW
  completed:<preceding-gate>,       // NEW
  agent:paused,                     // NEW
  completed:<earlier-phase>*,       // preserved
  workflow:<name>,                  // preserved
  // failed:<phase>                 → removed
  // agent:error                    → removed (if was present)
  // phase:<phase>                  → removed (if was present)
}
```

This label set is **byte-identical** to a naturally-paused-then-completed gate state (per Q4). Enforced by the regression test asserting the label-monitor's `parseLabelEvent` emits a `resume`-type event on this set.

## Invariants

1. **Byte-identical natural-pause state**: The post-resume label set MUST be indistinguishable from a naturally-paused-then-completed gate. Enforced by the regression test.
2. **Preserved completed chain (Q5)**: `resume` never touches `completed:<earlier-phase>` labels. The resolver's dependence on the chain is left intact — proven by `resolveStartPhase` returning `<failedPhase>` (not `'specify'` or an earlier phase) in the regression test.
3. **Additions before removals (Assumption §7)**: The additions API call MUST fire before the removals API call. Mid-sequence failure leaves the issue "over-labeled", never "under-labeled".
4. **Defensive removal (Q3)**: `phase:<phase>` and `agent:error` are removed only when present in the fetched label set. The log line reports only the labels actually mutated.
5. **Fail-closed refusal (FR-004)**: On any classification branch other than `happy-path`, zero mutating `gh` calls are made. Enforced by unit tests asserting `addLabels` and `removeLabels` were never called.
6. **Idempotency (FR-003)**: Re-running `resume` on an issue that has already been re-armed produces the same terminal label set (either a no-op if the failed side is already gone, or a re-application of additions that were already present — `gh addLabels` is idempotent on GitHub's side).
7. **Purely additive CLI surface**: No existing verb's behavior changes. No existing label semantics change. No monitor or resolver code changes.

## Relationships

- `PrecedingGate` is the sole output of `resolvePrecedingGate` and the sole input (other than the label set) to `runResume`'s happy-path branch.
- `ResumeClassification` is internal — never crosses the module boundary. Its `kind` string determines the exit code (`happy-path` / `no-op` → 0; `refuse-*` → 3).
- `GATE_MAPPING` and `WORKFLOW_GATE_MAPPING` from `packages/orchestrator/src/worker/phase-resolver.ts` are the upstream source of truth; `resolvePrecedingGate` is the inverse view of that map, keyed by `resumeFrom` instead of gate-name.
- The post-resume label set is the sole contract with `label-monitor-service.ts` and `phase-resolver.ts` — those files are UNCHANGED.

## Derived Mapping Reference

Truth-table for `resolvePrecedingGate` given the current `GATE_MAPPING`:

| `failed:<phase>` | Cross-phase candidates | Self-loop candidates | Chosen gate | Notes |
|---|---|---|---|---|
| `failed:validate` | `implementation-review` (phase=implement) | `manual-validation` (phase=validate) | `implementation-review` | Cross-phase wins per Decision 2. |
| `failed:implement` | `tasks-review` (phase=tasks) | none | `tasks-review` | Single candidate. |
| `failed:tasks` | `plan-review` (phase=plan) | none | `plan-review` | Single candidate. |
| `failed:plan` | none | none | `no-preceding-gate` → refuse | Evidence points at `process:*` re-queue. |
| `failed:clarify` | `spec-review` (phase=specify) | `clarification`, `clarification-review` (phase=clarify) | `spec-review` | Cross-phase wins; documented tie-break, see Decision 2. |
| `failed:specify` | none | none | `no-preceding-gate` → refuse | Evidence points at `process:*` re-queue. |

**speckit-epic workflow** (via `WORKFLOW_GATE_MAPPING`):

| `failed:<phase>` | Cross-phase candidates | Self-loop candidates | Chosen gate |
|---|---|---|---|
| `failed:tasks` | `plan-review` (phase=plan) | `tasks-review`, `children-complete`, `epic-approval` (phase=tasks) | `plan-review` |

The truth-table is what `gate-vocabulary.test.ts` MUST assert row-by-row. A change to `GATE_MAPPING` upstream that would flip any row causes the test to fail deterministically — the drift signal Q1's "derive, not hardcode" requirement demands.
