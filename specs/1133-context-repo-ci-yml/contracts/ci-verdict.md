# Contract: CI verdict aggregation

**Module**: `packages/workflow-engine/src/actions/github/client/ci-verdict.ts` (pure, zero I/O)

## `aggregateCiVerdict(runs: CiRun[]): CiVerdict`

Deterministic mapping of a head-SHA run set to `'green' | 'pending' | 'not-passed'`.

### Ignore set (skipped≠passed, Q2-C)
`skipped`, `neutral` conclusions are dropped before evaluation — a skipped run of an unrelated workflow is non-blocking.

### Precedence (evaluated in order over the non-ignored set)
1. Any `failure | cancelled | timed_out | action_required` → **not-passed**.
2. Any in-progress (`status !== 'completed'` or `conclusion === null`) → **pending**.
3. Any `success` → **green**.
4. Otherwise → **pending**.

### Truth table

| Input (non-skipped runs) | Verdict | Notes |
|---|---|---|
| `[]` | pending | no runs → wait then timeout (Q3-A) |
| all `skipped`/`neutral` | pending | ignore set empties the input → SC-001 |
| `[success]` | green | |
| `[success, success]` | green | |
| `[success, skipped]` | green | skipped ignored |
| `[failure]` | not-passed | |
| `[success, failure]` | not-passed | any failure blocks |
| `[cancelled]` | not-passed | |
| `[timed_out]` | not-passed | |
| `[action_required]` | not-passed | |
| `[null]` (in-progress) | pending | |
| `[success, null]` | pending | in-progress outweighs a lone success |
| `[failure, null]` | not-passed | failure outranks in-progress |

### Invariants
- Never returns `green` for an empty or all-skipped set (SC-001).
- `green` requires ≥1 concrete `success`.
- Pure and total — no throw, no I/O.
