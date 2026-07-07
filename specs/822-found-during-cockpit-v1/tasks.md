# Tasks: Cockpit CLI status/watch argument-contract drift (positional refs + bare-number inference)

**Input**: Design documents from `/specs/822-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cli-surface.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 plugin-driven positional refs, US2 bare-number inference, US3 consistent verb surfaces)

## Phase 1: Setup / Audit

- [ ] T001 Audit callers of the deleted `--epic` flag in the monorepo: `rg -F "--epic" packages/generacy packages/cockpit` and `rg -nF "'epic'" packages/generacy/src/cli/commands/cockpit`. Expected result: only the two removed `.requiredOption('--epic', …)` lines in `status.ts`/`watch.ts` plus test fixtures under `packages/generacy/src/cli/commands/cockpit/__tests__/`. Record the full caller list before starting Phase 2 so no fixture is missed.
- [ ] T002 [P] Read the current bodies of `packages/generacy/src/cli/commands/cockpit/status.ts`, `watch.ts`, `queue.ts`, and `resolver.ts` and confirm the line references in `data-model.md` (`status.ts:17`, `status.ts:34`, `watch.ts:13`, `watch.ts:71`, `queue.ts:184`, `resolver.ts:21-48`, `resolver.ts:99-108`, `resolver.ts:150-153`) match the current source. If any drifted, update `data-model.md` before editing.

## Phase 2: Core CLI Edits

- [ ] T003 [US2] In `packages/generacy/src/cli/commands/cockpit/resolver.ts:106-108`, update the `parseIssueRef` garbage-input error message from `Use <owner>/<repo>#<n> or https://github.com/<owner>/<repo>/issues/<n>.` to `Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` (FR-007 — enumerated forms now include the bare number). Do NOT change the exported types or any other line — the bare-number → origin fall-through path in `resolveIssueContext` (`resolver.ts:150-153`) already exists.

- [ ] T004 [US1] [US2] In `packages/generacy/src/cli/commands/cockpit/status.ts`:
  1. Delete `epic?: string` from `StatusCliOptions` (`status.ts:17`).
  2. Change `runStatus` signature (`status.ts:34`) to `runStatus(epicRef: string | undefined, options: StatusCliOptions, deps: StatusDeps = {})`.
  3. Drop the `options.epic`-null guard; replace with an `epicRef`-null guard that returns exit `2` via the same `Error: cockpit status: parse issue: issue argument is required` shape (data-model.md §Validation).
  4. Before `resolveEpic(...)`, call `const resolved = await resolveIssueContext({ issue: epicRef, gh })` and pass `\`${resolved.ref.nwo}#${resolved.ref.number}\`` as `epicRef` into `resolveEpic`. Catch parse failures and re-emit as `Error: cockpit status: parse issue: <reason>` on stderr, exit 2.
  5. In `statusCommand()`, replace `.requiredOption('--epic <ownerRepoIssue>', …)` with `.argument('<epic-ref>', …)`; change the action handler to `(epicRef, options) => runStatus(epicRef, options)`.

- [ ] T005 [US1] [US2] In `packages/generacy/src/cli/commands/cockpit/watch.ts`, apply the same five-step shape as T004:
  1. Delete `epic?: string` from `WatchOptions` (`watch.ts:13`).
  2. Change `runWatch` signature (`watch.ts:71`) to take `epicRef` as first parameter.
  3. Replace the `options.epic`-null guard.
  4. Call `resolveIssueContext({ issue: epicRef, gh })` ONCE at command start; cache the expanded `\`${resolved.ref.nwo}#${resolved.ref.number}\`` in a local const; feed that same cached string into both the initial `resolveEpic(...)` AND every subsequent poll-loop `resolveEpic(...)` call. **Invariant**: the bare-number origin inference does NOT re-fire per poll interval (contracts/cli-surface.md §Invariant, plan.md §Performance Goals).
  5. In `watchCommand()`, replace `.requiredOption('--epic …')` with `.argument('<epic-ref>', …)`; update the action handler to `(epicRef, options) => runWatch(epicRef, options)`.

- [ ] T006 [US2] [US3] In `packages/generacy/src/cli/commands/cockpit/queue.ts`, internal-only edit: before the existing `resolveEpic({ epicRef, gh })` call (~`queue.ts:184`), insert `const resolved = await resolveIssueContext({ issue: epicRef, gh })` and change the `resolveEpic` invocation to pass `\`${resolved.ref.nwo}#${resolved.ref.number}\`` as its `epicRef`. Wrap parse failures as `Error: cockpit queue: parse issue: <reason>`, exit 2. **Argument surface stays byte-identical** (FR-009 — Q4→A). Do NOT touch `queueCommand()`'s `.argument()` declarations, the `--repo`/`--label`/`--assignee`/`--yes` flags, or `matchPhaseHeading`/`pickTargetRepo`.

## Phase 3: Test Updates

- [ ] T007 [P] [US2] In `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts`:
  1. Extend the existing `parseIssueRef` garbage-input assertion to expect the new message that includes `<n>` (matches T003 output).
  2. Add an integration test for `resolveIssueContext` with an injected `runner` that satisfies `git remote get-url origin` → `git@github.com:owner/repo.git` (or `https://github.com/owner/repo.git`) and asserts that a bare-number input `'1'` expands to `resolved.ref.nwo === 'owner/repo'` and `resolved.ref.number === 1`.

- [ ] T008 [P] [US1] [US2] In `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts` (and any sibling `status.color.test.ts`, `status.render.test.ts`, `failing-check-json.test.ts` audited in T001):
  1. Migrate every existing fixture from options-object form `runStatus({ epic: 'owner/repo#42', … }, deps)` to the new positional form `runStatus('owner/repo#42', { … }, deps)`.
  2. Add: bare-number resolves via the injected runner — `runStatus('1', {}, { gh, runner })` succeeds and reaches `resolveEpic` with `owner/repo#1`.
  3. Add: invalid ref `'garbage'` emits `Error: cockpit status: parse issue: unrecognized issue ref "garbage". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` on stderr and returns exit `2`.
  4. Add regression-guard: `runStatus(undefined, {}, deps)` emits `Error: cockpit status: parse issue: issue argument is required` and returns exit `2`.

- [ ] T009 [P] [US1] [US2] In `packages/generacy/src/cli/commands/cockpit/__tests__/watch.test.ts`:
  1. Migrate every existing fixture from `{ epic: '…' }` to positional as in T008.
  2. Add: bare-number resolves via injected runner (same shape as T008 step 2).
  3. Add: invalid ref emits `Error: cockpit watch: parse issue: …` + exit 2.
  4. Add **per-poll invariant** test: run the poll loop for N intervals (using existing fake-timer / `--safety-cap` machinery in the test file), assert that the injected `runner` receives EXACTLY ONE `git remote get-url origin` call across all N intervals (proves the bare-number inference is not repeating — plan.md §Performance Goals, contracts/cli-surface.md §Invariant).

- [ ] T010 [P] [US2] [US3] In `packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts`:
  1. Add regression test: `runQueue('1', 'implement', { … }, { gh, runner })` where the injected `runner` resolves `git remote get-url origin` → `owner/repo` succeeds and results in `resolveEpic` being called with `epicRef: 'owner/repo#1'`.
  2. Add regression-guard that the pre-existing invocation `runQueue('owner/repo#123', 'implement', …)` continues to work identically (FR-005, FR-009).
  3. Do NOT rewrite the queue-argument-surface tests — the CLI argument shape is byte-identical.

## Phase 4: Verification

- [ ] T011 Run `pnpm --filter @generacy-ai/generacy test -- cockpit` (or the repo-standard incantation) and confirm the four `__tests__/{status,watch,queue,resolver}.test.ts` files plus any sibling tests all pass. Also run `pnpm --filter @generacy-ai/cockpit test` to confirm the shared library test suite is unaffected (Q1→A: package untouched).
- [ ] T012 [P] Grep confirmations for the success criteria in `spec.md`:
  - `rg -F "--epic" packages/generacy/src/cli/commands/cockpit` returns 0 hits (SC-003).
  - `rg -nF "parseIssueRef(" packages/generacy/src/cli/commands/cockpit/{status,watch,queue}.ts` returns 0 hits — no verb bypasses `resolveIssueContext` (SC-003).
  - `rg -nF "resolveEpic({ epicRef" packages/generacy/src/cli/commands/cockpit/{status,watch,queue}.ts` — every hit's `epicRef` should be the resolved-and-expanded local, not the raw CLI input.
- [ ] T013 Manual repro (quickstart.md §Validation):
  - Build the CLI (`pnpm --filter @generacy-ai/generacy build`).
  - In a checkout whose `git remote get-url origin` returns `generacy-ai/generacy`, run `node packages/generacy/dist/cli/index.js cockpit status 1` and confirm it renders the epic snapshot for `generacy-ai/generacy#1` (SC-001, SC-004).
  - Run `node packages/generacy/dist/cli/index.js cockpit status generacy-ai/generacy#822` and confirm it renders (FR-005).
  - Run `node packages/generacy/dist/cli/index.js cockpit status 'https://github.com/generacy-ai/generacy/issues/822'` and confirm it renders (FR-006).
  - Run `node packages/generacy/dist/cli/index.js cockpit status garbage` and confirm the exact error line `Error: cockpit status: parse issue: unrecognized issue ref "garbage". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.` on stderr and exit code `2` (FR-007).
  - Repeat the four sub-steps above for `cockpit watch` (SC-002) — cancel with SIGINT after first snapshot to verify clean exit 0.
  - Run `node packages/generacy/dist/cli/index.js cockpit queue 1 implement --yes` and confirm the queue succeeds against the cwd repo (US3, FR-009 regression-guard).
- [ ] T014 Confirm `claude-plugin-cockpit`'s `status.md` and `watch.md` were NOT touched during this fix (SC-005 — plugin markdown untouched). This is a bookkeeping check — the plugin lives in a sibling repo, not this monorepo.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T002 → T003 (audit + confirm line refs, then edit the shared helper's error message first because T004/T005/T008/T009 all assert the new message text).
- T003 → T004, T005, T006 (verbs read the updated helper).
- T004, T005, T006 must complete before their corresponding test files in Phase 3 will pass, but tests can be *written* in parallel with the edits.
- All Phase 3 tests before T011 (`pnpm test`).
- T011 before T013 (manual repro against green tests).

**Parallel opportunities**:
- T002 runs in parallel with T001 (T002 reads files; T001 rg — no conflict).
- T004, T005, T006 all edit different files with no shared state → can run in parallel once T003 lands.
- T007, T008, T009, T010 all edit different test files → parallel with each other.
- T012 (grep verification) parallel with T013 (manual repro) — different failure modes.

**Blocking notes**:
- If T001's audit turns up any `--epic` caller outside test fixtures and this file's expected list, STOP and expand the plan — spec.md §Assumptions asserts no downstream consumers exist.
- T005's per-poll invariant test (T009 step 4) is the load-bearing regression-guard for the "resolve once, cache the expansion" contract in watch.ts. If that test can't be written cleanly against the existing fake-timer setup, escalate to the plan phase before shipping the watch.ts edit.

## Task count

**14 tasks** across 4 phases:
- Phase 1: T001, T002 (2 setup/audit)
- Phase 2: T003, T004, T005, T006 (4 core CLI edits)
- Phase 3: T007, T008, T009, T010 (4 test updates)
- Phase 4: T011, T012, T013, T014 (4 verification)

**Parallel-eligible**: T002, T004+T005+T006 (after T003), T007+T008+T009+T010, T012+T013.

**User story coverage**:
- US1 (plugin-driven positional refs): T004, T005, T008, T009
- US2 (bare-number cwd inference): T003, T004, T005, T006, T007, T008, T009, T010
- US3 (consistent verb surfaces): T006, T010
