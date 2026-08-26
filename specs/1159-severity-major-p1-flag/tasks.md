# Tasks: External-feedback re-entry budget bounding + charter fencing + head-ref checkout

**Input**: Design documents from `/specs/1159-severity-major-p1-flag/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All source changes are inside `@generacy-ai/orchestrator`. The one cross-package
touch is an *import* of `wrapUntrustedData` from `@generacy-ai/workflow-engine`
(existing export, already a dependency). No new persisted state, no new label
vocabulary, no new dependencies. All behavior stays behind
`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED` (FR-008 / SC-005).

---

## Phase 1: Defect 1 — Bound the remediation budget (US1)

The load-bearing runaway fix. A blanket `failed:*` monitor skip is what makes the
existing `clearReviewArtifact` reachable only on the two legitimate reset occasions
(Q1→A / Q2→B), so the `on-remediation-limit` cap becomes globally reachable for free.

- [X] T001 [US1] Add a blanket `failed:*` re-enqueue skip in
  `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`. Mirror the
  existing `blocked:*` short-circuit at `:557` — `labels.some(l => l.startsWith('failed:'))`,
  no allow-list. Place it **after** the `waiting-for:remediation-limit` (`:473`) and
  `blocked:fixer-timeout` (`:505`) retry-eligible carve-outs so those remain reachable,
  grouped adjacent to the `blocked:*` gate. Match the `blocked:*` skip's log shape
  (structured skip log line). See `contracts/monitor-failed-skip.md`. (FR-003, INV-6)

- [X] T002 [US1] Verify no change is required at the two budget-lifecycle sites and
  document the reasoning inline where non-obvious:
  `clearReviewArtifact` (`claude-cli-worker.ts:593`, D-2 reset comment at `:580-592`)
  and `remediationCount: prior?.remediationCount ?? 0` (`seed-aware-review-executor.ts:96`).
  Confirm that with T001 in place these are reached only on operator-resume and
  genuinely-new-review occasions (INV-1, INV-2). No code change expected here — this is
  a correctness confirmation that gates Phase 4's SC-001 test design. (FR-001, FR-002, FR-002a)

---

## Phase 2: Defect 2 — Fence untrusted `detail` at the ingestion sites (US2)
<!-- Phase boundary: independent of Phase 1; both feed the same charter path -->

Wrap untrusted `detail` with `wrapUntrustedData` at the **two ingestion sites only**
(Q5→A). The charter (`remediate-charter.ts:60`) stays untouched and embeds the
already-fenced string verbatim. Engine-authored review findings are NOT wrapped (INV-4).

- [X] T003 [P] [US2] In `packages/orchestrator/src/worker/seed-aware-review-executor.ts`
  (`:70-78`, `detail: f.body` at `:75`), wrap the raw comment body:
  `detail: wrapUntrustedData(f.body, <pr-review-comment / author-login label>)`. Add the
  `wrapUntrustedData` import from `@generacy-ai/workflow-engine`
  (`src/security/untrusted-data-fence.ts`). The label is escaped by the fence, so an
  attacker-controlled author login cannot break out of `source="…"`. See
  `contracts/detail-fencing.md`. (FR-004)

- [X] T004 [P] [US2] In `packages/orchestrator/src/worker/phase-loop.ts` validate-evidence
  synthesis (`:1029-1055`, `detail` at `:1037`), wrap the validate output tail:
  `detail: wrapUntrustedData(boundOutputTail(\`${stdout}\n${stderr}\`), 'validate-output')`.
  Mirror the existing pattern at `validate-fix-handler.ts:235`. Add the
  `wrapUntrustedData` import if not already present. (FR-005)

---

## Phase 3: Defect 3 — Resolve branch from the PR head ref (US3)
<!-- Phase boundary: independent of Phases 1-2; touches the same worker file as T002 -->

On the `address-pr-feedback` re-entry only, resolve the working branch from the PR's
`head.ref` instead of `createFeature(issueNumber)` (Q4→C). Every other command keeps
`createFeature`.

- [X] T005 [US3] In `packages/orchestrator/src/worker/claude-cli-worker.ts`
  (`:461-501`, `createFeature({ number })` at `:491-495`), branch on
  `command === 'address-pr-feedback'` and resolve the working branch from the PR head
  ref via `getPullRequest(prNumber).head.ref` + `repoCheckout.switchBranch(...)` — the
  `pr-feedback-handler.ts:225` precedent. Apply the zero/one/many linked-PR rule:
  exactly one linked open PR → its `head.ref`; zero → keep the current `createFeature`
  fresh-request path (budget 0); more than one → park this poll and surface for operator
  attention (no mutation). See `contracts/head-ref-resolution.md`. (FR-006, INV-5)

- [X] T006 [US3] Confirm the single-PR path lets `commitPushAndEnsurePr('remediate')`
  update the existing PR rather than open a duplicate under slug drift (#1043). No new
  code expected beyond T005 — verify the head-ref checkout removes the dup-PR path and
  add an inline note if a guard is needed. (FR-007, INV-5)

---

## Phase 4: Verification — one focused test per success criterion
<!-- Phase boundary: depends on Phases 1-3 landing -->

Reuse the existing worker / monitor / charter test harnesses.

- [X] T007 [P] [US1] SC-001 budget-bounding integration test in
  `packages/orchestrator/src/worker/__tests__/claude-cli-worker.*.test.ts` (or its
  helpers): drive repeated same-feedback `address-pr-feedback` re-entries (N > maxRemediations),
  assert `remediationCount` is monotonic across entries and the PR parks at
  `waiting-for:remediation-limit` + `agent:paused` within `maxRemediations` total
  remediate executions (not per-entry).

- [X] T008 [P] [US1] SC-002 monitor-skip unit test in
  `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.*.test.ts`:
  a `failed:review`-labeled issue with unresolved human threads asserts 0 re-enqueues on
  subsequent polls. Add a case for an arbitrary future `failed:<x>` label to pin the
  blanket-prefix (no allow-list) contract.

- [X] T009 [P] [US2] SC-003 fencing tests: assert seed `detail` is wrapped in
  `<untrusted-data …>` in `seed-aware-review-executor.test.ts`, and validate-evidence
  `detail` is wrapped in `phase-loop.*.test.ts`. Assert engine-authored review-finding
  detail is NOT wrapped/altered (INV-4). Assert the crafted text never appears as bare
  charter instructions.

- [X] T010 [P] [US3] SC-004 head-ref / dup-PR integration test in the worker harness:
  with an issue-derived slug that diverges from the PR head branch, assert remediation
  commits land on the PR head branch and exactly 1 PR exists for the issue. Add a unit
  assertion for the `>1 linked open PR` park path.

- [X] T011 [P] SC-005 flag-OFF parity: confirm the existing flag-OFF path tests pass
  unchanged (no new test needed — the monitor `failed:*` skip only affects issues already
  carrying a `failed:*` label, and all other changes are on the flag-ON
  `address-pr-feedback` path). Run the flag-OFF suite and record the result.

---

## Phase 5: Changeset (CI gate)

- [X] T012 Add `.changeset/1159-*.md` — `@generacy-ai/orchestrator` **patch**
  (`workflow:speckit-bugfix`, defect fix, no new public exports). Must be a newly-added
  file in the PR diff. No `workflow-engine` changeset (its `src/` is not modified;
  `wrapUntrustedData` is only imported). See `research.md` Decision 5.

---

## Dependencies & Execution Order

**Phase boundaries** (sequential where noted):
- Phases 1, 2, 3 are independent of each other and may proceed in parallel *by
  concern*, but T002 (Phase 1) and T005/T006 (Phase 3) both edit
  `claude-cli-worker.ts`, so serialize those two edits.
- Phase 4 (tests) depends on Phases 1–3 landing.
- Phase 5 (changeset) can be added any time before the PR is opened.

**Parallel opportunities**:
- T003 and T004 are `[P]` — different files (`seed-aware-review-executor.ts` vs
  `phase-loop.ts`).
- T007–T011 are `[P]` — different test files, one per success criterion.

**Same-file serialization**:
- T002, T005, T006 all touch `claude-cli-worker.ts` — do NOT run in parallel.
- T004 and T009's phase-loop test are different files (`phase-loop.ts` src vs test) —
  safe to parallelize.

**Critical path**: T001 (monitor skip) is the load-bearing runaway fix and should land
first; SC-001/SC-002 verification depends on it.

## Next Step

Run `/speckit:implement` to begin execution.
