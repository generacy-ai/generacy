# Data Model: Cockpit classifier tier & label mapping

**Feature**: #841 | **Branch**: `841-found-during-cockpit-v1`

## `CockpitState` union (widened)

```ts
export const COCKPIT_STATES = [
  'pending',
  'active',
  'waiting',
  'error',
  'terminal',
  'stage-complete',   // NEW — a mid-pipeline completed:* stage marker
  'unknown',
] as const;

export type CockpitState = (typeof COCKPIT_STATES)[number];
```

**Semantics** (updated tier column added):

| Tier              | Meaning                                                                                                    | Example labels                                                                       |
|-------------------|------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `terminal`        | Workflow-final: `closed`, epic rollup approved / all children done, or `completed:validate`.               | `closed`, `completed:epic-approval`, `completed:children-complete`, `completed:validate` |
| `error`           | `failed:*` or `agent:error`.                                                                               | `failed:plan`, `agent:error`                                                         |
| `waiting`         | Needs human or dependency.                                                                                 | `waiting-for:clarification`, `needs:decision`                                        |
| `active`          | Currently being worked on.                                                                                 | `phase:plan`, `agent:in-progress`, `agent:dispatched`                                |
| `pending`         | Identity / process labels; nothing scheduled.                                                              | `type:feature`, `process:speckit-feature`, `agent:paused`                            |
| **`stage-complete`** | **A mid-pipeline `completed:*` stage marker with no higher-tier workflow signal present.**              | `completed:specify`, `completed:plan`, `completed:tasks`, `completed:implement`, `completed:clarify` |
| `unknown`         | Label not in `WORKFLOW_LABELS` and not the special `closed`.                                               | any custom label the org adds outside the protocol                                   |

## `TIER_RANK` (lower wins)

```ts
export const TIER_RANK: Record<CockpitState, number> = {
  terminal: 0,
  error: 1,
  waiting: 2,
  active: 3,
  pending: 4,
  'stage-complete': 5,   // NEW
  unknown: 6,            // was 5
};
```

**Invariant preserved**: recognised signals always outrank unrecognised ones (`stage-complete` at 5 beats `unknown` at 6).

## `TERMINAL_COMPLETED_LABELS`

Explicit set of `completed:*` labels that map to `terminal`. Every other `completed:*` label maps to `stage-complete`.

```ts
const TERMINAL_COMPLETED_LABELS = new Set<string>([
  'completed:validate',
  'completed:epic-approval',
  'completed:children-complete',
]);
```

**Growth policy**: New `completed:*` labels default to `stage-complete`. Promotion to `terminal` requires adding an entry here — always an explicit, code-reviewed act. This is the load-bearing invariant that makes the #841 bug direction impossible (Q2 → B rationale).

## `STAGE_COMPLETE_PIPELINE_ORDER` — new pipeline order array

Analogous to `WAITING_PIPELINE_ORDER`. Ordered latest-phase-first so the earlier index wins the source-label slot (Q4 → B).

```ts
export const STAGE_COMPLETE_PIPELINE_ORDER: string[] = [
  'completed:implementation-review',
  'completed:implement',
  'completed:tasks-review',
  'completed:tasks',
  'completed:plan-review',
  'completed:plan',
  'completed:clarification-review',
  'completed:clarification',
  'completed:clarify',
  'completed:spec-review',
  'completed:specify',
  'completed:setup',
  'completed:manual-validation',
];
```

**Behaviour**: When multiple demoted `completed:*` labels co-occur, `compareSourceLabels()` picks the one closer to index 0 (later phase). Unlisted `completed:*` labels sort after all listed ones and fall back to `workflowLabelIndex`.

## `mapLabelToState(label)` — updated rule

```text
IF label === 'closed'                                → 'terminal'
IF label.startsWith('completed:')
   AND TERMINAL_COMPLETED_LABELS.has(label)          → 'terminal'
IF label.startsWith('completed:')                    → 'stage-complete'
IF label.startsWith('failed:') OR label === 'agent:error'
                                                     → 'error'
IF label.startsWith('waiting-for:') OR label.startsWith('needs:')
                                                     → 'waiting'
IF label.startsWith('phase:') OR label ∈ {'agent:in-progress','agent:dispatched'}
                                                     → 'active'
IF label ∈ {'agent:paused', 'epic-child'}
   OR label.startsWith('type:')/'process:'/'workflow:'
                                                     → 'pending'
otherwise                                            → 'unknown'
```

The build-time `LABEL_TO_STATE` map is populated once at module load by iterating `WORKFLOW_LABELS` and applying this rule.

## `compareSourceLabels(a, b, tier, workflowIndex)` — updated dispatch

The comparator gains a mirror of the `waiting` branch for `stage-complete`:

```text
IF tier === 'waiting':
    use WAITING_PIPELINE_ORDER (existing)
ELSE IF tier === 'stage-complete':
    use STAGE_COMPLETE_PIPELINE_ORDER
        listed beats unlisted; among listed, lower index wins
        among unlisted, fall through to workflowIndex
ELSE:
    workflowIndex comparison (existing)
```

`classify()` itself does not change — the tier-rank comparison already reads the widened `TIER_RANK` transparently.

## `ClassifyResult` — no shape change

```ts
export interface ClassifyResult {
  state: CockpitState;
  sourceLabel: string;
}
```

`state` is a wider union; `sourceLabel` semantics unchanged. Downstream consumers that `switch (state)` should add a `case 'stage-complete':` arm — TypeScript will surface exhaustive-switch warnings on strict configs; runtime code that treats unknown arms as "nothing to render" degrades gracefully.

## Validation rules

- `TERMINAL_COMPLETED_LABELS` is frozen (`new Set([...] as const)`). No runtime mutation.
- Every `completed:*` string encountered by `classifyByPattern()` MUST match either `TERMINAL_COMPLETED_LABELS` or the `stage-complete` fallback — no third path.
- `STAGE_COMPLETE_PIPELINE_ORDER` contains only `completed:*` prefixed strings. Enforced by construction (constant literal); no runtime check needed.
- All `TIER_RANK` values must be unique non-negative integers. Enforced by manual review; the `Record<CockpitState, number>` type ensures every union member has a key.
