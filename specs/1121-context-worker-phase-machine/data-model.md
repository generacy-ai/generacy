# Data Model: Add `review` and `remediate` to the workflow phase machinery

**Issue**: generacy-ai/generacy#1121

This describes the type/schema surface the change touches. Nothing here is a new runtime entity in the persistence sense — the "entities" are the compile-time vocabulary and config shapes that must gain the two new phases coherently.

## Core vocabulary

### `WorkflowPhase` (canonical union)

`packages/orchestrator/src/worker/types.ts`

```ts
export type WorkflowPhase =
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'implement'
  | 'review'      // NEW — linear, after implement
  | 'validate'
  | 'remediate';  // NEW — off-sequence, in no linear sequence
```

- `review` and `remediate` are added members.
- Ordering of the union declaration is cosmetic; `PHASE_SEQUENCE` defines runtime order.

### `PHASE_SEQUENCE`

```ts
export const PHASE_SEQUENCE: readonly WorkflowPhase[] = [
  'specify', 'clarify', 'plan', 'tasks', 'implement', 'review', 'validate',
] as const;
```

- `review` inserted between `implement` and `validate` (D-2).
- `remediate` deliberately absent (FR-004).

### `WORKFLOW_PHASE_SEQUENCES`

```ts
export const WORKFLOW_PHASE_SEQUENCES: Record<WorkflowName, readonly WorkflowPhase[]> = {
  'speckit-feature': PHASE_SEQUENCE,                          // inherits review
  'speckit-bugfix':  PHASE_SEQUENCE,                          // inherits review
  'speckit-epic':    ['specify', 'clarify', 'plan', 'tasks'], // UNCHANGED
};
```

- feature/bugfix inherit `review` via `PHASE_SEQUENCE` identity (FR-003).
- epic keeps its explicit literal, unchanged (FR-003).

### `PHASE_TO_STAGE` (must stay exhaustive)

```ts
export const PHASE_TO_STAGE: Record<WorkflowPhase, StageType> = {
  specify:   'specification',
  clarify:   'specification',
  plan:      'planning',
  tasks:     'planning',
  implement: 'implementation',
  review:    'implementation',  // NEW (FR-002)
  validate:  'validation',
  remediate: 'implementation',  // NEW (FR-002)
};
```

- Both new phases map to the `implementation` stage (FR-002, Edge Cases).
- Because the key type is `Record<WorkflowPhase, StageType>`, omitting either new phase is a compile error — this is the one site TypeScript enforces for free.

## Config surfaces (Zod)

### `WorkerConfigSchema.reviewPhaseEnabled` (NEW)

`packages/orchestrator/src/worker/config.ts`

```ts
reviewPhaseEnabled: z.boolean().default(false),
```

- Feature flag (D-4). Default OFF → live runs skip `review` (Q1=A, FR-008).
- Sourced from `WORKER_REVIEW_PHASE_ENABLED` env in `config/loader.ts`.

### `GateDefinitionSchema` phase enum

```ts
phase: z.enum([
  'specify','clarify','plan','tasks','implement','review','validate','remediate',
] as const satisfies readonly WorkflowPhase[]),
```

- Gains `review`, `remediate`; keeps the `satisfies readonly WorkflowPhase[]` guard so the enum can never drift from the union.
- **No default gate** is added for `review` (Q2=A/FR-010) — `review` ships gate-less; the existing `waiting-for:implementation-review` gate stays on `implement`.

### `PhaseTimeoutOverridesSchema`

```ts
review:    z.number().int().min(60_000).optional(),  // NEW
remediate: z.number().int().min(60_000).optional(),  // NEW
```

- Optional per-phase timeout keys (FR-005). Absence falls back to the flat `phaseTimeoutMs` (Edge Cases — no migration).
- Note: this schema already omits `validate` by design; the two new keys follow the same optional shape.

### Agent-merge `phaseKeys`

```ts
const phaseKeys = [
  'specify','clarify','plan','tasks','implement','review','validate','remediate',
] as const;
```

- Gains `review`, `remediate` so per-phase agent (model/effort) overrides are accepted (FR-005).

### `WorkflowPhaseSchema` (pause context)

`packages/orchestrator/src/worker/pause-context.ts`

```ts
z.enum(['specify','clarify','plan','tasks','implement','review','validate','remediate'])
```

- Add both members.

### `overridablePhases` (loader)

`packages/orchestrator/src/config/loader.ts`

```ts
const overridablePhases = [
  'specify','clarify','plan','tasks','implement','review','remediate',
] as const;
```

- Add `review`, `remediate`. (This list intentionally excludes `validate`, matching current behavior; the two new phases are overridable.)

### `template-schema` strict phase keys

`packages/config/src/template-schema.ts`

```ts
phases: z.object({
  // …existing…
  review:    AgentEntrySchema.optional(),  // NEW
  remediate: AgentEntrySchema.optional(),  // NEW
}).strict()
```

- Strict object; add both optional keys or strict-mode parse fails (FR-005).

### `resume.ts` `KNOWN_PHASES`

`packages/generacy/src/cli/commands/cockpit/resume.ts`

```ts
const KNOWN_PHASES: readonly WorkflowPhase[] = [
  'specify','clarify','plan','tasks','implement','review','validate','remediate',
];
```

- Add both.

## Cross-package vocabulary

### `CorePhase` (workflow-engine)

`packages/workflow-engine/src/types/github.ts`

```ts
export type CorePhase =
  | 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement'
  | 'review'     // NEW
  | 'validate'
  | 'remediate'; // NEW
```

### `WORKFLOW_LABELS` (workflow-engine)

`packages/workflow-engine/src/actions/github/label-definitions.ts`

Add 8 entries — the four phase-progress families for each new phase (FR-006, Q3=A), at parity with existing phases:

| Family | review | remediate |
|---|---|---|
| `phase:` | `phase:review` | `phase:remediate` |
| `completed:` | `completed:review` | `completed:remediate` |
| `failed:` | `failed:review` | `failed:remediate` |
| `failed:*-repeated` | `failed:review-repeated` | `failed:remediate-repeated` |

- **No** `waiting-for:` gate labels for either phase (Q3=A, consistent with Q2=A review-gate-less).

## Loop-control types

### `PhaseLoopDeps.remediateTrigger` (NEW, optional)

`packages/orchestrator/src/worker/phase-loop.ts`

```ts
remediateTrigger?: (context: WorkerContext) => boolean; // default undefined → dead in prod
```

- Injectable predicate driving the off-sequence seam (D-5, FR-007). Default absent → `remediate` unreachable in production; the unit test injects a fire-once-then-false predicate.

### `runStubPhase` result shape

```ts
runStubPhase(phase: 'review' | 'remediate'): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 0, output: [] };
}
```

- Synthetic success (D-6). Keeps the loop advancing identically to a real successful phase.

## Validation rules & invariants

- **Exhaustiveness**: `PHASE_TO_STAGE` is `Record<WorkflowPhase, StageType>` — both new phases are compiler-required.
- **Enum/union parity**: `GateDefinitionSchema.phase` carries `satisfies readonly WorkflowPhase[]`; the enum cannot drift from the union.
- **Sequence invariant**: `remediate ∉ any WORKFLOW_PHASE_SEQUENCES value` (FR-004). Asserted by the audit test.
- **Intentional subsets** (documented, must NOT gain the phases): launcher `PhaseIntent['phase']` unions (both packages), and any list that already excludes `validate` for the same "launchable-CLI subset" reason (D-3).
- **Behavior-identity**: with `reviewPhaseEnabled=false` and `remediateTrigger=undefined`, the observable output of a feature/bugfix/epic run is byte-identical to pre-change (FR-008/FR-009/SC-004).

## Relationships

```
WorkflowPhase (union, canonical)
  ├── PHASE_SEQUENCE ──────────── used by speckit-feature / speckit-bugfix
  │      └── review inserted here
  ├── WORKFLOW_PHASE_SEQUENCES ── speckit-epic uses its own literal (unchanged)
  ├── PHASE_TO_STAGE ──────────── exhaustive map → both new phases = 'implementation'
  ├── Zod enums / literal unions ─ config.ts, pause-context.ts, loader.ts,
  │                                template-schema.ts, resume.ts, github.ts
  │                                (all gain review + remediate)
  ├── WORKFLOW_LABELS ─────────── 4 label families × 2 phases (derived vocabulary)
  └── PhaseIntent['phase'] ─────── intentional subset (unchanged, D-3)

WorkerConfig.reviewPhaseEnabled ── gates the phase-loop skip for review
PhaseLoopDeps.remediateTrigger ─── gates the off-sequence remediate seam
```
