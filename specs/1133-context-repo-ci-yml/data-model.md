# Data Model: CI-aware merge readiness (#1133)

## Types (workflow-engine)

### `CiConclusion`

```ts
// packages/workflow-engine/src/types/github.ts
export type CiConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'skipped'
  | 'neutral'
  | null; // null === in-progress / not yet concluded
```

### `CiRun`

Normalized shape produced by both the check-runs and actions/runs readouts.

```ts
export interface CiRun {
  /** GitHub run/check status: 'queued' | 'in_progress' | 'completed'. */
  status: string;
  /** Conclusion once completed; null while in progress. */
  conclusion: CiConclusion;
}
```

### `CiVerdict`

```ts
export type CiVerdict = 'green' | 'pending' | 'not-passed';
```

## Verdict aggregation (pure, workflow-engine)

```ts
// packages/workflow-engine/src/actions/github/client/ci-verdict.ts

/** Runs that are themselves skipped/neutral are non-blocking (skipped≠passed). */
const IGNORED: ReadonlySet<CiConclusion> = new Set(['skipped', 'neutral']);
const TERMINAL_NON_SUCCESS: ReadonlySet<CiConclusion> = new Set([
  'failure', 'cancelled', 'timed_out', 'action_required',
]);

export function aggregateCiVerdict(runs: CiRun[]): CiVerdict;
```

**Rules (Q2-C):**
1. Drop runs whose `conclusion ∈ IGNORED`.
2. If any remaining run has `conclusion ∈ TERMINAL_NON_SUCCESS` → `not-passed`.
3. Else if any remaining run is in-progress (`status !== 'completed'` or `conclusion === null`) → `pending`.
4. Else if ≥1 remaining run has `conclusion === 'success'` → `green`.
5. Else → `pending` (empty set, all-ignored, or no success).

## Readiness (orchestrator)

### `CiReadiness`

```ts
// packages/orchestrator/src/worker/ci-merge-readiness.ts
export interface CiReadiness {
  verdict: CiVerdict;
  /** Runs considered (post-normalization, pre-ignore-filter) — for logging. */
  runCount: number;
  /** Which readout produced the verdict — for observability / SC-004. */
  source: 'check-runs' | 'actions-runs';
}
```

### Wait result

```ts
export type CiWaitOutcome =
  | { kind: 'green' }
  | { kind: 'not-passed' }
  | { kind: 'timeout' }; // → caller pauses with waiting-for:ci + agent:paused
```

## Config additions (orchestrator `WorkerConfigSchema`)

| Field | Type | Default | Env |
|---|---|---|---|
| `ciMergeGateEnabled` | `z.boolean()` | `false` | `WORKER_CI_MERGE_GATE_ENABLED` |
| `ciWaitTimeoutMs` | `z.number().int().min(30_000)` | `900_000` (15 min) | `WORKER_CI_WAIT_TIMEOUT_MS` |

Both are per-workflow-overridable via the existing workflow-overrides resolution (mirrors `phaseTimeoutMs`).

## Gate definition additions

`GateDefinitionSchema.condition` enum gains `'on-ci-green'`.

When `ciMergeGateEnabled` is ON, the default `implementation-review` gate relocates from `implement` to `validate`:

```ts
// flag ON
{ phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' }
// flag OFF (unchanged from today)
{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' /* or on-request for bugfix */ }
```

## GATE_MAPPING (flag-conditional)

```ts
'implementation-review':
  ciMergeGateEnabled
    ? { phase: 'validate', resumeFrom: /* terminal no-op — see research Decision 5 */ 'validate' }
    : { phase: 'implement', resumeFrom: 'validate' } // byte-identical to today
```

## Labels

| Name | Color | Description |
|---|---|---|
| `waiting-for:ci` | `FBCA04` | Validate passed; awaiting CI to go green on the ready PR |
| `completed:ci` | `0E8A16` | CI gate satisfied |

## Relationships

```
validate (worker) ──success──┐
                             ├──> evaluateCiReadiness(headSha) ──> CiVerdict
CI (GitHub, parallel) ───────┘
        │
        ├─ green      → gate (on-ci-green) → implementation-review pause → human approve → merge-eligible
        ├─ pending    → waitForCiGreen(ciWaitTimeoutMs) → {green | not-passed | timeout}
        │                                                    timeout → waiting-for:ci + agent:paused
        └─ not-passed → readiness blocked (gate not raised)
```
