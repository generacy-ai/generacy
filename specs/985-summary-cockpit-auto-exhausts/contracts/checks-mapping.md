# Contract: `checks` field mapping (Q1=A)

**Scope**: Deterministic translation from `PrSnapshot.checksRollup` (`packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts:6`) to the wire-format `checks` field on doorbell event lines.

## Signature

```ts
type ChecksRollup = 'pending' | 'success' | 'failure' | 'none' | 'error';
type WireChecks  = 'green' | 'red' | 'pending';

function mapChecks(rollup: ChecksRollup): WireChecks {
  switch (rollup) {
    case 'success':          return 'green';
    case 'failure': case 'error': return 'red';
    case 'pending': case 'none':  return 'pending';
  }
}
```

## Emit rule

The producer (`SmeeDoorbellSource.processEventBlock`) MUST:

1. Compute `wire = mapChecks(snap.checksRollup)`.
2. Attach `checks: wire` to the event **iff** `wire === 'green' || wire === 'red'`.
3. Otherwise, **omit** the `checks` field entirely (Q4=A).

The 3-value enum `'green' | 'red' | 'pending'` remains the schema type (Q4=A rejects a 4th sentinel). The producer never writes `checks: 'pending'` on the wire; the value exists only as an intermediate result of `mapChecks`. From the consumer's perspective, `checks === 'pending'` and `checks === undefined` are indistinguishable and MUST be handled identically (fall back to one authoritative merge-gate query — agency #437 Q4=B).

## Rationale

- `success` → `green`: all required checks passed. Safe positive signal.
- `failure` / `error` → `red`: at least one required check failed or errored. Merge is definitely blocked on check state.
- `pending` → `pending`: at least one required check hasn't reported yet. Skill re-queries at the terminal gate.
- `none` → `pending` (**not** `green`): a repo with no CI configured looks the same as a repo where required checks haven't posted yet. Mapping `none` to `green` would risk a premature "safe to merge" signal for a still-provisioning workflow; a single skill-side re-query resolves the ambiguity authoritatively.

## PR mergeability is NOT folded in (Q1=A)

Mergeability is not part of `checks`. It reaches the skill via the `merge-conflicts` label (dispatch class D.11), which is already carried on the event's `labels` array and reflected in `to`. Conflating check state and mergeability would muddy the field and require two upstream lookups where one suffices.

## Cost profile (Q2=D)

- `mapChecks` is pure — a single `switch`. Zero I/O.
- The `snap.checksRollup` read is an O(1) `Map.get` against `SmeeDoorbellSource.prev`, which is populated as a side effect of the pre-existing periodic aggregate refresh (`maybeRefreshAggregate`). Doorbell adds **no new** `gh` calls, no debounced refresh, no targeted PR queries.
- Staleness bound: up to one poll interval. Acceptable because the skill re-queries authoritatively at the terminal merge gate; interior events benefit from the fast path.

## Test matrix

| `snap.checksRollup` | Cached snap present? | Event kind | Expected `checks` on wire |
|---------------------|----------------------|------------|---------------------------|
| `success`           | yes                  | `pr-checks` | `"green"` |
| `success`           | yes                  | `label-change` (sourceLabel=`completed:validate`) | `"green"` |
| `success`           | yes                  | `label-change` (sourceLabel=`agent:paused`) | *(absent — presence rule)* |
| `failure`           | yes                  | `pr-checks` | `"red"` |
| `error`             | yes                  | `pr-checks` | `"red"` |
| `pending`           | yes                  | `pr-checks` | *(absent — mapped to `pending`, omitted)* |
| `none`              | yes                  | `pr-checks` | *(absent)* |
| —                   | no (cache miss)      | `pr-checks` | *(absent)* |
| —                   | —                    | `issue-closed` / `pr-merged` / `pr-closed` | *(absent — presence rule)* |

All rows above are FR-008d assertions.
