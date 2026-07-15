# Data Model: Cockpit classifier — `blocked:*` error tier (#943)

## Scope

This change is a pure in-memory classifier update. No wire schema, storage schema, or Zod contract is added or modified. The affected data structures live in `@generacy-ai/cockpit`.

## Types (unchanged surface)

```ts
// packages/cockpit/src/types.ts (unchanged)
export type CockpitState =
  | 'pending'
  | 'active'
  | 'waiting'
  | 'error'         // ← blocked:stuck-merge-conflicts + blocked:stuck-validate-fix now land here
  | 'terminal'
  | 'stage-complete'
  | 'unknown';

export interface ClassifyResult {
  state: CockpitState;
  sourceLabel: string;
}
```

The `error` variant already exists; no union edit is required. Consumers already handle it (agent:error and failed:* have been in the error tier since day one).

## New module-scoped structures

Both live entirely inside `@generacy-ai/cockpit`.

### `ERROR_BLOCKED_LABELS` (in `label-map.ts`)

```ts
const ERROR_BLOCKED_LABELS: ReadonlySet<string> = new Set([
  'blocked:stuck-merge-conflicts',
  'blocked:stuck-validate-fix',
]);
```

- **Purpose**: enumerate the `blocked:*` label names that promote from `waiting` to `error`.
- **Contents (CD-1)**:
  - `blocked:stuck-merge-conflicts` — set by `MergeConflictHandler` when its single autonomous attempt is exhausted (#898).
  - `blocked:stuck-validate-fix` — set by `ValidateFixHandler` on duplicate evidence, no-diff, or sibling overlap (#892).
- **Explicit non-members** (stay `waiting`):
  - `blocked:stuck-feedback-loop` — pinned at the top of `WAITING_PIPELINE_ORDER` by #883. Membership is preserved by construction: the enumerated set is checked first, then the prefix branch catches it.
  - Any future `blocked:*` label — safe default is `waiting` unless explicitly promoted here.
- **Validation rule**: none (compile-time literal). The set values MUST also exist in `WORKFLOW_LABELS` (`packages/workflow-engine/src/actions/github/label-definitions.ts:100-115`) — both currently do; adding a name here without also registering it in `WORKFLOW_LABELS` would produce a classifier result for a label the orchestrator never applies (harmless but useless).

### `ERROR_PIPELINE_ORDER` (in `precedence.ts`)

```ts
export const ERROR_PIPELINE_ORDER: string[] = [
  'blocked:stuck-merge-conflicts',
  'blocked:stuck-validate-fix',
];
```

- **Purpose**: deterministic intra-`error` tie-break (CD-2 + CD-3). Placement in the list determines which label wins the `sourceLabel` slot when multiple error-tier labels co-occur on one issue.
- **Ordering rationale**:
  - Position 0: `blocked:stuck-merge-conflicts` — the label that triggered this fix, most-specific existing escalation gate (D.11).
  - Position 1: `blocked:stuck-validate-fix` — same handler-gave-up shape, second-most-specific.
- **Precedence semantics**:
  - Both entries outrank every unlisted error-tier label (`agent:error`, `failed:*`) — the comparator returns "listed wins over unlisted" when only one side is in the list.
  - Ordering between two listed entries: lower `indexOf` wins.
  - Ordering between two unlisted entries: falls through to `workflowLabelIndex` (existing behaviour).
- **Validation rule**: contents SHOULD be a subset of `ERROR_BLOCKED_LABELS`. Nothing enforces this today (and nothing prevents an operator from adding `agent:error` to the list). The lint-worthy invariant is: **every entry in `ERROR_PIPELINE_ORDER` should classify as `error` under `mapLabelToState`**. A unit test asserts this.

## Modified pure functions

### `classifyByPattern(label: string): CockpitState`

Location: `packages/cockpit/src/state/label-map.ts:29`.

Diff summary: a new guard `if (ERROR_BLOCKED_LABELS.has(label)) return 'error';` is inserted **immediately before** the existing `waiting-for:` / `needs:` / `blocked:` prefix branch. All other branches unchanged.

Behavioural contract:

| Input | Before | After |
|-------|--------|-------|
| `'blocked:stuck-feedback-loop'` | `waiting` | `waiting` (unchanged; caught by prefix branch below) |
| `'blocked:stuck-merge-conflicts'` | `waiting` | **`error`** |
| `'blocked:stuck-validate-fix'` | `waiting` | **`error`** |
| `'blocked:some-future-name'` | `waiting` | `waiting` (unchanged; caught by prefix branch below) |
| `'waiting-for:merge-conflicts'` | `waiting` | `waiting` |
| `'agent:error'` | `error` | `error` |
| `'failed:validate'` | `error` | `error` |
| any label not in `WORKFLOW_LABELS` | `unknown` | `unknown` |

### `compareSourceLabels(a, b, tier, workflowIndex): number`

Location: `packages/cockpit/src/state/precedence.ts:70`.

Diff summary: a new `if (tier === 'error') { … }` block is inserted between the existing `stage-complete` block and the final `workflowIndex` fallback. Structurally identical to the `waiting` / `stage-complete` branches.

Behavioural contract for the `error` tier:

| `a`, `b` | Winner | Reason |
|----------|--------|--------|
| `'blocked:stuck-merge-conflicts'`, `'agent:error'` | `blocked:stuck-merge-conflicts` | listed > unlisted |
| `'blocked:stuck-merge-conflicts'`, `'failed:plan'` | `blocked:stuck-merge-conflicts` | listed > unlisted |
| `'blocked:stuck-validate-fix'`, `'agent:error'` | `blocked:stuck-validate-fix` | listed > unlisted |
| `'blocked:stuck-merge-conflicts'`, `'blocked:stuck-validate-fix'` | `blocked:stuck-merge-conflicts` | lower `indexOf` |
| `'agent:error'`, `'failed:plan'` | (existing behaviour) | falls through to `workflowIndex` |
| `'failed:plan'`, `'failed:tasks'` | (existing behaviour) | falls through to `workflowIndex` |

## Relationships to existing structures

- **`WORKFLOW_LABELS`** (`@generacy-ai/workflow-engine`) — source of truth for label existence. Both new error-tier labels are already registered; no edit needed.
- **`TIER_RANK`** (`precedence.ts:7`) — unchanged. `error` already ranks between `terminal` and `waiting`, so a `blocked:stuck-merge-conflicts` co-occurring with `waiting-for:merge-conflicts` picks the error tier's label.
- **`WAITING_PIPELINE_ORDER`** (`precedence.ts:26`) — unchanged. `blocked:stuck-feedback-loop` keeps its pin because it stays in the `waiting` tier (never enters the error tier's comparator).
- **`STAGE_COMPLETE_PIPELINE_ORDER`** (`precedence.ts:45`) — unchanged.
- **`LABEL_TO_STATE`** (`label-map.ts:55`) — rebuilt at module load from `WORKFLOW_LABELS` × `classifyByPattern`. The two enumerated blocked labels flip from `waiting` to `error` automatically once `classifyByPattern` gains its new guard.

## Invariants preserved

1. **Every label in `WORKFLOW_LABELS` maps to exactly one `CockpitState`** (no duplication, no gaps).
2. **`blocked:stuck-feedback-loop` classifies as `waiting`** (#883 contract).
3. **`agent:error` and `failed:*` still classify as `error`** — the tier is unchanged; only the intra-tier tie-break shifts.
4. **The `waiting` tier's pipeline order is untouched**, so `#883` and `#926` classifier tests keep passing without edit.
5. **The `error` tier's `sourceLabel` for a single-label input is always the label itself** (comparator only runs when there are ≥2 candidates).
