# Contract: `resolvePrecedingGate` — programmatic API in `gate-vocabulary.ts`

## Signature

```ts
export function resolvePrecedingGate(
  phase: WorkflowPhase,
  workflowName?: string,
): ResolvePrecedingGateResult;

export type ResolvePrecedingGateResult =
  | { kind: 'found'; gate: PrecedingGate }
  | { kind: 'no-preceding-gate'; targetPhase: WorkflowPhase };

export interface PrecedingGate {
  name: string;
  waitingLabel: string;    // "waiting-for:<name>"
  completedLabel: string;  // "completed:<name>"
  sourcePhase: WorkflowPhase;
  isSelfLoop: boolean;
}
```

## Behavior

**Inputs**:
- `phase`: the failed phase to re-enter.
- `workflowName` (optional): workflow slug for `WORKFLOW_GATE_MAPPING` overlay. When omitted, uses global `GATE_MAPPING` only.

**Algorithm**:
1. Build effective mapping = `GATE_MAPPING` overlaid with `WORKFLOW_GATE_MAPPING[workflowName]` (if `workflowName` provided and present in the workflow map). Mirrors `PhaseResolver.getEffectiveGateMapping`.
2. Filter entries `[gateName, { phase: gatePhase, resumeFrom }]` where `resumeFrom === phase`.
3. If empty: return `{ kind: 'no-preceding-gate', targetPhase: phase }`.
4. Partition into `crossPhase` (where `gatePhase !== phase`) and `selfLoop` (where `gatePhase === phase`).
5. If `crossPhase` non-empty: sort by `PHASE_SEQUENCE.indexOf(gatePhase)` descending (nearest predecessor first) and return the first entry as `PrecedingGate` with `isSelfLoop: false`.
6. Otherwise: return the first `selfLoop` entry in stable Object.entries order as `PrecedingGate` with `isSelfLoop: true`.

**Determinism**: The function is pure and referentially transparent. Given identical `GATE_MAPPING` and `WORKFLOW_GATE_MAPPING` (module-loaded once), successive calls with the same args return equal results.

## Truth-table assertions (test contract)

`gate-vocabulary.test.ts` MUST assert every row of this table:

| Call | Expected result |
|---|---|
| `resolvePrecedingGate('validate')` | `{ kind: 'found', gate: { name: 'implementation-review', sourcePhase: 'implement', isSelfLoop: false, waitingLabel: 'waiting-for:implementation-review', completedLabel: 'completed:implementation-review' } }` |
| `resolvePrecedingGate('implement')` | `{ kind: 'found', gate: { name: 'tasks-review', sourcePhase: 'tasks', isSelfLoop: false, ... } }` |
| `resolvePrecedingGate('tasks')` | `{ kind: 'found', gate: { name: 'plan-review', sourcePhase: 'plan', isSelfLoop: false, ... } }` |
| `resolvePrecedingGate('plan')` | `{ kind: 'no-preceding-gate', targetPhase: 'plan' }` |
| `resolvePrecedingGate('clarify')` | `{ kind: 'found', gate: { name: 'spec-review', sourcePhase: 'specify', isSelfLoop: false, ... } }` |
| `resolvePrecedingGate('specify')` | `{ kind: 'no-preceding-gate', targetPhase: 'specify' }` |
| `resolvePrecedingGate('tasks', 'speckit-epic')` | `{ kind: 'found', gate: { name: 'plan-review', sourcePhase: 'plan', isSelfLoop: false, ... } }` — same as default; `WORKFLOW_GATE_MAPPING['speckit-epic']` adds self-loops but cross-phase still wins. |

## Extension points

- **New workflow**: adding an entry to `WORKFLOW_GATE_MAPPING` in `phase-resolver.ts` automatically affects `resolvePrecedingGate`. Truth-table test grows by one row per workflow (or an assertion loop over workflow names).
- **New gate**: adding an entry to `GATE_MAPPING` in `phase-resolver.ts` may change tie-break outcomes for one or more phases. Truth-table test fails deterministically, forcing the change to be re-evaluated.
- **Renamed phase**: `WorkflowPhase` type change ripples into `resolvePrecedingGate`'s signature. TypeScript catches at compile time.

## Error behavior

- **Invalid `phase` argument** (not a `WorkflowPhase`): TypeScript rejects at compile time. Runtime callers (`runResume`) MUST validate before calling — the classifier does this in the "unknown phase" branch.
- **Missing `workflowName`**: not an error; falls back to base `GATE_MAPPING`. No warning logged.
- **Unknown `workflowName`**: falls back to base `GATE_MAPPING` (matches `PhaseResolver.getEffectiveGateMapping` semantics). No warning logged.
