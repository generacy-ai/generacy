# Tasks: Collapse cockpit CLI surface to rev 3 catalog

**Input**: Design documents from `/specs/807-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = unified `context` verb, US2 = single gh wrapper + resolver)

## Phase 1: Baseline audit

- [X] T001 [US2] Enumerate all `CockpitGh` call-sites and record their imports for later migration. Grep `packages/generacy/src/cli/commands/cockpit/` for `CockpitGh` and `from './gh-ext'` / `from '../gh-ext'`; note each file in a scratch list (used by T012).
- [X] T002 [US2] Enumerate all `parseIssueRef` / `resolveContext` / `IssueRef` call-sites across `packages/generacy/src/cli/commands/cockpit/`. Grep for `from './issue-ref'`, `from './shared/resolve-context'`, `from '../issue-ref'`, `from '../shared/resolve-context'`; note each file (used by T019).
- [X] T003 [P] [US1] Enumerate `advance` and `merge` test files that must remain unchanged (SC-004 guard). List: `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts`, `merge.test.ts`, any nested files matching `advance*.test.ts` / `merge*.test.ts`. Record hash/mtime baseline for CI diff.

## Phase 2: GhWrapper fold-in (Plan Phase 0 — unblocks everything)
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

### GhWrapper interface + implementation

- [X] T010 [US2] Extend `GhWrapper` interface in `packages/cockpit/src/gh/wrapper.ts` with method signatures: `fetchIssueLabels(repo, n)`, `fetchIssueState(repo, n)`, `postIssueComment(repo, n, body)`, `addAssignees(repo, n, logins)`, `fetchIssueTimeline(repo, n)`, `fetchIssueComments(repo, n)`, `getCurrentUser()`, `findOpenPrForBranch(repo, branch)`, `prDiffNames(repo, prNumber)`, `prDiffPatch(repo, prNumber)`. Shapes per `research.md` overlap matrix.
- [X] T011 [US2] Implement the ten new methods on `GhCliWrapper` in the same file. Reuse existing `runCommand`/`runJson` primitives; loud-fail with Zod at gh-JSON boundaries per pattern §3 in research.md. Add single-label helpers `addLabel`/`removeLabel` as one-liners delegating to existing plural `addLabels`/`removeLabels`.

### Call-site migration (touch one file per task to enable [P])

- [X] T012 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/state.ts` — replace `CockpitGh` type + import with `GhWrapper` from `@generacy-ai/cockpit`. (This file is deleted in T042; migration keeps it compiling until then.)
- [X] T013 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/clarify-context.ts` — replace `CockpitGh` type + import with `GhWrapper`. (Deleted in T042.)
- [X] T014 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/advance.ts` — replace `CockpitGh` type + import with `GhWrapper`. Behavior unchanged (FR-006). Do NOT edit `advance.test.ts` (SC-004).
- [X] T015 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/merge.ts` — replace `CockpitGh` type + import with `GhWrapper`. Behavior unchanged (FR-006). Do NOT edit `merge.test.ts` (SC-004).
- [X] T016 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/code-references.ts` — replace `CockpitGh` with `GhWrapper`; keep raw (uncapped) `prDiffPatch` call (research Decision 6 note).
- [X] T017 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` — replace `CockpitGh` with `GhWrapper`.
- [X] T018 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/watch.ts` — replace `CockpitGh` with `GhWrapper`.

### Test-fixture updates for GhWrapper shape

- [X] T019 [US2] Update shared test helpers/fixtures under `packages/generacy/src/cli/commands/cockpit/__tests__/` so any hand-rolled `CockpitGh` stub matches the extended `GhWrapper` interface (add the ten new method stubs, defaulting to `vi.fn()`). Do not modify `advance.test.ts` or `merge.test.ts` bodies (SC-004) — if they need helper shape changes, adjust only the helper import path.

## Phase 3: Resolver collapse (Plan Phase 1)
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [X] T020 [US2] Create `packages/generacy/src/cli/commands/cockpit/resolver.ts` exporting: `IssueRef` type (owner/repo/number/nwo), `parseIssueRef(input)` (pure; throws on bare number — data-model §Resolver contract), `resolveIssueContext({ issue, repo?, cwd? })` returning `{ ref, repo, gh: GhWrapper }`. `resolveIssueContext` catches bare-number throws from `parseIssueRef` and falls back to `git remote get-url origin` inference (research Decision 5).
- [X] T021 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/advance.ts` — change `parseIssueRef` import to `./resolver`. Behavior unchanged. Do NOT edit `advance.test.ts` (SC-004).
- [X] T022 [P] [US2] Migrate `packages/generacy/src/cli/commands/cockpit/merge.ts` — change `parseIssueRef` import to `./resolver`. Behavior unchanged. Do NOT edit `merge.test.ts` (SC-004).
- [X] T023 [P] [US2] Migrate any remaining live importers of `issue-ref` / `shared/resolve-context` identified in T002 that were not covered by T021–T022 (e.g. `watch.ts`, `status.ts`, `queue.ts` if hit) — swap imports to `./resolver`.
- [X] T024 [US2] Create `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts` — merge existing `issue-ref.test.ts` scenarios plus new cases for `resolveIssueContext` cwd/origin inference (success path + bare-number-without-git-origin failure path). Covers SC-003 test coverage aspect.

## Phase 4: Unified `context` verb (Plan Phase 2)
<!-- Phase boundary: Complete Phase 3 before starting Phase 4 -->

### Contract fixtures (parallel, one per gate)

- [X] T030 [P] [US1] Create fixture file `packages/generacy/src/cli/commands/cockpit/__tests__/fixtures/context.clarification.fixture.json` — labels list, timeline, comments, PR-link body → golden clarification bundle per `contracts/clarification-bundle.schema.json`.
- [X] T031 [P] [US1] Create fixture file `packages/generacy/src/cli/commands/cockpit/__tests__/fixtures/context.implementation-review.fixture.json` — labels + PR-detail + checks → golden implementation-review bundle per `contracts/implementation-review-bundle.schema.json`.
- [X] T032 [P] [US1] Create fixture file `packages/generacy/src/cli/commands/cockpit/__tests__/fixtures/context.artifact-paths.fixture.json` — labels + on-disk spec/plan/tasks matrix (any-1 / any-2 / all-3 present) → golden artifact-paths bundles per `contracts/artifact-paths-bundle.schema.json`.

### `context.ts` implementation

- [X] T033 [US1] Create `packages/generacy/src/cli/commands/cockpit/context.ts` with:
  - `runContext(issueArg, deps)` entry-point (dependency-injected `CommandRunner`, injectable `GhWrapper`).
  - Uses `parseIssueRef` from T020, then `gh.fetchIssueLabels`.
  - Gate classification via `WAITING_PIPELINE_ORDER` from `packages/cockpit/src/state/precedence.ts`.
  - Explicit branches for `waiting-for:clarification`, `waiting-for:implementation-review`, `waiting-for:{spec,plan,tasks}-review`.
  - `completed:validate` → `CockpitExit(3, '... use \`cockpit merge\`')` (research Decision 4).
  - No `waiting-for:*` label → `CockpitExit(3, 'no waiting-for:* label ... labels: <observed>')`.
  - Bundle emission is single-line JSON on stdout.
- [X] T034 [US1] Implement clarification-bundle branch in `context.ts` — reuse `findClarificationComment`, `gatherCodeReferences`, and spec/plan-reader logic from today's `clarify-context.ts`. Prepend `{issue, gate}` discriminator per data-model §Bundle 1. Emit `null` for missing resources per emission rule.
- [X] T035 [US1] Implement implementation-review-bundle branch in `context.ts` — call `gh.resolveIssueToPRRef(nwo, number)`; if `null`, `CockpitExit(3, 'gate refusal: ... but no linked PR resolved')` per data-model §Bundle 2 refusal rules. On success, delegate to `buildReviewContextPayload` from `shared/review-context-json.ts` and prepend `{issue, gate}`.
- [X] T036 [US1] Implement artifact-paths-bundle branch in `context.ts` — new helper `readArtifactBundle(cwd, branch, issueNumber)` that always emits `spec`, `plan`, `tasks` as `{path, body} | null`. Directory-discovery: `specs/<branch>/` first, then scan for `specs/<n>-*` prefix (same logic as today's `clarify-context`). Uniform shape regardless of which review gate fired (Q1 → D).

### Wire into CLI

- [X] T037 [US1] Edit `packages/generacy/src/cli/commands/cockpit/index.ts` — add `contextCommand()` export and register it. Delete the three `addCommand(stateCommand())`, `addCommand(clarifyContextCommand())`, `addCommand(reviewContextCommand())` calls. Preserve `advance`/`merge`/`watch`/`status`/`queue` registrations (FR-006).

### Tests (one file per gate branch — parallel, SC-001)

- [X] T038 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/context.clarification.test.ts` — dependency-injected `CommandRunner` stubs from T030 fixture; assert bundle shape matches `contracts/clarification-bundle.schema.json` (use JSON schema validator or structural assertion); assert exit 0.
- [X] T039 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/context.implementation-review.test.ts` — stubs from T031 fixture; assert bundle matches `contracts/implementation-review-bundle.schema.json`; assert exit 0. Additional case: `resolveIssueToPRRef` returns `null` → thrown `CockpitExit` with code 3 and message containing "no linked PR resolved".
- [X] T040 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/context.artifact-paths.test.ts` — one describe block × 3 gates (`spec-review`, `plan-review`, `tasks-review`) using T032 fixture matrix; assert bundle matches `contracts/artifact-paths-bundle.schema.json`; assert all three artifacts always present in `artifacts.{spec,plan,tasks}` (each `null` or `{path, body}`); assert exit 0.
- [X] T041 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/context.exit-codes.test.ts` (SC-005) — one test per exit code:
  - `0`: any successful bundle (reuse fixture).
  - `1`: `gh` runner rejects — assert `CockpitExit(1, /^gh /)`.
  - `2`: bare-number ref with no git origin — assert `CockpitExit(2, /parse issue/)`.
  - `3` (a) no `waiting-for:*` label; (b) `completed:validate` label; (c) PR-scoped gate with no linked PR; (d) unsupported gate string.
  Assert diagnostic prefixes match data-model §Error path table.

## Phase 5: Deletion and verification cleanup (Plan Phase 3)
<!-- Phase boundary: Complete Phase 4 before starting Phase 5 -->

- [X] T042 [US2] Delete files: `packages/generacy/src/cli/commands/cockpit/state.ts`, `clarify-context.ts`, `review-context.ts`, `gh-ext.ts`, `issue-ref.ts`, `shared/resolve-context.ts`. Confirm no live imports remain (compile passes).
- [X] T043 [US1] Delete tests: `packages/generacy/src/cli/commands/cockpit/__tests__/state.test.ts`, `clarify-context.test.ts`, `review-context.test.ts`, `issue-ref.test.ts`. Confirm no imports remain from surviving tests (fixtures already migrated in T030–T032).
- [X] T044 [P] [US2] SC-002 verification — run `grep -R "gh-ext" packages/**/*.ts` and `grep -R "CockpitGh" packages/**/*.ts`; both must return zero hits. Record output in PR description.
- [X] T045 [P] [US2] SC-003 verification — run `grep -R "issue-ref" packages/**/*.ts` and `grep -R "resolve-context" packages/**/*.ts`; both must return zero source-code hits.
- [X] T046 [P] [US1] SC-004 verification — run `pnpm --filter @generacy-ai/generacy test -- advance merge` (or equivalent Vitest filter). All existing `advance` and `merge` tests must pass unmodified. Confirm the baseline recorded in T003 matches (no source-file drift in the two test files).
- [X] T047 [P] [US1] SC-005 verification — run `pnpm --filter @generacy-ai/generacy test -- context.exit-codes`; assert every branch in the exit-code test file exercises a distinct code from `{0, 1, 2, 3}`.
- [X] T048 [US1] Full test-suite run: `pnpm --filter @generacy-ai/generacy build && pnpm --filter @generacy-ai/generacy test`. Green CI is the sign-off.
- [X] T049 [US1] Quickstart smoke run per `quickstart.md`: `node packages/generacy/dist/cli/index.js cockpit context generacy-ai/generacy#807` against a real gate (or record the fixture-driven equivalent) — confirm bundle shape matches the discriminator table.

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (audit) → Phase 2 (GhWrapper fold-in) → Phase 3 (resolver collapse) → Phase 4 (context verb) → Phase 5 (cleanup)

**Rationale for ordering**:
- Phase 2 must land before Phase 4 because `context.ts` needs the extended `GhWrapper` methods.
- Phase 3 must land before Phase 4 because `context.ts` imports `parseIssueRef` from the new `resolver.ts`.
- Phase 5 deletions must be last so intermediate phases keep compiling.

**Parallel opportunities within phases**:
- Phase 2: T012–T018 all touch different files after T010/T011 → run in parallel.
- Phase 3: T021–T023 touch different files after T020 → run in parallel.
- Phase 4: T030–T032 (fixtures) parallel; T038–T041 (tests) parallel after T033–T037 land.
- Phase 5: T044–T047 (verifications) parallel after T042/T043 delete.

**Critical fence**:
- Never edit `advance.test.ts` or `merge.test.ts` — SC-004 requires them to pass unmodified. Import-path changes (T014, T015, T021, T022) touch source files only; test files stay untouched.

## Suggested next step

`/speckit:implement` to begin execution.
