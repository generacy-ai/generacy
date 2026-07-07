# Tasks: `cockpit advance` label-pair fix (#845)

**Input**: Design documents from `/specs/845-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, quickstart.md, contracts/advance-command.md, contracts/manual-advance-marker.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = the sole story: "operator runs `cockpit advance` on a poll-only cluster and the worker resumes")

## Phase 1: Tests First (regression + fixture updates)

Both test files are independent — updates are on the same happy-path test only in `advance.test.ts`, but land in one file, so no [P] between T001 and T002 for the shared advance.test.ts.

- [ ] T001 [P] [US1] Update `formatManualAdvanceComment` fixtures in `packages/generacy/src/cli/commands/cockpit/__tests__/advance-marker.test.ts`:
  - "with actor" case → expected sentence:
    ``Marked `completed:<gate>` by **@<actor>** — `waiting-for:<gate>` left in place for the worker to clear on resume.``
  - "without actor" (undefined and empty-string) case → expected sentence:
    ``Marked `completed:<gate>` — `waiting-for:<gate>` left in place for the worker to clear on resume.``
  - HTML-prelude fixtures unchanged (`<!-- generacy-cockpit:manual-advance gate=… actor=… ts=… -->` is byte-stable per contract).
  - Validation-error test cases (bad gate, bad actor, bad ts) unchanged.

- [ ] T002 [US1] Update happy-path assertion in `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` (lines ~36–60):
  - Drop `'remove:waiting-for:clarification'` from the expected `calls` array — new expected: `['comment', 'add:completed:clarification']` (or equivalent shape matching the existing test's call-log convention).
  - Update stdout assertion to match new summary: `advanced <ref>: completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume (comment: <url>)`.
  - Do NOT change idempotence-branch test (exits 0 with `already advanced …`) or gate-refusal test (exits 3) — they never reach the removed step.

- [ ] T003 [US1] Add regression test in `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` (SC-003 signal):
  - In or immediately after the happy-path test, assert that `gh.removeLabel` is never called with any label starting with `waiting-for:`.
  - Shape (adapt to existing mock convention):
    ```ts
    const removeSpy = gh.removeLabel as ReturnType<typeof vi.fn>;
    for (const call of removeSpy.mock.calls) {
      expect(call[2]).not.toMatch(/^waiting-for:/);
    }
    ```
  - Test name suggestion: `advance never removes waiting-for:* on the happy path`.
  - Deleting the fix in T005 MUST make this test fail deterministically.

## Phase 2: Core Implementation
<!-- Phase boundary: T001–T003 should exist as failing / updated tests before T004–T005 land, so the fix flips them green. -->

- [ ] T004 [P] [US1] Update sentence text in `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts` (line ~30–31):
  - With actor: ``Marked `completed:<gate>` by **@<actor>** — `waiting-for:<gate>` left in place for the worker to clear on resume.``
  - Without actor: ``Marked `completed:<gate>` — `waiting-for:<gate>` left in place for the worker to clear on resume.``
  - HTML prelude line UNCHANGED (byte-stable per contract — scanned by `clarification-comment-finder.ts`).
  - Regex validation and thrown-error paths UNCHANGED.

- [ ] T005 [US1] Fix `runAdvance` in `packages/generacy/src/cli/commands/cockpit/advance.ts`:
  - Delete the `try/catch` block around `removeLabel(waitingLabel)` (lines ~169–176 in current source). Steps 1 (postIssueComment) and 2 (addLabel completed:*) remain in order.
  - Update stdout summary line (lines ~178–181) to:
    `advanced <ref>: completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume (comment: <url>)`
    - `(comment: <url>)` suffix emitted only when `commentUrl` is truthy (unchanged).
  - Rewrite the file-header block comment (lines ~1–14) around the label-pair invariant per plan.md §Design Overview — Q2→C. Include: poll-path resume requires BOTH labels present; worker owns cleanup of `waiting-for:*`, `completed:*`, and `agent:paused`; do not remove `waiting-for:*` here; reference #845. Enumerate side effects as (1) `gh issue comment` (2) `gh issue edit --add-label completed:<gate>`.
  - Idempotence check (line ~115: `completed:<gate>` present → early return) UNCHANGED.
  - Refusal check (line ~123: active `waiting-for:*` ≠ requested gate → exit 3) UNCHANGED.
  - No `--force` flag introduced.

## Phase 3: Downstream Documentation (Q1→C surface 3)
<!-- Phase boundary: verify against the shipped CLI text before touching docs to avoid drift. -->

- [ ] T006 [US1] Update operator-facing cockpit CLI docs referencing the old arrow-form phrasing (`waiting-for:X → completed:X`) to the new persistence-oriented phrasing.
  - Locate: grep for the arrow-form under `docs/` and `specs/788-*/` (and any successor cockpit-CLI surface reference doc under `specs/` referenced by #788).
  - Update matching operator-facing text to the phrasing from `contracts/advance-command.md` §Stdout summary. Do NOT touch machine-parsed log formats or internal-only comments.
  - `specs/845-found-during-cockpit-v1/quickstart.md` — already updated during /plan; verify only.
  - If NO matches found in-repo, close the task with a note in the PR description that surface-3 lives out-of-repo (e.g. `tetrad-development/docs/label-protocol.md` — not in this PR's scope; tracked in the cross-repo Related refs).

## Phase 4: Validation & Polish

- [ ] T007 [US1] Run the two focused test files and confirm green:
  ```bash
  pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/advance.test.ts
  pnpm --filter @generacy-ai/generacy test src/cli/commands/cockpit/__tests__/advance-marker.test.ts
  ```
  - Expected: all pass, including the new SC-003 regression case from T003.

- [ ] T008 [P] [US1] Run the full generacy package test + typecheck to confirm no collateral breakage:
  ```bash
  pnpm --filter @generacy-ai/generacy test
  pnpm --filter @generacy-ai/generacy typecheck
  ```

- [ ] T009 [US1] Local smoke test per `quickstart.md`:
  - On a poll-only cluster (webhooks not delivering), run `generacy cockpit advance <owner>/<repo>#<n> --gate clarification` on a paused test issue.
  - Immediately after: `gh issue view <ref> --json labels -q '.labels[].name'` → BOTH `waiting-for:clarification` and `completed:clarification` present.
  - After one poll interval (~30s): both labels + `agent:paused` gone; worker resumed.
  - If the smoke test cannot be run in the current environment, mark task complete with a note ("verified by unit tests only; smoke test deferred to reviewer") — do not fabricate an outcome.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001, T002, T003 (Phase 1 tests) → land before T004, T005 (Phase 2 impl). The test file may temporarily fail between phases; that is intentional (RED→GREEN signal for SC-002/SC-003).
- T002 must precede T003 (same file, but T003 extends the happy-path test T002 edits — order avoids merge friction).
- T005 (advance.ts) depends on T004 only in a soft sense: the stdout summary and marker sentence together tell one coherent story; landing them in a single commit is preferable. If split, land T004 first (marker is purely descriptive) then T005.
- T006 (docs) may run any time after T005 — the docs describe the shipped CLI text.
- T007, T008, T009 (validation) run last, after T004 and T005 are merged.

**Parallel opportunities**:
- T001 [P] and T002 touch different test files — can run in parallel by different agents.
- T004 [P] (marker.ts) and T005 (advance.ts) touch different source files — can be parallelized if you accept two commits; otherwise land together.
- T008 [P] (full-package test/typecheck) is independent of T007's focused run.

**Not parallel**:
- T002 and T003 (same file, same test).
- T007 must precede T009 (unit tests before smoke test).

## Notes

- Zero new files, zero new dependencies, zero new types (per data-model.md).
- `packages/orchestrator/src/services/label-monitor-service.ts` is intentionally NOT modified — the fix conforms to its existing label-pair contract (research.md Decision 1).
- HTML prelude on the marker comment is byte-stable — do not "clean up" the format string in T004 (contract I in `contracts/manual-advance-marker.md`).
- The `remove:waiting-for:*` failure-mode row in `advance.ts`'s error message table is deleted along with the call itself (contract note in `contracts/advance-command.md` §Failure modes).
