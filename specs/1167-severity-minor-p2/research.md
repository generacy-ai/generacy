# Research: Reconcile review/remediate docs with shipped behavior (#1167)

All decisions are grounded in the clarifications batch (2026-08-21) and verified
against branch HEAD (base `ea0b2437`, post #1156/#1160/#1161). The source of truth
for every FR is the cited *symbol*, not the original `155b3464` line number (Q1).

## Decision 1 — Re-anchor to HEAD; verify-and-skip already-resolved FRs (Q1→A)

**Decision**: Treat FR-005, FR-007, FR-011 as verify-and-skip no-ops; FR-006 as
verify-and-fix (residual wording only). Only change what is still inaccurate.

**Verification at HEAD**:
- FR-005 — `grep "will supply the reader" claude-cli-worker.ts` → 0 hits. Reader wired in #1156. **Resolved.**
- FR-007 — `config.ts:76` documents `ciWaitTimeoutMs: workflow → cluster (config.ciWaitTimeoutMs) (no repo tier)`. Accurate (#1160). **Resolved.**
- FR-011 — `seed-aware-review-executor.ts:73` computes `round = (prior?.round ?? 0) + 1`, stamped into finding.round (`:90`) and artifact.round (`:102`). No `round: 0` literal (#1161 collapse). **Resolved.**
- FR-006 — `phase-loop.ts:135` and `:1753` still carry "dead in production" / "concrete triggers land in later epic issues". A concrete `remediateTrigger` landed at `claude-cli-worker.ts:969`. **Fix residual wording.**

**Rationale**: Following FR line numbers literally would edit whatever now occupies
those regions. Re-anchoring to the symbol avoids introducing new inaccuracies.

**Alternatives rejected**: (B) force literal edits — would reword accurate comments
into satisfying stale acceptance wording. (C) drop FR-005–FR-007 entirely — loses
the genuine FR-006 fix.

## Decision 2 — `WAITING_PIPELINE_ORDER` positions (Q2→A)

**Decision**: `waiting-for:remediation-limit` immediately after
`waiting-for:implementation-review`; `waiting-for:ci` at the very end (after
`waiting-for:manual-validation`).

**Rationale**: `precedence.ts` is earlier-index-wins. `remediation-limit` is a
review-loop pause and belongs in the review-gate cluster; `ci` is the final
merge-readiness wait (least-urgent → last). Adding them makes ordering
deterministic instead of falling back to the `WORKFLOW_LABELS` index.

## Decision 3 — `STAGE_COMPLETE_PIPELINE_ORDER` positions (Q3→A)

**Decision**: `completed:validate` at index 0, then `completed:implementation-review`,
`completed:remediate`, `completed:review`, `completed:implement`, … (existing tail
unchanged).

**Rationale**: This list is latest-phase-wins (lower index = closer to workflow
end). `validate` is the last phase → index 0. `review`/`remediate` run between
`implement` and `validate`; remediate-before-review preserves existing relations
with minimal disturbance.

## Decision 4 — `ReviewGate` union widening (FR-010)

**Decision**: Add `'remediation-limit'` and `'ci'` to the `ReviewGate` union in
`packages/workflow-engine/src/types/github.ts:256`.

**Rationale**: Type completeness for gate-ordering/consumption sites
(`UpdatePhaseInput.phase`, `CheckGateInput.phase`, `LabelStatus.configuredGates`).
The gate *labels* already ship (`waiting-for:remediation-limit` from #1124,
`waiting-for:ci` from #1133); this only records them in the union. No runtime
behavior change.

## Decision 5 — FR-004 replacement wording (Q5→A)

**Decision**: Reword `blocked:stuck-feedback-loop` as the legacy pre-epic (flag-OFF)
bounded stop still active when the review phase is disabled; frame
`waiting-for:remediation-limit` as the resumable flag-ON equivalent. Drop
"retired"/"replaces".

**Evidence the label is live**: `pr-feedback-handler.ts:45,617-624,1239-1261`
re-applies it on the no-diff/push-failed flag-OFF cycle; `precedence.ts:29`
comments it as "Retained as the legacy (flag-OFF) PR-feedback bounded stop".

## Decision 6 — FR-001 auto-narrowing scope (FR-001)

**Decision**: Scope the migration-guide auto-narrowing/diff-classification section
to `speckit-bugfix`.

**Evidence**: `phase-loop.ts:698` guards `resolveTargetedValidate` behind
`if (context.item.workflowName === 'speckit-bugfix')`; the block comment at `:691`
states "for speckit-bugfix … Every other workflow reaches the plain default
unchanged (SC-005)."

## Decision 7 — Default validate command (FR-003)

**Decision**: Quote the built-in default as `pnpm test && pnpm build`.

**Evidence**: `config.ts:38` `export const DEFAULT_VALIDATE_COMMAND = 'pnpm test && pnpm build';`

## Verification approach (SC-001 – SC-004)

- SC-001/SC-002/SC-003: grep each corrected passage/comment/enumeration against the
  cited symbol; grep-confirm the misleading phrases ("retired", "pnpm build && pnpm
  test", "will supply the reader", "dead in production" residuals) are gone.
- SC-004: run the existing test suites for `@generacy-ai/cockpit`,
  `@generacy-ai/workflow-engine`, and the orchestrator worker unchanged; assert no
  behavior diffs. Enumeration edits only affect tie-break ordering determinism.

## Sources

- `specs/1167-severity-minor-p2/spec.md`, `clarifications.md`
- `packages/orchestrator/src/worker/config.ts`, `phase-loop.ts`, `pr-feedback-handler.ts`, `seed-aware-review-executor.ts`, `claude-cli-worker.ts`
- `packages/cockpit/src/state/precedence.ts`
- `packages/workflow-engine/src/types/github.ts`
- `docs/docs/guides/generacy/review-remediate-migration.md`, `docs/docs/reference/bugfix-profile-config.md`
