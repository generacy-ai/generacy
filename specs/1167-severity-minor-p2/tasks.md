# Tasks: Reconcile review/remediate docs with shipped behavior

**Input**: Design documents from `/specs/1167-severity-minor-p2/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Documentation reconciliation (US1)

- [X] T001 [P] [US1] In `docs/docs/guides/generacy/review-remediate-migration.md` §2
  (`### Guardrails when the default command is auto-narrowed`, ~lines 50-71),
  scope the entire diff-classification / auto-narrowing description to
  `speckit-bugfix` only (FR-001). Source of truth: `phase-loop.ts:698`
  (`if (context.item.workflowName === 'speckit-bugfix')`). Make explicit that the
  feature workflow reaches the plain default with no narrowing.

- [X] T002 [P] [US1] In `docs/docs/guides/generacy/review-remediate-migration.md`
  (~lines 52-53), fix the quoted built-in default validate command from
  `pnpm build && pnpm test` to `pnpm test && pnpm build` (FR-003). Source of truth:
  `worker/config.ts:38` (`DEFAULT_VALIDATE_COMMAND = 'pnpm test && pnpm build'`).

- [X] T003 [P] [US1] In `docs/docs/guides/generacy/review-remediate-migration.md` §3
  (~lines 76-78), correct the config-key precedence prose (FR-002): the repo
  (`orchestrator.*`) tier exists **only** for `validateCommand` /
  `preValidateCommand`; `maxRemediations`, `ciWaitTimeoutMs`, and `review.*`
  resolve workflow → built-in default with no repo tier. Source of truth:
  `worker/config.ts:57-61` / `config.ts:73-77`.

- [X] T004 [P] [US1] In `docs/docs/guides/generacy/review-remediate-migration.md` §5
  (~lines 140-142), remove the "retired" / "replaces" framing of
  `blocked:stuck-feedback-loop` (FR-004, per Q5→A). Reword it as the legacy
  pre-epic (flag-OFF) bounded stop still active when the review phase is disabled,
  and frame `waiting-for:remediation-limit` as the resumable flag-ON equivalent.
  Preserve the flag-OFF/flag-ON contrast. Source of truth:
  `pr-feedback-handler.ts:45,617-624`.

- [X] T005 [P] [US1] In `docs/docs/reference/bugfix-profile-config.md` §Precedence
  (~lines 69-73), apply the same precedence correction as T003 (FR-002):
  "workflow → repo → cluster default" holds only for the two `*Command` keys;
  `maxRemediations` and the `review.*` sub-fields resolve workflow → built-in
  review baseline with no repo tier.

## Phase 2: Code comment fixes (US2)

- [X] T006 [US2] In `packages/orchestrator/src/worker/phase-loop.ts`, fix the two
  residual future-tense / "dead in production" comments about `remediateTrigger`
  (FR-006, verify-and-fix): the `remediateTrigger?` doc block (~lines 132-139) and
  the inline comment (~line 1753). Reword so deadness is scoped to the *undefined
  default* only — a concrete `remediateTrigger` did land at
  `claude-cli-worker.ts:969`, so the seam is live in production when wired. Do not
  change any control flow (SC-004).

- [X] T007 [US2] Verify-and-skip FR-005 and FR-007 (already resolved at HEAD by
  #1156 / #1160). Confirm via grep that `claude-cli-worker.ts` has 0 hits for
  "will supply the reader", and that `config.ts:76` `ciWaitTimeoutMs` comment
  already documents the per-workflow override precedence. No edit; note resolved
  in the PR description.

## Phase 3: Enumeration completeness (US3)

- [X] T008 [P] [US3] In `packages/cockpit/src/state/precedence.ts`
  `WAITING_PIPELINE_ORDER` (~lines 26-57, earlier-index-wins, per Q2→A), insert
  `'waiting-for:remediation-limit'` immediately after
  `'waiting-for:implementation-review'` and append `'waiting-for:ci'` at the very
  end (after `'waiting-for:manual-validation'`) (FR-008). Match the emitted label
  strings exactly — a typo silently keeps the default-fallback ordering.

- [X] T009 [P] [US3] In `packages/cockpit/src/state/precedence.ts`
  `STAGE_COMPLETE_PIPELINE_ORDER` (~lines 71-85, latest-phase-wins, per Q3→A),
  insert `'completed:validate'` at index 0, then `'completed:implementation-review'`,
  `'completed:remediate'`, `'completed:review'`, `'completed:implement'`, …
  (validate at top; remediate before review, both between implementation-review
  and implement) (FR-009). Note: T008 and T009 edit the same file — coordinate as
  one edit pass if run together.

- [X] T010 [P] [US3] In `packages/workflow-engine/src/types/github.ts`, extend the
  `ReviewGate` union (~line 256) with `| 'remediation-limit'` and `| 'ci'`
  (FR-010). Type-surface only — no new capability.

- [X] T011 [US3] Verify-and-skip FR-011 (already unified at HEAD by #1161).
  Confirm `seed-aware-review-executor.ts` uses a single `round` source
  (`round = (prior?.round ?? 0) + 1` stamped into both `finding.round` and
  `artifact.round`) with no `round: 0` literal. No edit; note resolved in the PR.

## Phase 4: Changeset & verification

- [X] T012 Add `.changeset/1167-reconcile-review-remediate-docs.md`. The two `src/`
  enumeration edits (`packages/cockpit/src/state/precedence.ts`,
  `packages/workflow-engine/src/types/github.ts`) trigger the changeset gate.
  Bumps: `@generacy-ai/cockpit` **patch** (deterministic ordering additions, no new
  public export) and `@generacy-ai/workflow-engine` **patch** (`ReviewGate` union
  widened with existing gate labels; internal type completeness). Single file, both
  bumps. Docs-only edits do not themselves trigger the gate.

- [X] T013 Verify SC-004 (zero behavior change): run the existing test suites for
  the touched packages (`@generacy-ai/cockpit`, `@generacy-ai/workflow-engine`,
  `@generacy-ai/orchestrator`) and confirm they pass unchanged. Run targeted grep
  assertions confirming each corrected doc passage / comment / enumeration entry
  matches its cited source symbol (SC-001, SC-002, SC-003).

## Dependencies & Execution Order

- **Phase 1 (T001-T005)**: All parallelizable. T001-T004 edit the same file
  (`review-remediate-migration.md`) at different sections — if edited by one agent,
  batch them into a single pass; the `[P]` marks section independence, not
  file independence. T005 is a separate file, fully parallel.
- **Phase 2 (T006-T007)**: Independent of Phase 1. T006 edits `phase-loop.ts`;
  T007 is verification-only.
- **Phase 3 (T008-T011)**: Independent of Phases 1-2. T008 and T009 edit the same
  file (`precedence.ts`) — coordinate as one edit pass. T010 is a separate file.
  T011 is verification-only.
- **Phase 4 (T012-T013)**: T012 (changeset) depends on the enumeration edits
  (T008-T010) existing. T013 (verification) is the final gate — run after all
  edits land.

**Parallel opportunities**: Phases 1, 2, and 3 have no cross-dependencies and can
proceed concurrently. Within Phase 3, T008+T009 share a file (serialize), T010 is
independent.
