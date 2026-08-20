# Contract: Label vocabulary additions

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

## New labels

```ts
{ name: 'waiting-for:ci', color: 'FBCA04', description: 'Validate passed; awaiting CI to go green on the ready PR' },
{ name: 'completed:ci',   color: '0E8A16', description: 'CI merge-readiness gate satisfied' },
```

- `waiting-for:ci` color matches the other `waiting-for:*` gate labels (`FBCA04`).
- `completed:ci` color matches the other `completed:*` labels (`0E8A16`).

## Semantics
- `waiting-for:ci` is applied together with `agent:paused` when the CI-wait exceeds `ciWaitTimeoutMs` on a `pending` verdict (Q1-C / FR-004). It is a resumable pause — never a terminal `blocked:*`.
- `completed:ci` records CI gate satisfaction, for resume-detection consistency with other gates.

## Changeset impact
New label vocabulary in `workflow-engine` → **`minor`** bump per CLAUDE.md changeset rules.
