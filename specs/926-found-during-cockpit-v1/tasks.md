# Tasks: Found during the cockpit v1

**Input**: Design documents from `/specs/926-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/classifier-precedence.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- **US1**: Auto-session sees the PR-feedback engage edge
- **US2**: Auto-session sees the PR-feedback completion edge
- **US3**: Terminal label state is clean after any handler return

## Phase 1: Baseline verification

- [X] T001 Confirm `WAITING_PIPELINE_ORDER` in `packages/cockpit/src/state/precedence.ts` still matches the pre-change layout in plan.md §Design Overview (7 entries, `blocked:stuck-feedback-loop` at index 0, `waiting-for:implementation-review` at index 5). If the file has drifted, reconcile before proceeding.
- [X] T002 Confirm `packages/orchestrator/src/worker/pr-feedback-handler.ts` still has the four terminal returns documented in spec.md §FR-005 (Case A ~line 222, Case B ~line 232, blocked-stuck ~lines 302 and 337, happy ~line 357). Record actual line numbers if they've shifted — later tasks reference them. **Verified**: Case A ~line 223 (`await this.removeFeedbackLabel` then `return`), Case B ~line 247 (`return` — retains label by design), blocked-stuck at lines 302 and 337 (`await this.addBlockedStuckFeedbackLoopLabel` then `return`), happy ~line 357 (`await this.removeFeedbackLabel(...)` then log then function end).

## Phase 2: Precedence table change (US1, US2)

- [X] T003 [US1][US2] In `packages/cockpit/src/state/precedence.ts`, insert `'waiting-for:address-pr-feedback'` as index 1 of `WAITING_PIPELINE_ORDER` (immediately after `'blocked:stuck-feedback-loop'`, before `'waiting-for:spec-review'`). Match the exact array shape in `specs/926-found-during-cockpit-v1/contracts/classifier-precedence.md` §Precedence table.
- [X] T004 [US1][US2] In the same `precedence.ts`, update the docstring (~lines 20–25) to remove `address-pr-feedback` from the "unlisted, falls back to `WORKFLOW_LABELS` index" list. Add a brief inline comment above the new index-1 entry citing #926 and #883 precedent (see plan.md §Design Overview Part 1 for the exact comment wording).
- [X] T005 [P] [US1][US2] Extend `packages/cockpit/src/__tests__/classifier.test.ts` with the six required outputs in `contracts/classifier-precedence.md` §Classifier behavior — required outputs (all `sourceLabel` assertions for the `address-pr-feedback` pairings, including the `blocked:stuck-feedback-loop` outranks-both invariant). Existing classifier assertions must continue to pass unchanged (SC-001 + contract §Classifier behavior — invariants NOT to break).

## Phase 3: Event-plane assertions (US1, US2)

- [X] T006 [US1][US2] Add or extend event-stream tests at `packages/cockpit/src/__tests__/event-stream.test.ts` (create if absent — the plan flags this as "may be a new file or extended"). Assert:
  - **Add edge**: label transition `{implementation-review}` → `{implementation-review, address-pr-feedback}` emits exactly one `issue-transition` event with `to = waiting-for:address-pr-feedback` (SC-002, FR-003).
  - **Remove edge**: label transition `{implementation-review, address-pr-feedback}` → `{implementation-review}` emits exactly one `issue-transition` event with `to = waiting-for:implementation-review` (SC-002, FR-004).
  - Payload shape unchanged (FR-011 out-of-scope guard).

## Phase 4: Handler structural exit refactor (US3)

- [X] T007 [US3] In `packages/orchestrator/src/worker/pr-feedback-handler.ts`, add a new private method `clearInProgressLabel(github, owner, repo, issueNumber): Promise<void>` mirroring `removeFeedbackLabel`'s shape — best-effort `try/catch`, non-fatal on failure, logged at `warn`. Method calls `github.removeLabels(owner, repo, issueNumber, ['agent:in-progress'])`. (Design in plan.md §Design Overview Part 2 and data-model.md §PrFeedbackHandler.)
- [X] T008 [US3] In the same `pr-feedback-handler.ts`, wrap the body of `handle(item, checkoutPath)` (setup through all four terminal returns) in `try { ... } finally { await this.clearInProgressLabel(github, owner, repo, issueNumber); }`. The `finally` block must not throw and must not depend on any variable declared inside the `try` body — hoist `owner`, `repo`, `issueNumber`, and `github` above the `try` (they're already destructured near the top of the method).
- [X] T009 [US3] Replace the happy-path exit at ~line 357: instead of calling `removeFeedbackLabel(...)` followed by the `finally` clear, call `github.removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback', 'agent:in-progress'])` as a **single** invocation (FR-006, Q3→A). The `finally` clear becomes a no-op on this path (GitHub `removeLabels` is idempotent on already-absent labels) — leave the `finally` in place as a backstop.
- [X] T010 [US3] SC-005 structural guard: after T007–T009 land, run `grep -c "'agent:in-progress'" packages/orchestrator/src/worker/pr-feedback-handler.ts` and confirm **exactly one** code-site match for the removal literal (the coalesced happy-path `removeLabels([..., 'agent:in-progress'])` **or** the `clearInProgressLabel` body — pick one; the design collapses the two write sites to a single logical clear-point). Doc comments referencing the label name don't count against SC-005 but should be minimised. **Verified**: `grep -c` returns 1 — the single site is the `AGENT_IN_PROGRESS_LABEL` module constant; both the coalesced happy-path removal and `clearInProgressLabel` reference it.

## Phase 5: Handler-completion tests (US3)

- [X] T011 [P] [US3] Create or extend `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` with **four scenarios**, one per terminal return, each asserting the post-return label set:
  - **Happy path**: `agent:in-progress` absent; `waiting-for:implementation-review` + `agent:paused` remain (fresh D.3-ready gate). SC-004 line 1.
  - **Case A** (no unresolved threads): `agent:in-progress` absent. SC-004 line 2.
  - **Case B** (all comments untrusted, `waiting-for:address-pr-feedback` retained by design): `agent:in-progress` absent; `waiting-for:address-pr-feedback` still present. SC-004 line 3.
  - **Blocked-stuck** (both dispositions at ~lines 302 and 337): `agent:in-progress` absent; `blocked:stuck-feedback-loop` + `waiting-for:address-pr-feedback` present as designed. SC-004 line 4.
  Also assert: the happy-path scenario observes **exactly one** `removeLabels` call (with both labels in the array) — pins the FR-006 coalescing so a regression to two-call form breaks the build.

## Phase 6: End-to-end fixture (US1, US2, US3)

- [X] T012 [US1][US2][US3] Add an end-to-end fixture test (location per existing cockpit E2E convention — likely under `packages/cockpit/src/__tests__/`) that drives the full sequence and asserts a `cockpit_await_events` / `watch` consumer receives the completion transition within one polling cadence:
  1. Seed labels `{waiting-for:implementation-review, agent:paused}` on a fixture issue.
  2. Simulate the server-side loop adding `waiting-for:address-pr-feedback` → assert consumer receives exactly one `issue-transition` event with `to = waiting-for:address-pr-feedback`.
  3. Simulate handler completion removing `waiting-for:address-pr-feedback` (and `agent:in-progress`, which was present during the loop) → assert consumer receives exactly one `issue-transition` event with `to = waiting-for:implementation-review` (SC-003, the auto re-review trigger).

## Phase 7: Polish and verification

- [X] T013 Run `pnpm --filter @generacy-ai/cockpit test` — all classifier, event-stream, and fixture tests green. Watch for accidental displacement of existing sourceLabel assertions (contract §Classifier behavior — invariants NOT to break). **Result**: 262 tests pass (13 test files); pre-existing SourceLabel assertions untouched.
- [X] T014 Run `pnpm --filter @generacy-ai/orchestrator test` — all `pr-feedback-handler` tests green across the four terminal-return scenarios. No unrelated worker-test regressions. **Result**: `pr-feedback-handler.test.ts` — 32 pass; `pr-feedback-integration.test.ts` — 36 pass. 5 pre-existing failures in `label-sync-service.classify.test.ts` and `label-manager.*.test.ts` verified to reproduce on `develop` base — unrelated `classifyLabelProvisioningError` module-export error, not caused by this fix.
- [X] T015 Confirm no changes to `auto.md` D.3 / D.4 dispatch tables (FR-007) and no changes to the `issue-transition` event payload shape (FR-011 out-of-scope). `git diff` should touch only the two production files, the classifier + event-stream + handler test files, and the fixture — no playbook or wire-shape edits. **Result**: diff touches 2 production files + 4 test files (2 new + 2 modified) + spec bookkeeping. No touches to `auto.md`, `packages/generacy/.../watch/diff.ts`, or the `CockpitEvent` type definition.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T003, T004 (precedence edit needs verified baseline)
- T002 → T007, T008, T009 (handler refactor needs verified terminal-return line numbers)
- T003 → T004 (docstring update follows the array edit, same file)
- T003 → T005 (classifier tests target the new precedence)
- T003 → T006 (event-stream tests exercise the new sourceLabel behavior)
- T007 → T008 (finally block calls the new private method)
- T008 → T009 (happy-path coalescing edit assumes the try/finally wrapper is in place)
- T009 → T010 (SC-005 grep check runs after all handler edits land)
- T007–T010 → T011 (handler-completion tests target the refactored exit paths)
- T003–T011 → T012 (E2E fixture exercises the full stack)
- All implementation and test tasks → T013–T015 (final polish + verification)

**Parallel opportunities within phases**:
- T005 (classifier tests, `packages/cockpit`) and T006 (event-stream tests, `packages/cockpit`) can be authored in parallel with each other and with T003/T004 (source edits) since they touch different files.
- T011 (handler tests, `packages/orchestrator`) can be authored in parallel with T005/T006 (`packages/cockpit`) — different packages, no shared files.
- T005 and T006 are both marked `[P]` — they touch different test files (`classifier.test.ts` vs `event-stream.test.ts`) and share no data.
- T011 is `[P]` for the same reason relative to T005 / T006 (`packages/orchestrator` vs `packages/cockpit`).

**Non-parallel by file conflict**:
- T003 and T004 both edit `precedence.ts` — sequential.
- T007, T008, T009, T010 all touch `pr-feedback-handler.ts` — sequential.

---

*Generated by speckit*
