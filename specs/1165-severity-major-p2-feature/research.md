# Research: Flag-matrix guardrails (#1165)

All four decisions were resolved in `/clarify` (D1–D4 = A). This document records
the *why* behind each and the codebase evidence that grounds the chosen fix, so
the implementer can judge edge cases.

## Decision 1 (Corner 1) — Restore a flag-OFF fallback fixer

**Chosen**: On a default (flags-OFF) cluster, a `validate` failure gets **one
bounded autonomous fix attempt** (via the shared `RemediateExecutor`) before
escalating to `failed:validate`.

**Rationale**: Flag-OFF is the default deployment. The epic (#1129/#1158) gated the
validate-fix routing on `reviewPhaseEnabled === true` and deleted the pre-epic
base-advance / `ValidateFixHandler` one-shot, so every default-cluster validate
failure now escalates with no autonomous attempt — a real regression from pre-epic
behavior. FR-009 explicitly carves Corner-1 changes out of the byte-identical
guarantee, so one bounded attempt is in-scope.

**Implementation approach considered**:

- *A (chosen): inline one-shot at the validate-failure site.* With the flag OFF,
  `getPhaseSequence` drops `review`, so there is no `review` phase to backtrack to
  and the `phase === 'review'` remediate seam never fires. The fallback therefore
  runs `RemediateExecutor` **inline** at the validate-failure point, bounded by a
  block-local `flagOffValidateFixAttempted` boolean, then re-runs `validate` via
  `i--`. Reuses the seam's `shouldPush` push-gate and revert-on-non-push.
- *B (rejected): synthesize a review phase into the flag-OFF sequence.* Would
  reintroduce `review` into a flag-OFF run, violating the #1121 byte-identical
  guarantee (spurious stage-comment rows, shifted `startIndex`) for the non-failing
  path.
- *C (rejected): resurrect the deleted `ValidateFixHandler` one-shot.* The epic
  deliberately retired that adapter and consolidated both origins on
  `RemediateExecutor` (#1158). Bringing it back forks the fixer path again.

**Key evidence**: `remediateExecutor` is constructed unconditionally in
`claude-cli-worker.ts:950-955` and wired into `executeLoop` deps at `:967` — it is
available regardless of the flag, so Approach A needs no new wiring. The flag-ON
artifact-synthesis block (`phase-loop.ts:1038-1075`) is the exact shape to factor
into a shared helper the flag-OFF branch also calls.

**Bounding**: exactly one attempt per run. The second validate failure fails the
guard (`!flagOffValidateFixAttempted`) and falls through to the pre-existing
escalation. No new persisted counter — the bound is block-local, matching "one
bounded fix attempt before escalation" (D1=A) precisely.

## Decision 2 (Corner 2) — Keep behavior, fix docs

**Chosen**: Keep `blocked:stuck-feedback-loop`'s bounded-stop behavior unchanged;
correct the migration guide's "retired" wording.

**Rationale**: It is the only bounded stop for the #883 runaway on the flag-OFF
PR-feedback legacy path — the PR-feedback monitor skips **all** `blocked:*` labels,
so this label is what terminates the runaway. FR-004 makes preserving that bound an
invariant regardless of which side of Corner 2 wins. Fixing the docs is zero-risk;
changing the label's role risks a #883 re-regression.

**Evidence**: `pr-feedback-handler.ts:45` defines the label; `:632` applies it on
`(!success || !hasChanges)` (with the `!cliSelfCommitted` guard). The
migration-guide claim at `review-remediate-migration.md:140` ("retired … dead-end")
is accurate only for the *epic review/remediate path*, where
`waiting-for:remediation-limit` (a resumable pause) supersedes it. On the flag-OFF
legacy PR-feedback path the label is still load-bearing. The wording fix must
scope the "retired" claim to the epic path and affirm the label's surviving role on
the legacy path.

## Decision 3 (Corner 3) — Carry the gate intentionally

**Chosen**: speckit-bugfix intentionally carries the relocated `on-ci-green`
`implementation-review` gate under `ciMergeGateEnabled === true`. No change to the
#1133 transform; add a test.

**Rationale**: `ciMergeGateEnabled` is opt-in and its purpose is a post-validate
CI-green merge checkpoint across speckit workflows. Excluding bugfix would let it
merge with no checkpoint exactly when the operator asked for one, and keeps the
#1133 transform uniformly label-based (matching on `gateLabel` only). Its
pre-epic `condition: 'on-request'` was dead code (no evaluator handled that
condition), so no behavior is being *removed* — a previously-inert gate becomes
active under the opt-in flag.

**Evidence**: `config.ts:219` (bugfix `on-request` gate on `implement`) +
`config.ts:229-247` (transform rewrites every `waiting-for:implementation-review`
to `{ phase: 'validate', condition: 'on-ci-green' }` when the flag is on). The
test asserts the resulting speckit-bugfix gate set under **both** flag states
(off: `{ phase: 'implement', condition: 'on-request' }`; on: `{ phase: 'validate',
condition: 'on-ci-green' }`).

## Decision 4 (Corner 4) — Exclude review from the fallback

**Chosen**: Gate the `getPhaseSequence` fallback to exclude `review` (and
`remediate`) for unknown workflows — no review phase without a matching gate map.

**Rationale**: The review phase is a speckit concept paired with a specific gate
map. `checkGates` returns `[]` for any workflow not in `config.gates`, so an
unknown workflow that runs `review` never gets the `on-remediation-limit` cap → an
uncapped review↔remediate loop. Grafting the default gate set onto an arbitrary
custom workflow (the rejected option B) injects unrelated gates. Excluding review
**fails closed** — it removes the loop's precondition rather than retrofitting a
cap onto a sequence the engine doesn't understand (SC-002).

**Evidence**: `types.ts:85-91` (`getPhaseSequence` fallback to `PHASE_SEQUENCE`
includes `review` when the flag is on); `gate-checker.ts:67-80` (`checkGates`
returns `[]` for undefined `config.gates[workflowName]`); `claude-cli-worker.ts:921`
(production caller threads the sequence into `executeLoop`). `remediate` is
off-sequence in all sequences (never a linear member), so excluding `review`
removes the only entry point to the loop for unknown workflows.

**Fix locus**: single point in `getPhaseSequence`. Because the only production
caller threads the returned sequence directly to `executeLoop`, gating the fallback
there is sufficient — no separate guard in `phase-loop.ts` or `gate-checker.ts`.

## Cross-cutting: byte-identical guard (FR-009)

Named workflows (speckit-feature / speckit-bugfix / speckit-epic) with both flags
OFF must stay byte-identical except for the Corner-1 validate-failure path.
Corner 4 keys strictly on `WORKFLOW_PHASE_SEQUENCES[workflowName] === undefined`,
so named workflows are untouched. Corner 1's new branch is guarded on
`reviewPhaseEnabled !== true` **and** only activates on a validate *failure* — the
success path is unchanged. Existing flag-OFF tests are the regression net (SC-004).

## Changeset sizing

`pnpm why @generacy-ai/orchestrator` — no external monorepo consumer depends on the
worker internals being changed (phase-loop / types `getPhaseSequence` are internal
surface). Corner 1 is a bug-fix behavior change with no new public export →
`@generacy-ai/orchestrator` **patch**, `workflow:speckit-bugfix`. Single changeset
file.
