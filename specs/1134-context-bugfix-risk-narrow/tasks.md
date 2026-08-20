# Tasks: Bugfix profiles — verification review charter + targeted validate with diff-classification guards

**Input**: Design documents from `/specs/1134-context-bugfix-risk-narrow/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup / Foundations

- [ ] T001 Export `DEFAULT_VALIDATE_COMMAND = 'pnpm test && pnpm build'` from
  `packages/orchestrator/src/worker/config.ts` and wire the `WorkerConfigSchema.validateCommand`
  `.default(...)` to reference the new constant (Decision 2 / Q1=B). This keeps the schema default
  and the built-in-default detector in sync by construction. No behavior change on its own.

## Phase 2: US1 — Verification review charter (P1)

**Goal**: `profile: verification` interrogates the four bugfix questions; `standard` stays byte-identical.

- [ ] T002 [US1] Extend the `verification` branch of `buildReviewCharter` in
  `packages/orchestrator/src/worker/review-charter.ts` to render four clearly delineated,
  numbered/headed questions in place of the generic "needs verification" paragraph:
  (1) root cause vs symptom, (2) regression test present that fails without the fix,
  (3) scope creep, (4) regression risk in the changed lines (wording from
  `contracts/verification-charter.md`). Isolate the change to the `if (profile === 'verification')`
  block — leave the `standard` branch, the "do NOT run tests/builds" section, the empty-diff
  finding, and the sidecar-write instructions untouched (FR-001/FR-002, #1124 invariants).
- [ ] T003 [US1] Update `packages/orchestrator/src/worker/__tests__/review-charter.test.ts`
  (SC-002): assert `profile: 'verification'` output contains all four questions (assert each);
  assert `profile: 'standard'` output is byte-identical to a captured pre-change snapshot; assert
  both profiles still contain the "do NOT run tests" and sidecar-write sections.

## Phase 3: US2 — Targeted validate on monorepos (P1)

**Goal**: For `speckit-bugfix`, classify the diff and rewrite the built-in default validate command
to the pnpm `...[origin/<base>]` filter form, with safety guards; log the decision.

- [ ] T004 [P] [US2] Create pure, deterministic classifier
  `packages/orchestrator/src/worker/diff-classifier.ts` (FR-003, no I/O). Export the
  `Classification` discriminated union and `classifyDiff({ changedFiles, isWorkspace })` per
  `data-model.md` / `contracts/diff-classifier.md`. Ordered, first-match-wins precedence:
  (0) empty diff → `full-fallback` reason `'empty-diff'`; (1) any root-config glob →
  `full-fallback` reason `'root-config: <file>'`; (2) `!isWorkspace` → `single-package-plain`;
  (3) all docs → `docs-only-skip-tests`; (4) all test → `test-only` (carry `testFiles`);
  (5) else → `targeted`. Glob sets (Q2=A closed): root-config = `pnpm-lock.yaml`,
  `package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`, root-only `tsconfig*.json`
  (no `/` before filename), `.github/workflows/**`; docs = `**/*.md`, `docs/**`;
  test = `**/*.{test,spec}.{ts,tsx,js,jsx}`, `**/__tests__/**`. Never throws.
- [ ] T005 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/diff-classifier.test.ts`
  (SC-001 — every branch + every guard). Cover the 11-case matrix in
  `contracts/diff-classifier.md`: empty→full-fallback; lockfile(+src)→full-fallback;
  `pnpm-workspace.yaml`→full-fallback; root `tsconfig.json`→full-fallback while nested
  `packages/x/tsconfig.json`→NOT full; `.github/workflows/ci.yml`→full-fallback;
  `isWorkspace:false`+src→single-package-plain; all-docs→docs-only-skip-tests;
  docs+src→targeted; all-test→test-only(with testFiles); test+src→targeted;
  plain src on workspace→targeted.
- [ ] T006 [US2] Wire classification into the validate block of
  `packages/orchestrator/src/worker/phase-loop.ts` (FR-009 / `contracts/targeted-validate.md`),
  gated on `context.item.workflowName === 'speckit-bugfix'` (Q4=B) — every other workflow reaches
  the existing `runValidatePhase(config.validateCommand, ...)` call unchanged (SC-005). Steps:
  resolve `baseRef` via `resolveBaseRef`/`resolveBaseBranch` (`origin/<name>`), strip to bare
  `<base>`; `changedFiles = github.getFilesChangedBetween(baseRef, 'HEAD')`;
  `isWorkspace = fs.exists(join(checkoutPath, 'pnpm-workspace.yaml'))` (single stat, Decision 4);
  `classification = classifyDiff({ changedFiles, isWorkspace })`;
  `isBuiltInDefault = config.validateCommand === DEFAULT_VALIDATE_COMMAND`. Compute the effective
  command per the resolution table (`data-model.md`) — rewrite ONLY when `isBuiltInDefault`
  (custom commands run verbatim, Q1=B): `targeted`→`pnpm --filter "...[origin/<base>]" build && pnpm --filter "...[origin/<base>]" test`;
  `docs-only-skip-tests`→filtered build-only; `test-only`→`pnpm vitest run <testFiles...>`;
  `single-package-plain`/`full-fallback`→plain default. Emit exactly one log line:
  `{ event: 'targeted-validate', classification: <kind>, isBuiltInDefault, base, effectiveCommand }`.
  Then `runValidatePhase(checkoutPath, effectiveCommand, signal)`.
- [ ] T007 [US2] Create
  `packages/orchestrator/src/worker/__tests__/phase-loop.targeted-validate.test.ts` (SC-003):
  bugfix + targeted + built-in default → filtered command + log emitted; bugfix + custom command
  → custom runs verbatim while classification is still logged; feature workflow → block skipped,
  plain default command runs (SC-005 byte-identity); each guard (docs-only, test-only,
  single-package, full-fallback) produces its documented effective command.

## Phase 4: US3 — `failThenPass` regression proof (P2)

**Goal**: Opt-in check that new/changed test files fail on base and pass on branch. Off by default.

- [ ] T008 [P] [US3] Create `packages/orchestrator/src/worker/fail-then-pass.ts` (FR-011 /
  `contracts/fail-then-pass.md`). Export `FailThenPassResult` and
  `runFailThenPass({ checkoutPath, baseRef, changedTestFiles, signal })`. Behavior:
  empty `changedTestFiles` → `{ kind: 'noop' }` (non-blocking, Q3=A);
  else `git worktree add --detach <tmp> <baseRef>` → run the changed test files there
  (expect failure) → `git worktree remove --force <tmp>` in a `try/finally` (always cleaned up,
  even on error) → run the same files in `checkoutPath` (expect pass). Decide:
  base passed → `{ kind: 'fail', reason: 'base-passed', evidence }`;
  branch failed → `{ kind: 'fail', reason: 'branch-failed', evidence }`;
  base-fails AND branch-passes → `{ kind: 'pass' }`. Mirror the `base-merge.ts`
  `execFileAsync` git patterns (Decision 5); never mutate the branch checkout / its node_modules.
- [ ] T009 [P] [US3] Create `packages/orchestrator/src/worker/__tests__/fail-then-pass.test.ts`
  (SC-004): off → module not invoked (assert no worktree created); empty test set → `noop`;
  base-fails + branch-passes → `pass`; base-passes → `fail` reason `base-passed`;
  branch-fails → `fail` reason `branch-failed`; worktree cleaned up on the error path.
- [ ] T010 [US3] Wire `failThenPass` into the validate block of
  `packages/orchestrator/src/worker/phase-loop.ts` (depends on T006). Trigger only when
  `resolveWorkflowOverrides(...).review.failThenPass === true` AND
  `workflowName === 'speckit-bugfix'`. Compute `changedTestFiles` = the classifier's changed-file
  set ∩ test globs (reuse the T006 `changedFiles` + the test-glob predicate from T004). Call
  `runFailThenPass(...)`: `noop`/`pass` → continue to validate success; `fail` → fail the validate
  phase surfacing the `evidence` in the phase result/findings (actionable, FR-011). When off
  (default), the module is never invoked and validate is byte-identical (FR-010/FR-013/SC-005).

## Phase 5: US4 — Cheaper bugfix review agent (P3)

**Goal**: Demonstrate bugfix review/remediate resolves provider/model/effort via existing keying.
No new resolution code (Q5=A/FR-012).

- [ ] T011 [US4] Add a harness/integration assertion (SC-003/US4) demonstrating a `speckit-bugfix`
  review picking up a workflow-scoped agent override through the existing
  `resolveAgentForPhase(config, 'speckit-bugfix', 'review')` five-tier precedence
  (`config.ts:362`, delivered by #1095/#1122). Assert no new agent-resolution path is introduced —
  the test only exercises the existing one. Co-locate with the bugfix harness assertions
  (verification charter + targeted validate command + `maxRemediations` cap 2, SC-003).

## Phase 6: Polish

- [ ] T012 Add changeset `.changeset/1134-bugfix-profiles.md` — `@generacy-ai/orchestrator`
  **patch** (internal worker behavior: new `diff-classifier.ts` / `fail-then-pass.ts`,
  `review-charter.ts` verification branch, phase-loop wiring, `DEFAULT_VALIDATE_COMMAND` export;
  no `workflow-engine` label vocabulary added, no new public API). Newly-added file in the PR diff
  per the CLAUDE.md changeset gate.

## Dependencies & Execution Order

**Sequential backbone**:
- T001 (export constant) blocks T006 (wiring compares against `DEFAULT_VALIDATE_COMMAND`).
- T004 (classifier) blocks T006 and T010 (both consume `classifyDiff` / its test-glob predicate).
- T008 (`fail-then-pass.ts`) blocks T010 (wiring calls `runFailThenPass`).
- T006 (targeted-validate wiring) blocks T010 (both mutate the same validate block in
  `phase-loop.ts`; land T006 first, then extend with `failThenPass`).

**Parallel opportunities** (different files, no shared state):
- T004 + T005 (classifier + its test) can run alongside T002 + T003 (charter + its test) and
  T008 + T009 (`fail-then-pass` + its test) — three independent module tracks.
- Within US2: T004 and T005 are `[P]`. Within US3: T008 and T009 are `[P]`.

**Phase-loop serialization** (single file `phase-loop.ts`):
- T006 then T010 must be sequential — do NOT parallelize; they edit the same validate block.

**Suggested order**: T001 → (T002/T003 ∥ T004/T005 ∥ T008/T009) → T006 → T007 → T010 → T011 → T012.

## Grouping Strategy for Issue Creation

Default `epic-grouping:per-story` applies if converted via `/speckit:taskstoissues`.
US1 (T002–T003), US2 (T004–T007), US3 (T008–T010), US4 (T011), plus Setup (T001) and Polish (T012).
