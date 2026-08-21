# Implementation Plan: Flag-matrix guardrails for the review/remediate epic

**Feature**: Resolve four un-decided/unguarded corners of the review/remediate flag matrix (#1165)
**Branch**: `1165-severity-major-p2-feature`
**Status**: Complete

## Summary

The engine-native review/remediate epic (#1120) shipped behind two default-`false` flags —
`reviewPhaseEnabled` (`WORKER_REVIEW_PHASE_ENABLED`) and `ciMergeGateEnabled`
(`WORKER_CI_MERGE_GATE_ENABLED`). A post-merge review found four corners of that
flag matrix that are un-decided or unguarded. Each is resolved into an explicit,
tested behavior. All four decisions are already made (`/clarify` → D1–D4 = A):

1. **Corner 1 (D1=A)** — Restore an autonomous flag-OFF fallback fixer. On a
   default cluster a `validate` failure currently escalates straight to
   `failed:validate` with no autonomous fix attempt. Give it **one bounded
   remediate attempt** (reusing the already-wired `RemediateExecutor`) before
   escalating.
2. **Corner 2 (D2=A)** — Keep `blocked:stuck-feedback-loop`'s bounded-stop
   behavior (no production change) and correct the migration guide's "retired"
   wording.
3. **Corner 3 (D3=A)** — speckit-bugfix intentionally carries the relocated
   `on-ci-green` `implementation-review` gate under `ciMergeGateEnabled === true`
   (no production change to the #1133 transform). Lock it in with a test.
4. **Corner 4 (D4=A)** — Gate the `getPhaseSequence` fallback to exclude `review`
   (and, by construction, `remediate`) for unknown workflows, so `review` never
   runs without a matching gate map — removing the uncapped-loop precondition.

Every corner is pinned by a test (SC-003). Flag-OFF named-workflow behavior stays
byte-identical except where D1 explicitly alters it (FR-009).

## Technical Context

- **Language / runtime**: TypeScript, Node ≥ 22, ESM.
- **Package**: `@generacy-ai/orchestrator` (worker phase-loop machinery). All
  production changes are orchestrator-internal — no cross-package public API
  change (spec Assumptions §93, confirmed at `/plan`).
- **Test framework**: Vitest.
- **Docs**: Docusaurus site under `docs/` (outside `pnpm-workspace.yaml`; the
  Corner 2 wording edit is a plain Markdown change, no changeset).
- **Feature flags** (both default `false`, unchanged by this feature):
  `WorkerConfig.reviewPhaseEnabled`, `WorkerConfig.ciMergeGateEnabled`.

## Grounding — code locations per corner

### Corner 1 — flag-OFF validate-fix fallback (FR-001, FR-002)

- `phase-loop.ts:971-1090` — the **flag-ON** validate-fix routing. On a `validate`
  failure with `config.reviewPhaseEnabled === true` and a linked PR it: builds a
  fingerprint + failure alert, applies the `-repeated` backstop at the repeat
  threshold, synthesizes a `changes-required` review artifact
  (`writeReviewArtifact`, carrying `remediationCount` / `markedReadyByEngine`
  forward), sets the block-local `pendingValidateRemediation = true`, and
  backtracks to `review` (`i = sequence.indexOf('review') - 1`).
- `phase-loop.ts:1092-1108` — the **fall-through escalation** path
  (`buildErrorEvidence` → `escalateAndAlert` → `failed:validate`). This is what a
  flag-OFF validate failure hits today (the regression).
- `phase-loop.ts:1754-1849` — the review→remediate **seam** that consumes
  `pendingValidateRemediation` / the changes-required artifact and dispatches
  `deps.remediateExecutor.execute(context)`, with the push-gate
  (`shouldPush = exitCode === 0 || timedOut`) + revert-on-non-push + `i--`
  re-entry pattern. **Unreachable in a flag-OFF run** because `review` is not in
  the sequence and the seam is gated on `phase === 'review'`.
- `remediate-executor.ts` — `RemediateExecutor.execute(context)` reads the review
  artifact, filters open blocking findings, builds the charter, resolves the agent
  via `resolveReviewLikeAgent(config, workflowName, 'remediate')`, spawns the CLI,
  and bumps `remediationCount` on every return path. **The shared fixer** reused
  by Corner 1.
- `claude-cli-worker.ts:950-955, 967` — `remediateExecutor` is constructed and
  wired into `executeLoop` deps **unconditionally** (not flag-gated). So
  `deps.remediateExecutor` is available on the flag-OFF path — no new wiring
  needed.

**Fix shape**: at the validate-failure site, before the escalation fall-through,
add a flag-OFF branch guarded on `phase === 'validate' && config.reviewPhaseEnabled
!== true && !flagOffValidateFixAttempted && deps.remediateExecutor`. It synthesizes
the same `changes-required` artifact as the flag-ON path (factored into a shared
private helper to avoid divergence), sets `flagOffValidateFixAttempted = true`
(binds to exactly one attempt), runs `deps.remediateExecutor.execute(context)`,
applies the same `shouldPush` push-gate + revert-on-non-push as the seam, then
`i--` to re-run `validate`. The second validate failure fails the guard
(`!flagOffValidateFixAttempted` is now false) → falls through to the existing
escalation → `failed:validate`. Because `review` is absent from the flag-OFF
sequence, remediate runs **inline here**, not via the seam.

### Corner 2 — `blocked:stuck-feedback-loop` docs vs behavior (FR-003, FR-004)

- `pr-feedback-handler.ts:45` — `BLOCKED_STUCK_FEEDBACK_LOOP_LABEL =
  'blocked:stuck-feedback-loop'`; applied at `:632`
  (`if (!cliSelfCommitted && (!success || !hasChanges))`). This is the only
  bounded stop for the #883 runaway on the flag-OFF PR-feedback legacy path
  (the monitor skips all `blocked:*` labels). **No production change** (D2=A).
- `docs/docs/guides/generacy/review-remediate-migration.md:140` — reads
  "This replaces the retired `blocked:stuck-feedback-loop` dead-end …". **Correct
  the "retired" wording** to reflect that the label retains its bounded-stop role
  on the flag-OFF PR-feedback path; only the human-approval/remediation-limit
  pause superseded the *epic-path* use of it.

### Corner 3 — speckit-bugfix `on-ci-green` gate (FR-005, FR-006)

- `config.ts:217-223` — default `speckit-bugfix` gates; line 219 is
  `{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition:
  'on-request' }`.
- `config.ts:229-247` — the #1133 flag-conditional relocation transform. When
  `ciMergeGateEnabled === true` it rewrites **every**
  `waiting-for:implementation-review` gate to `{ phase: 'validate', condition:
  'on-ci-green' }`, so speckit-bugfix gains the post-validate gate. **No
  production change** (D3=A keeps the transform uniformly label-based). Add a test
  asserting the resulting speckit-bugfix gate set under both `ciMergeGateEnabled`
  states.

### Corner 4 — unknown-workflow uncapped review↔remediate loop (FR-007, FR-008)

- `types.ts:85-91` — `getPhaseSequence(workflowName, reviewPhaseEnabled=false)`.
  Falls back to `PHASE_SEQUENCE` (which includes `review`) for any workflow not in
  `WORKFLOW_PHASE_SEQUENCES`.
- `gate-checker.ts:67-80` — `checkGates` returns `[]` when
  `config.gates[workflowName]` is `undefined` (unknown workflow) → no
  `on-remediation-limit` gate ever applied → uncapped loop.
- `claude-cli-worker.ts:921` — the production caller threads
  `getPhaseSequence(...)`'s result straight into `executeLoop`.

**Fix shape**: in `getPhaseSequence`, when the workflow is **unknown**
(`WORKFLOW_PHASE_SEQUENCES[workflowName] === undefined`), always drop `review`
(and `remediate` — which is off-sequence anyway) from the fallback sequence,
regardless of `reviewPhaseEnabled`. Known workflows keep the flag-conditional
behavior. Single-point fix; the production caller threads the result, so no
downstream change is needed.

## Project Structure

```
packages/orchestrator/src/worker/
  types.ts                      # MOD  Corner 4: gate getPhaseSequence fallback
  phase-loop.ts                 # MOD  Corner 1: flag-OFF one-shot remediate fallback
  config.ts                     # (unchanged) Corner 3 transform already correct
  gate-checker.ts               # (unchanged) Corner 4 root cause, fixed upstream
  pr-feedback-handler.ts        # (unchanged) Corner 2 behavior already correct
  __tests__/
    phase-loop.flag-off-validate-fix.test.ts   # NEW  FR-002 (Corner 1)
    get-phase-sequence.test.ts                 # NEW/MOD FR-008 (Corner 4)
    config.bugfix-ci-gate.test.ts              # NEW  FR-006 (Corner 3)
    pr-feedback-stuck-loop.test.ts             # NEW/MOD FR-003/FR-004 (Corner 2)
docs/docs/guides/generacy/
  review-remediate-migration.md # MOD  Corner 2: correct "retired" wording
.changeset/
  1165-flag-matrix-guardrails.md              # NEW  @generacy-ai/orchestrator patch
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository — constitution
check skipped.

## Changeset

`.changeset/1165-flag-matrix-guardrails.md` — `@generacy-ai/orchestrator`
**patch**. Corner 1 is the only non-test production change under
`packages/*/src/` (a behavior fix in `phase-loop.ts` + `types.ts`, no new public
exports); `workflow:speckit-bugfix` → `patch` per the CLAUDE.md changeset gate.
Corner 2's doc edit is outside `packages/*/src/` (no changeset). Corners 2/3 have
test-only additions (exempt).

## Risks & Mitigations

- **Corner 1 double-fix / infinite loop**: the block-local
  `flagOffValidateFixAttempted` boolean bounds the fallback to exactly one attempt
  per run; the second failure escalates. Mirrors the flag-ON path's repeat
  backstop intent without introducing a new counter.
- **Corner 1 dirty-tree contamination on a failed fixer**: reuse the seam's
  revert-on-non-push (`discardWorkingTreeChanges(['.generacy'])`) so an
  unsuccessful remediate cannot land partial work on the branch.
- **Corner 4 over-filtering a known workflow**: the fix keys strictly on
  `WORKFLOW_PHASE_SEQUENCES[workflowName] === undefined`, so speckit-feature /
  speckit-bugfix / speckit-epic are untouched (FR-009 byte-identical guard).
- **FR-009 regression**: existing flag-OFF tests remain green; new Corner-1 test
  is the only one asserting altered flag-OFF behavior, and only for the
  validate-failure path.

## Next Step

`/speckit:tasks` — generate the task list from this plan.
