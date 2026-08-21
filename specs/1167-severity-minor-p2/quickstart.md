# Quickstart: Reconcile review/remediate docs with shipped behavior (#1167)

No installation, CLI, or runtime surface changes. This is a docs + comments +
enumeration-ordering sync. Use this as the implement/review checklist.

## What changes

1. **Docs** — 2 files, 5 passages corrected (FR-001–FR-004).
2. **Code comments** — `phase-loop.ts` residual wording (FR-006). FR-005/FR-007 verified already-resolved.
3. **Enumerations** — `precedence.ts` (2 lists) + `github.ts` (`ReviewGate` union) (FR-008–FR-010). FR-011 verified already-resolved.

## Apply

Edit in place per `plan.md` § Scope of edits. No new files. No dependency changes.

## Verify (SC-001 – SC-004)

Run these greps — each should show the corrected state and none of the stale phrasing:

```bash
# FR-003: default validate command
grep -n "pnpm test && pnpm build" docs/docs/guides/generacy/review-remediate-migration.md
! grep -n "pnpm build && pnpm test" docs/docs/guides/generacy/review-remediate-migration.md

# FR-004: no "retired" framing
! grep -ni "retired" docs/docs/guides/generacy/review-remediate-migration.md

# FR-005: comment already gone (verify-and-skip)
! grep -rn "will supply the reader" packages/orchestrator/src/worker/claude-cli-worker.ts

# FR-006: residual future-tense wording removed
! grep -n "concrete triggers land in later epic issues" packages/orchestrator/src/worker/phase-loop.ts

# FR-008: new waiting gates present
grep -n "waiting-for:remediation-limit\|waiting-for:ci" packages/cockpit/src/state/precedence.ts

# FR-009: new completed labels present
grep -n "completed:validate\|completed:review\|completed:remediate" packages/cockpit/src/state/precedence.ts

# FR-010: ReviewGate union widened
grep -n "'remediation-limit'\|'ci'" packages/workflow-engine/src/types/github.ts
```

Then run the existing suites unchanged (SC-004 — zero behavior diffs):

```bash
pnpm --filter @generacy-ai/cockpit test
pnpm --filter @generacy-ai/workflow-engine test
pnpm --filter @generacy-ai/orchestrator test
```

Docusaurus build (docs sanity — `onBrokenLinks: 'throw'`):

```bash
pnpm --dir docs build
```

## Changeset

Add `.changeset/1167-reconcile-review-remediate-docs.md`:

```markdown
---
'@generacy-ai/cockpit': patch
'@generacy-ai/workflow-engine': patch
---

Reconcile review/remediate docs, comments, and gate/type enumerations with
shipped behavior (#1167). Cockpit `WAITING_PIPELINE_ORDER` /
`STAGE_COMPLETE_PIPELINE_ORDER` gain the review/remediate gate + completed labels
for deterministic ordering; `ReviewGate` union widened to include
`remediation-limit` and `ci`. No runtime behavior change.
```

## Troubleshooting

- **Cockpit tie-break tests fail after the reorder**: an existing snapshot may pin
  the old ordering. Confirm the change is ordering-only and update the snapshot to
  the Q2/Q3 order — do not change gate semantics.
- **Label typo silently ineffective**: if a new `precedence.ts` string does not
  match the emitted label exactly, ordering falls back to default with no error.
  Cross-check against the emitted labels in `label-definitions.ts` /
  `pr-feedback-handler.ts`.
