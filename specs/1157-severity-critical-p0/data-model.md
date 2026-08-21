# Data Model: Red CI must not silently complete the workflow (#1157)

No new persisted entities, Redis keys, or files. The fix reuses existing types and
label vocabulary; the only type change is widening an existing exported union.

## Modified types

### `CiConclusion` (`packages/workflow-engine/src/types/github.ts`)

Add two members so real hard-failure conclusions are first-class (FR-006):

```ts
export type CiConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'startup_failure'   // NEW (#1157 FR-006) — treated as failing
  | 'stale'             // NEW (#1157 FR-006) — treated as failing
  | 'skipped'
  | 'neutral'
  | null;
```

Values outside the union are still passed through and treated conservatively (not
`success`). Widening is a semantic correction of already-passed-through strings, not
new API surface.

## Verdict classification (unchanged shape, extended failing set)

`CiVerdict = 'green' | 'pending' | 'not-passed'` (unchanged). `aggregateCiVerdict`
precedence is unchanged; only the failing set grows.

| Conclusion set (after dropping `skipped`/`neutral`) | Verdict | Note |
|---|---|---|
| any `failure`/`cancelled`/`timed_out`/`action_required` | `not-passed` | existing |
| any `startup_failure` | `not-passed` | **NEW (FR-006)** |
| any `stale` | `not-passed` | **NEW (FR-006)** |
| any in-progress (`status !== 'completed'` or `conclusion === null`) | `pending` | existing |
| ≥1 `success`, nothing failing/in-progress | `green` | existing |
| empty / all-ignored / only unknown terminal | `pending` | existing (SC-001) |

## Readiness snapshot (unchanged shape, new guard on read)

`CiReadiness` (`packages/orchestrator/src/worker/ci-merge-readiness.ts`) is unchanged:

```ts
interface CiReadiness {
  verdict: CiVerdict;
  runCount: number;
  source: 'check-runs' | 'actions-runs';
}
```

FR-007 (Q5→C) guard, applied inside `evaluateCiReadiness` after aggregation:

```
if (source === 'actions-runs' && verdict === 'green') verdict = 'not-passed';  // fail-closed + log
```

`source === 'check-runs'` → verdict returned unaltered. `pending`/`not-passed` from the
fallback → returned unaltered.

## Head-SHA usability (FR-005)

The head SHA resolved from `getCurrentCommitSha()` is classed **unusable** — triggering
the fast-fail pause instead of a `waitForCiGreen` call — when any of:

- `getCurrentCommitSha()` throws, OR
- the resolved value is falsy (empty string), OR
- the resolved value is the literal sentinel `'unknown'`.

An unusable head SHA never reaches `waitForCiGreen`, so `commits/unknown/check-runs` is
never polled for the full `ciWaitTimeoutMs`.

## Label state transitions

The `not-passed` / timeout / missing-SHA pause all produce the identical label state
(reused `waiting-for:ci`, Q2→A / Q4→A):

| Label | Before pause (validate running) | After pause |
|---|---|---|
| `phase:validate` | present | **removed** (by `onGateHit`) |
| `completed:validate` | absent | **absent** (`onPhaseComplete` NOT called — FR-003) |
| `waiting-for:ci` | absent | **added** (by `onGateHit`) |
| `agent:paused` | absent | **added** (by `onGateHit`) |

Contrast: the *green* `on-ci-green` gate path grants `completed:validate` at pause
(post-completion approval gate) — unchanged by this fix.

## Resume

Operator adds `completed:*` → label monitor issues `continue` →
`PhaseResolver.resolveFromProcess` returns the first uncompleted phase = `validate`
(its `completed:` label is absent) → `validate` re-runs (Q3→A). No `GATE_MAPPING`
entry, no resolver change (see research.md Decision 4).
