# Data Model: Reconcile review/remediate docs with shipped behavior (#1167)

This change introduces no new entities. It edits three existing artifacts whose
"schema" is a document structure, an ordered list, or a type union. Documented here
for review completeness.

## Entity 1 — `WAITING_PIPELINE_ORDER` (ordered list)

- **File**: `packages/cockpit/src/state/precedence.ts:26`
- **Type**: `string[]`
- **Semantics**: earlier index wins the `waiting` tie-break slot when multiple `waiting-for:*` / `blocked:*` labels coexist. Labels absent from the list fall back to the `WORKFLOW_LABELS` index (non-deterministic relative to listed entries).
- **Change (FR-008)**: insert two entries.

Resulting relative order (unchanged entries elided):

```
… 'waiting-for:implementation-review',
   'waiting-for:remediation-limit',   // NEW — review-loop pause, in the review cluster
   'waiting-for:manual-validation',
   'waiting-for:ci',                  // NEW — final merge-readiness wait, least urgent → last
```

**Validation rule**: strings must exactly match emitted labels
(`waiting-for:remediation-limit`, `waiting-for:ci`). A mismatch silently reverts to
default-fallback ordering with no error.

## Entity 2 — `STAGE_COMPLETE_PIPELINE_ORDER` (ordered list)

- **File**: `packages/cockpit/src/state/precedence.ts:71`
- **Type**: `string[]`
- **Semantics**: latest-phase-wins (lower index = closer to workflow end) for the `stage-complete` tier.
- **Change (FR-009)**: insert three entries.

Resulting head order:

```
'completed:validate',               // NEW — validate is the last phase → index 0
'completed:implementation-review',
'completed:remediate',              // NEW
'completed:review',                 // NEW
'completed:implement',
'completed:tasks-review',
… (existing tail unchanged)
```

**Validation rule**: strings must exactly match emitted `completed:*` labels.

## Entity 3 — `ReviewGate` (type union)

- **File**: `packages/workflow-engine/src/types/github.ts:256`
- **Type**: string-literal union
- **Change (FR-010)**: add two members.

```ts
export type ReviewGate =
  | 'spec-review'
  | 'clarification'
  | 'clarification-review'
  | 'plan-review'
  | 'tasks-review'
  | 'implementation-review'
  | 'manual-validation'
  | 'address-pr-feedback'
  | 'children-complete'
  | 'remediation-limit'   // NEW
  | 'ci';                 // NEW
```

**Consumers**: `UpdatePhaseInput.phase`, `CheckGateInput.phase`,
`LabelStatus.configuredGates`. Widening only — no exhaustiveness site forces a new
runtime branch.

## Documents (no schema; prose corrections)

| Document | Section | Correction |
|----------|---------|------------|
| `review-remediate-migration.md` | §2 auto-narrowing (FR-001) | scope to `speckit-bugfix` |
| `review-remediate-migration.md` | §2 default cmd (FR-003) | `pnpm test && pnpm build` |
| `review-remediate-migration.md` | §3 precedence (FR-002) | repo tier only for `*Command` keys |
| `review-remediate-migration.md` | §5 `remediation-limit` (FR-004) | drop "retired"; flag-OFF/flag-ON contrast |
| `bugfix-profile-config.md` | §Precedence (FR-002) | repo tier only for `*Command` keys |

## Code comments (no schema; wording corrections — FR-006)

| File | Site | Correction |
|------|------|------------|
| `phase-loop.ts` | `remediateTrigger?` doc (~:135) | scope deadness to undefined default; drop "concrete triggers land in later epic issues" |
| `phase-loop.ts` | inline (~:1753) | scope "dead in production" to the undefined-default case |
