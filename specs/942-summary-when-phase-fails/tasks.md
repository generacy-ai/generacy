# Tasks: Repeat-Identical Phase Failure Detection

**Input**: Design documents from `/specs/942-summary-when-phase-fails/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = repeat-failure detection & escalation (single user story for #942)

## Phase 1: Fingerprint Primitive (foundation)

- [ ] T001 [US1] Extend `packages/orchestrator/src/worker/types.ts` — add `FailureFingerprint` type alias, extend `FailureAlertData` with `fingerprint: string` and `occurrence: number` fields, export `FAILURE_ALERT_MARKER_V2_REGEX = /<!-- fp:([0-9a-f]{16}):(\d+) -->/`. Do NOT modify `FAILURE_ALERT_MARKER_PREFIX`. Per `data-model.md` §"Marker regex" and §"Extended FailureAlertData".

- [ ] T002 [P] [US1] Create `packages/orchestrator/src/worker/failure-fingerprint.ts` — export `computeFailureFingerprint({ phase, evidence })` per `contracts/failure-fingerprint.md` semantics: classifier extraction from `evidence.exitDescriptor` (4 patterns + defensive fallback), reason-text selection (`evidence.reason ?? evidence.outputTail`), `sha256(phase + '\x00' + classifier + '\x00' + reasonText).slice(0, 16)` lowercase hex. Also export `parseFailureAlertMarker(commentBody)` per contract INV-M1..M4, plus constants `REPEAT_FAILURE_THRESHOLD = 2` and `FINGERPRINT_HEX_LENGTH = 16`. No external deps beyond `node:crypto`.

- [ ] T003 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/failure-fingerprint.test.ts` — assert all invariants from `contracts/failure-fingerprint.md`: INV-1 determinism, INV-2 runId-agnostic, INV-3 classifier-sensitive (`no-product-code-changes` vs `product-diff-error`), INV-4 phase-sensitive (`implement` vs `tasks`), INV-5 reason-text-sensitive, INV-6 outputTail-neutral. Marker parser tests: INV-M1 v1-tolerant returns `null`, INV-M2 order-independent, INV-M3 malformed returns `null`, INV-M4 multiple markers picks first. Include snappoll#8 replay case (three inputs collapse to one fingerprint).

## Phase 2: Marker v2 in Stage Comment Manager

<!-- Phase boundary: T001 must land first — types depended on by all downstream code -->

- [ ] T004 [US1] Modify `packages/orchestrator/src/worker/stage-comment-manager.ts` — update `renderFailureAlert()` so line 1 becomes `<!-- generacy:failure-alert:${stage}:${runId} --> <!-- fp:${fingerprint}:${occurrence} -->` (space-separated, per `contracts/failure-alert-marker-v2.md`). Threading: `postFailureAlert(FailureAlertData)` now receives the new `fingerprint` + `occurrence` fields (populated by caller). Body lines 2+ byte-identical to today.

- [ ] T005 [US1] Update `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts` — extend `BASE_ALERT` fixture with `fingerprint: 'test-fp-abcdef1234567890'` (16-char hex) and `occurrence: 1`. Add golden-string assertions per `contracts/failure-alert-marker-v2.md`: INV-C1 line-1 regex, INV-C2 exactly one space between markers, INV-C3 body lines 2+ unchanged. All pre-existing tests must still pass.

## Phase 3: Fingerprint History Tracker

<!-- Phase boundary: T002 must land first — tracker consumes `parseFailureAlertMarker` -->

- [ ] T006 [US1] Create `packages/orchestrator/src/services/failure-fingerprint-tracker.ts` — export interface `FailureFingerprintTracker` with `countPriorOccurrences(owner, repo, issue, fingerprint): Promise<number>`. Implement Q2→A default `GitHubCommentFailureFingerprintTracker` per `contracts/failure-fingerprint-tracker.md`: scans `github.getIssueComments()`, filters comments starting with `FAILURE_ALERT_MARKER_PREFIX`, counts matches via `parseFailureAlertMarker`. Fail-open: any throw → warn-log + return `0` (INV-T3).

- [ ] T007 [P] [US1] Create `packages/orchestrator/src/services/__tests__/failure-fingerprint-tracker.test.ts` — assert all invariants from tracker contract: INV-T1 zero-prior returns 0, INV-T2 counts N prior but excludes in-flight, INV-T3 storage failure returns 0 (never throws), INV-T4 non-marker + v1-marker comments skipped, INV-T5 ordering-independent. Mock `github.getIssueComments()` to return controlled comment arrays.

## Phase 4: Label Manager Escalation

<!-- Phase boundary: T001 must land first (types); independent of Phase 2/3 -->

- [ ] T008 [US1] Modify `packages/orchestrator/src/worker/label-manager.ts` — add `onRepeatedError(phase: WorkflowPhase): Promise<void>` per `data-model.md` §"LabelManager extension". Applies `failed:${phase}-repeated` via `applyLabels()` (idempotent), does NOT remove `failed:<phase>`. Wraps in existing `retryWithBackoff` with `site: 'error-repeated'`. Calls `ensureRepoLabelsExist` — extend any `KNOWN_LABEL_PREFIXES` whitelist to include `failed:*-repeated` if such gating exists.

- [ ] T009 [P] [US1] Update `packages/orchestrator/src/worker/__tests__/label-manager.test.ts` — add case for `onRepeatedError('implement')` that asserts `failed:implement-repeated` is applied and no other labels are added or removed. Verify idempotency (calling twice does not duplicate).

## Phase 5: Phase-Loop Wiring

<!-- Phase boundary: T002 + T006 + T008 must all land first (imports the primitives) -->

- [ ] T010 [US1] Modify `packages/orchestrator/src/worker/phase-loop.ts` — extract a private helper `escalateAndAlert(phase, evidence, stage, runId)` that (a) computes fingerprint via `computeFailureFingerprint`, (b) calls `tracker.countPriorOccurrences(item.owner, item.repo, item.issueNumber, fp)`, (c) always calls `labelManager.onError(phase)`, (d) if `occurrence >= REPEAT_FAILURE_THRESHOLD` also calls `labelManager.onRepeatedError(phase)` BEFORE alert-post, (e) calls `stageCommentManager.postFailureAlert({ stage, runId, phase, evidence, fingerprint, occurrence })`. Replace the 4-line inline pattern at all 6 failure sites (~332 pre-validate install, ~443 spawn error, ~502 post-phase, ~626 phase-command, ~678 product-diff, ~710 no-product-code-changes) with a single call to `escalateAndAlert()`. Inject `tracker` via `PhaseLoopDeps` (new optional field; default to a no-op stub for existing tests).

- [ ] T011 [US1] Modify `packages/orchestrator/src/worker/claude-cli-worker.ts` — thread `failureFingerprintTracker` from `ClaudeCliWorkerDeps` into `PhaseLoopDeps` at the `new PhaseLoop(...)` construction site. Add optional field to `ClaudeCliWorkerDeps` interface.

- [ ] T012 [US1] Modify `packages/orchestrator/src/server.ts` — construct `GitHubCommentFailureFingerprintTracker(github, server.log)` in the worker-mode branch after the `github` client is available, pass it via `ClaudeCliWorkerDeps.failureFingerprintTracker`. Fail-open at construction: if construction throws, log warn and pass `undefined` (worker keeps functioning without escalation).

- [ ] T013 [US1] Create `packages/orchestrator/src/worker/__tests__/phase-loop-repeat-failure.test.ts` — regression test proving snappoll#8 replay. Stub `github.getIssueComments()` to return sequentially 0, 1, then 2 v2-marked comments with the same fingerprint. Drive `phase-loop.runPhase()` (or the `escalateAndAlert()` helper directly) through the `no-product-code-changes` failure path. Assert: (a) 1st failure applies `failed:implement` only, no `-repeated`, (b) 2nd failure applies both `failed:implement` AND `failed:implement-repeated`, (c) alert comment on 2nd call carries `<!-- fp:HEX:2 -->` marker, (d) 3rd call with a DIFFERENT classifier resets the count and does NOT apply `-repeated`.

## Phase 6: Cockpit Resume Extension

<!-- Phase boundary: T008 must land first (defines the escalation label spelling) -->

- [ ] T014 [US1] Modify `packages/generacy/src/cli/commands/cockpit/resume.ts` — locate the `labelsToRemove` array (per plan #891 §"Implementation Sequence" step 2) and add `` `failed:${phase}-repeated` `` alongside the existing `` `failed:${phase}` ``. Best-effort removal (idempotent — `gh label remove` no-ops if absent). Update inline docstring/comment to mention the additional removal.

- [ ] T015 [P] [US1] Update `packages/generacy/src/cli/commands/cockpit/__tests__/resume.test.ts` — add a case where the issue carries both `failed:implement` and `failed:implement-repeated` and the operator runs `resume`. Assert both labels are cleared. Assert idempotency: running `resume` on an issue that only has `failed:implement` (no `-repeated`) does not fail.

## Phase 7: End-to-End Regression Coverage

<!-- Phase boundary: T004 + T010 + T014 must have landed -->

- [ ] T016 [US1] Run full test suite: `pnpm --filter @generacy-ai/orchestrator test failure-fingerprint`, `pnpm --filter @generacy-ai/orchestrator test phase-loop-repeat-failure`, `pnpm --filter @generacy-ai/orchestrator test stage-comment-manager`, `pnpm --filter @generacy-ai/orchestrator test label-manager`, `pnpm --filter @generacy-ai/generacy test resume`. All existing suites must still pass unchanged (regression bar: v1 marker consumers still match on `.includes(FAILURE_ALERT_MARKER_PREFIX)`, existing `runId` dedup at `stage-comment-manager.ts:346` still fires, pre-#942 comments parse to `null`).

## Dependencies & Execution Order

**Phase boundaries** (sequential):

- **Phase 1** (T001, T002, T003) — foundational types + primitives + tests. T001 unblocks everything downstream; T002/T003 can start once T001 lands.
- **Phase 2** (T004, T005) — needs T001 (types) + T002 (primitive is imported).
- **Phase 3** (T006, T007) — needs T002 (imports `parseFailureAlertMarker`). Independent of Phase 2.
- **Phase 4** (T008, T009) — needs T001. Independent of Phases 2/3.
- **Phase 5** (T010, T011, T012, T013) — needs T002 + T006 + T008 all landed. This is the wire-up phase.
- **Phase 6** (T014, T015) — needs T008 (defines the label spelling). Otherwise independent.
- **Phase 7** (T016) — all prior phases complete.

**Parallel opportunities within phases**:

- Phase 1: T002 and T003 both mark `[P]` (T003 tests can be written against T002's exports concurrently once T001 lands).
- Phase 2: T005 marks `[P]` — different file from T004; write against T004's updated render output.
- Phase 3: T007 marks `[P]` — tracker tests + tracker impl in same directory but different files.
- Phase 4: T009 marks `[P]` — test file separate from source.
- Phase 5: T010–T013 are sequential (each depends on the prior touching `phase-loop.ts` and its deps interface). T013 (test) can start once T010/T011 are written.
- Phase 6: T015 marks `[P]` — test file separate from source.

**Critical path** (blocking chain, all sequential): T001 → T002 → T006 → T010 → T011 → T012 → T013 → T016.

**Total task count**: 16 tasks (10 sequential, 6 parallel-eligible).

## Notes

- No new package dependencies. `crypto.createHash('sha256')` is the only new primitive; already available via `node:crypto`.
- Threshold N=2 is a hard-coded constant `REPEAT_FAILURE_THRESHOLD` per Q3→A resolution. No config surface exposed in v1.
- Q2→A (GitHub comment scan) is the default persistence path. If Q2 is re-resolved to B or C, only T006 changes shape (interface stable — swap constructor for a Redis-backed impl); T010–T013 unchanged.
- No changes to the retry/requeue mechanism itself. The escalation label is a signal for cockpit + operators; auto-halting on `failed:*-repeated` is a follow-up in cockpit-auto (`auto.md` D.7/D.8), tracked separately.
- Failure-alert body (lines 2+) remains byte-identical to today — only line 1 gains the sibling v2 marker.

---

*Generated by speckit* — Next step: `/speckit:implement` to begin execution.
