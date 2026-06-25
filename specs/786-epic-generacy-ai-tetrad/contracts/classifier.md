# Contract: `classify(labels)`

## Signature

```ts
function classify(labels: Iterable<string>): ClassifyResult;
```

## Inputs

- `labels` — any iterable of label-name strings. Order is ignored. Duplicates are deduplicated.

## Output

```ts
interface ClassifyResult {
  state: CockpitState;       // 'pending' | 'active' | 'waiting' | 'error' | 'terminal' | 'unknown'
  sourceLabel: string;       // exact label name that won, or '' if state === 'unknown'
}
```

## Behavior

1. Build a `Set<string>` from `labels`.
2. Filter to labels that appear in `WORKFLOW_LABELS`. Unknown labels are skipped — they cannot contribute to a curated state.
3. If the filtered set is empty, return `{ state: 'unknown', sourceLabel: '' }`.
4. For each remaining label, compute `tier = mapLabelToState(label)`.
5. Select the label with the lowest `TIER_RANK[tier]`.
6. Tie-break:
   - If the winning tier is `waiting`, prefer the label with the lowest index in `WAITING_PIPELINE_ORDER`. Labels not listed there sort after the listed ones, preserving `WORKFLOW_LABELS` order among themselves.
   - Otherwise, prefer the label with the lowest index in `WORKFLOW_LABELS`.
7. Return `{ state: tier, sourceLabel: winningLabel }`.

## Precedence rule

`terminal > error > waiting > active > pending` (curated tier).

Tie-break inside a tier:
- `waiting`: `spec-review → clarification → plan-review → tasks-review → implementation-review → manual-validation`.
- Any other tier: index in `WORKFLOW_LABELS`.

## Examples

| Input labels                                          | Output                                                  |
|-------------------------------------------------------|---------------------------------------------------------|
| `['phase:implement']`                                 | `{ state: 'active', sourceLabel: 'phase:implement' }`   |
| `['waiting-for:clarification', 'phase:clarify']`      | `{ state: 'waiting', sourceLabel: 'waiting-for:clarification' }` |
| `['closed', 'failed:implement']`                      | `{ state: 'terminal', sourceLabel: 'closed' }`           |
| `['waiting-for:plan-review', 'waiting-for:spec-review']` | `{ state: 'waiting', sourceLabel: 'waiting-for:spec-review' }` (pipeline order) |
| `['agent:error', 'agent:in-progress']`                | `{ state: 'error', sourceLabel: 'agent:error' }`        |
| `['some-random-label']`                               | `{ state: 'unknown', sourceLabel: '' }`                 |
| `[]`                                                  | `{ state: 'unknown', sourceLabel: '' }`                 |

## Invariants

- Pure function: no I/O, no allocations beyond the input set and one comparator pass.
- Idempotent: calling with the same input always yields the same output.
- Total over `WORKFLOW_LABELS`: every entry in `WORKFLOW_LABELS` produces a non-`unknown` state when passed alone.

## Error modes

None — the function never throws.
