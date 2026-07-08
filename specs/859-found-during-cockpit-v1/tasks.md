# Tasks: `cockpit merge` deletes the head branch after squash

**Input**: Design documents from `/specs/859-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: All tasks address the single fix in #859 (US1: cockpit-merge branch hygiene)

## Phase 1: Wrapper primitives (`packages/cockpit`)

- [ ] T001 [US1] Extend `PullRequestDetail` and its raw schema in `packages/cockpit/src/gh/wrapper.ts` — add nullable `headRepositoryOwner: string | null` field; expand `PullRequestDetailRawSchema` with `headRepositoryOwner: z.object({ login: z.string() }).passthrough().nullable().optional()`; update `getPullRequestDetail` `--json` field list to include `headRepositoryOwner`; extract to `detail.data.headRepositoryOwner?.login ?? null` in return shape (see plan.md:146-211, data-model.md:7-36).
- [ ] T002 [US1] Add `DeleteHeadRefResult` type and `deleteHeadRef(repo, headRef)` method to `GhWrapper` interface + impl in `packages/cockpit/src/gh/wrapper.ts` — invokes `gh api -X DELETE repos/{owner}/{name}/git/refs/heads/{headRef}` via `this.runner`; exit 0 → `{ outcome: 'deleted' }`; non-zero + stderr matching `/HTTP\s+422|HTTP\s+404/` → `{ outcome: 'already-gone' }`; any other non-zero → `{ outcome: 'delete-failed', stderr: trimmed }`; throws only on malformed `repo` input (see plan.md:213-261, contracts/delete-head-ref.md).

## Phase 2: Wrapper tests

- [ ] T003 [P] [US1] Add 4 wrapper unit tests for `deleteHeadRef` in `packages/cockpit/src/__tests__/gh-wrapper.test.ts` using `fakeRunner`: exit 0 → `deleted`; exit 1 + stderr containing `HTTP 422` → `already-gone`; exit 1 + stderr containing `HTTP 404` → `already-gone`; exit 1 + arbitrary stderr (e.g. `HTTP 403: Resource not accessible`) → `delete-failed` with trimmed stderr. Pin real `gh api` stderr substrings — not invented strings (see plan.md:56, contracts/delete-head-ref.md).
- [ ] T004 [P] [US1] Add 1 wrapper test for `getPullRequestDetail.headRepositoryOwner` surfacing in `packages/cockpit/src/__tests__/gh-wrapper.test.ts` — three sub-cases from one fake response: same-owner PR (`headRepositoryOwner: { login: 'acme' }` → `'acme'`), fork PR (`headRepositoryOwner: { login: 'contributor42' }` → `'contributor42'`), deleted head repo (`headRepositoryOwner: null` → `null`).

## Phase 3: CLI orchestration (`packages/generacy`)

<!-- Depends on Phase 1 — wrapper primitives must exist before consumer wiring -->

- [ ] T005 [US1] Add `classifyAndDeleteBranch(ctx)` helper in `packages/generacy/src/cli/commands/cockpit/merge.ts` — cross-fork pre-check via `pr.headRepositoryOwner != null && pr.headRepositoryOwner !== issueRef.owner`; delegates to `gh.deleteHeadRef(repo, pr.head)` otherwise; returns canonical stdout suffix per outcome (byte-exact strings from data-model.md:107-113); emits `logger.info` for `already-gone` and `skipped-cross-fork`, `logger.warn` for `delete-failed` with `{ pr, repo, headRef, stderr }` bindings (see plan.md:302-346, contracts/run-merge-deletion.md).
- [ ] T006 [US1] Wire the helper into both `runMerge` success branches in `packages/generacy/src/cli/commands/cockpit/merge.ts` — vacuous-green branch (append suffix to `no checks configured and none required — proceeding on completed:validate\n`); classify-passing branch (suffix becomes sole stdout line, replacing prior `''`). Exit code stays `0` for all four deletion outcomes (see plan.md:265-297).

## Phase 4: CLI tests

<!-- Depends on Phase 3 — consumer implementation must exist for regression pins to run -->

- [ ] T007 [US1] Add regression tests SC-101/SC-102/SC-103/SC-104/SC-105 in `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` using `fakeGh`:
  - **SC-101** same-owner + classify-passing + wrapper returns `{ outcome: 'deleted' }` → byte-exact `stdout === 'merged and branch deleted\n'`, `deleteHeadRef` called once with `(repo, pr.head)`.
  - **SC-102** same-owner + vacuous-green + wrapper returns `{ outcome: 'already-gone' }` → byte-exact `stdout === 'no checks configured and none required — proceeding on completed:validate\nmerged (branch was already deleted)\n'`, `logger.info(..., 'branch was already deleted')` fired.
  - **SC-103** cross-fork (`pr.headRepositoryOwner === 'contributor42'`, `issueRef.owner === 'acme'`) + classify-passing → byte-exact `stdout === 'merged (branch delete skipped: cross-fork PR)\n'`, `deleteHeadRef` NOT called, `logger.info(..., 'branch deletion skipped: cross-fork PR')` fired.
  - **SC-104** same-owner + classify-passing + wrapper returns `{ outcome: 'delete-failed', stderr: 'HTTP 403: Resource not accessible by integration' }` → byte-exact `stdout === 'merged (branch delete failed: HTTP 403: Resource not accessible by integration)\n'`, `logger.warn({ ..., stderr }, 'branch deletion failed')` fired, `exitCode === 0`.
  - **SC-105** null head repo (`pr.headRepositoryOwner === null`) + vacuous-green + wrapper returns `{ outcome: 'deleted' }` → falls through cross-fork pre-check, `stdout === 'no checks configured and none required — proceeding on completed:validate\nmerged and branch deleted\n'`.

## Phase 5: Verification

- [ ] T008 [US1] Run `pnpm --filter @generacy-ai/cockpit test` and `pnpm --filter @generacy-ai/generacy test` — all 4 new wrapper tests + 5 new merge tests pass; no pre-existing tests regress. Then walk through `quickstart.md` verification steps (live-repro closure on the christrudelpw/sniplink PR #16 pattern).

## Dependencies & Execution Order

**Sequential dependencies**:
- Phase 1 (T001, T002) → Phase 3 (T005, T006): consumer imports the new type + method from the wrapper.
- Phase 3 (T005, T006) → Phase 4 (T007): merge tests assert on the classifier's stdout suffixes.
- All phases → Phase 5 (T008): verification runs the full test suites.
- Within Phase 1: T002 has no dependency on T001, but both modify the same file (`wrapper.ts`) — do sequentially to avoid edit conflicts.
- Within Phase 3: T006 depends on T005 (helper must exist before wiring); same file (`merge.ts`) — sequential.

**Parallel opportunities**:
- **T003 [P]** and **T004 [P]** can run concurrently — both add tests to `gh-wrapper.test.ts` but they are independent test cases; if edit conflicts are a concern, sequence them but they can be authored in parallel.
- Phase 2 tests (T003, T004) can begin immediately after Phase 1 completes (parallel with Phase 3 authoring if separate files are OK, but do Phase 3 first if a single writer).

**Recommended execution order**: T001 → T002 → T005 → T006 → T003 → T004 → T007 → T008.

## Notes

- **Scope**: ~60 LOC production change (2 files), ~140 LOC test change (2 files). Fits comfortably in one session.
- **No new deps**: uses existing `zod` + `vitest`; no runtime dependency additions.
- **No cross-package coupling**: wrapper change is source-additive (new nullable field, new method); existing consumers of `PullRequestDetail` ignore the new field.
- **Constitution gates all PASS** per plan.md:82-99. No shims, no stderr pattern-matching for permission strings, no `--keep-branch` flag, no premature abstraction.
