# Contract: Cockpit classifier `error`-tier `blocked:*` promotion (#943)

This contract governs the behaviour of `@generacy-ai/cockpit`'s pure classifier for the two enumerated error-tier `blocked:*` labels. It is the reference the classifier unit tests (`packages/cockpit/src/__tests__/classifier.test.ts`) enforce.

## Function under contract

```ts
import { classify } from '@generacy-ai/cockpit';
import { mapLabelToState } from '@generacy-ai/cockpit/state/label-map';

classify(labels: Iterable<string>): { state: CockpitState; sourceLabel: string };
mapLabelToState(label: string): CockpitState;
```

## Enumerated allow-list

The two labels that classify as `error` (`ERROR_BLOCKED_LABELS` in `label-map.ts`):

- `blocked:stuck-merge-conflicts`
- `blocked:stuck-validate-fix`

Every other `blocked:*` name — including `blocked:stuck-feedback-loop`, and any future addition to `WORKFLOW_LABELS` under the same prefix — MUST classify as `waiting`. This is the safe default; promoting a new blocked label requires an explicit edit to the allow-list.

## `mapLabelToState` contract

| Input | Output |
|-------|--------|
| `'blocked:stuck-merge-conflicts'` | `'error'` |
| `'blocked:stuck-validate-fix'` | `'error'` |
| `'blocked:stuck-feedback-loop'` | `'waiting'` |
| `'blocked:some-future-name'` | `'waiting'` (if the name is in `WORKFLOW_LABELS`) |
| Any name not in `WORKFLOW_LABELS` and not `'closed'` | `'unknown'` |

## `classify` single-label contract

| Input | Output |
|-------|--------|
| `['blocked:stuck-merge-conflicts']` | `{ state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }` |
| `['blocked:stuck-validate-fix']` | `{ state: 'error', sourceLabel: 'blocked:stuck-validate-fix' }` |
| `['blocked:stuck-feedback-loop']` | `{ state: 'waiting', sourceLabel: 'blocked:stuck-feedback-loop' }` |
| `['agent:error']` | `{ state: 'error', sourceLabel: 'agent:error' }` |
| `['failed:plan']` | `{ state: 'error', sourceLabel: 'failed:plan' }` |

## `classify` intra-`error` tie-break contract

`ERROR_PIPELINE_ORDER` in `precedence.ts`:

```
[
  'blocked:stuck-merge-conflicts',   // rank 0
  'blocked:stuck-validate-fix',      // rank 1
]
```

Rules:

1. If both candidates are listed: lower `indexOf` wins.
2. If exactly one candidate is listed: the listed one wins.
3. If neither candidate is listed: fall through to `workflowLabelIndex(label)` (existing behaviour).

Examples:

| Input labels (any order) | Winning `sourceLabel` | Reason |
|--------------------------|-----------------------|--------|
| `['blocked:stuck-merge-conflicts', 'agent:error']` | `'blocked:stuck-merge-conflicts'` | listed > unlisted |
| `['blocked:stuck-merge-conflicts', 'failed:validate']` | `'blocked:stuck-merge-conflicts'` | listed > unlisted |
| `['blocked:stuck-validate-fix', 'agent:error']` | `'blocked:stuck-validate-fix'` | listed > unlisted |
| `['blocked:stuck-validate-fix', 'failed:implement']` | `'blocked:stuck-validate-fix'` | listed > unlisted |
| `['blocked:stuck-merge-conflicts', 'blocked:stuck-validate-fix']` | `'blocked:stuck-merge-conflicts'` | lower `ERROR_PIPELINE_ORDER` index |
| `['agent:error', 'failed:plan']` | (existing behaviour by `workflowLabelIndex`) | neither listed |
| `['failed:plan', 'failed:tasks']` | (existing behaviour by `workflowLabelIndex`) | neither listed |

## Cross-tier contract

The classifier's outer loop picks the lowest-`TIER_RANK` winner first. `error` (rank 1) beats `waiting` (rank 2), so when a `blocked:stuck-merge-conflicts` co-occurs with `waiting-for:merge-conflicts`, the result MUST land in the `error` tier with the `blocked:*` label as `sourceLabel`:

```
classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts'])
  === { state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }
```

Symmetrically for the validate-fix pair:

```
classify(['waiting-for:validate-fix', 'blocked:stuck-validate-fix'])
  === { state: 'error', sourceLabel: 'blocked:stuck-validate-fix' }
```

## Preserved invariants (regression guards)

The following contracts from prior features MUST still hold after this change:

- `#883` — `classify(['blocked:stuck-feedback-loop'])` → `{ waiting, blocked:stuck-feedback-loop }`.
- `#883` — `classify(['waiting-for:address-pr-feedback', 'blocked:stuck-feedback-loop'])` → `{ waiting, blocked:stuck-feedback-loop }`.
- `#926` — `classify(['waiting-for:address-pr-feedback', 'waiting-for:implementation-review'])` → `{ waiting, waiting-for:address-pr-feedback }`.
- `#841` — `TERMINAL_COMPLETED_LABELS` promotion of `completed:*` to `terminal` unchanged.
- Canary — `classify(['failed:plan', 'completed:specify'])` → `{ error, failed:plan }` (error beats stage-complete).

## Downstream consumer expectations

- `cockpit status` renders `sourceLabel` in the state column. After this change, an issue carrying `waiting-for:merge-conflicts` + `blocked:stuck-merge-conflicts` displays as `error / blocked:stuck-merge-conflicts` instead of `waiting / waiting-for:merge-conflicts`.
- `cockpit watch` / `cockpit_await_events` emit a state transition when `sourceLabel` changes. Adding `blocked:stuck-merge-conflicts` to an already-`waiting-for:merge-conflicts` issue MUST fire a transition event with the `blocked:*` label in `sourceLabel`.
- Agency-side auto-mode routing (out of scope for this repo): consumes the `sourceLabel` and dispatches to the D.11 merge-conflicts escalation gate when the label is `blocked:stuck-merge-conflicts`, and to the analogous validate-fix gate when the label is `blocked:stuck-validate-fix`. Consumers wanting the general error signal can inspect the full label set.
