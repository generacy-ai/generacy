# Contract: `startup_failure` / `stale` are failing conclusions (#1157 FR-006)

Extends the #1133 `aggregateCiVerdict` contract. Pure, total, zero I/O — unchanged.

## Change

`FAILING_CONCLUSIONS` (`packages/workflow-engine/src/actions/github/client/ci-verdict.ts`)
gains two members:

```ts
const FAILING_CONCLUSIONS = new Set<string>([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',  // NEW (#1157 FR-006)
  'stale',            // NEW (#1157 FR-006)
]);
```

`CiConclusion` (`packages/workflow-engine/src/types/github.ts`) gains
`'startup_failure' | 'stale'`.

`IGNORED_CONCLUSIONS` (`skipped`, `neutral`) is UNCHANGED (US3 AC — existing behavior
preserved).

## Truth table (rows added / confirmed)

| Runs (after dropping ignored) | Verdict | Status |
|---|---|---|
| `[{completed, startup_failure}]` | `not-passed` | NEW |
| `[{completed, stale}]` | `not-passed` | NEW |
| `[{completed, success}, {completed, startup_failure}]` | `not-passed` | NEW (failure precedence) |
| `[{completed, skipped}]` | `pending` | unchanged (skipped ignored → empty → pending) |
| `[{completed, neutral}]` | `pending` | unchanged |
| `[{completed, success}]` | `green` | unchanged |
| `[]` | `pending` | unchanged (SC-001) |

## Rationale

Before this change `startup_failure`/`stale` were unknown to the aggregator: not in
`FAILING_CONCLUSIONS` (survive rule 1), not `success` (survive rule 3), so they fell to
rule 4 → `pending`. A `pending` verdict forces `waitForCiGreen` to poll to the full
`ciWaitTimeoutMs` then pause with a misleading `timeout` reason for a PR that is
actually red. Classifying them as failing yields an immediate `not-passed` → the
recoverable red-CI pause with the correct reason (FR-006 / SC-005 / US3).

## Precedence (unchanged)

failing (rule 1) > in-progress (rule 2) > success (rule 3) > pending (rule 4). Adding
members to the failing set only strengthens rule 1; a `green` verdict still requires ≥1
concrete `success` and no failing/in-progress run.
