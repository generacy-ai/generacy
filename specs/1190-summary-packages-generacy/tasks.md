# Tasks: activation test reads ambient `GENERACY_PROJECT_ID` — validate red in every cluster worker

**Input**: Design documents from `/specs/1190-summary-packages-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/activate-options.md, clarifications.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / requirement this task belongs to

## Phase 1: Production Refactor (FR-003)
<!-- Make runActivation pure w.r.t. GENERACY_PROJECT_ID; move the single ambient read to the composition root. -->

- [ ] T001 [US-Primary] Add optional `projectId?: string` to the `ActivateOptions` interface in
  `packages/generacy/src/cli/commands/deploy/activation.ts`. Destructure `projectId` from
  options and pass it to `buildActivationUrl(...)` in place of the current
  `process.env['GENERACY_PROJECT_ID']` read at `activation.ts:52`. Leave `buildActivationUrl`
  itself unchanged (still appends `&projectId=<id>` only when truthy → NFR-001 byte-identity,
  INV-2). Confirm no other `process.env` read remains in `runActivation` (INV-1).

- [ ] T002 [US-Primary] In `packages/generacy/src/cli/commands/deploy/index.ts`, resolve
  `process.env['GENERACY_PROJECT_ID']` exactly once at the `runActivation({ cloudUrl, logger })`
  call site (`index.ts:40`) and forward it as `projectId` (INV-3, single ambient read). This is
  the sole legitimate owner of the ambient-environment coupling. Depends on T001 (needs the new
  options field).

## Phase 2: Deterministic Test Coverage (FR-001, FR-002, FR-004)
<!-- Both branches of buildActivationUrl exercised independent of ambient env. -->

- [ ] T010 [US-Tertiary] Rewrite `packages/generacy/tests/unit/deploy/activation.test.ts`:
  keep the existing `'calls openUrl with the verification_uri'` case but pass **no** `projectId`
  and assert the projectId-free URL `https://generacy.ai/activate?code=ABCD-1234` (SC-003 absent
  branch). Add a sibling case passing a fixed `projectId: 'fixed-proj-id'` (or similar) that
  asserts `https://generacy.ai/activate?code=ABCD-1234&projectId=fixed-proj-id` (SC-003 present
  branch). Both cases pass `projectId` explicitly through options — no ambient-env dependency.
  If any `vi.stubEnv` is introduced, pair it with `vi.unstubAllEnvs()` in `afterEach` (FR-004).
  Depends on T001 (test passes `projectId` via the new options field).

## Phase 3: Load-Sensitive Export Test Fix (FR-006, Q2=B)
<!-- Independent file; parallelizable with Phase 2. -->

- [ ] T020 [P] [US-Secondary] Fix the main-entry smoke case in
  `packages/generacy/__tests__/exports.test.ts` (line ~17, `await import('@generacy-ai/generacy')`).
  Apply the plan's chosen fix: give the `it(...)` case an explicit generous timeout `60_000` (third
  arg) so it survives the ~6 s vitest transform of the CLI barrel under worker load. Preserve the
  main-barrel coverage (do not drop the case, do not weaken the 19 subpath tests). SC-006.

## Phase 4: Audit & Changeset (FR-005, NFR-002)

- [ ] T030 [P] [US-Primary] FR-005 sibling audit: grep `packages/generacy/tests` and
  `packages/generacy/__tests__` for `process.env` / `stubEnv` usages. Confirm the two known
  benign sites remain benign — `tests/integration/deploy-dind.test.ts:15` (skip guard) and
  `tests/unit/deploy/scaffolder.test.ts:157` (test-provided input, not ambient). Fix any *new*
  unisolated `process.env`-derived assertion found. SC-004. Independent of T001–T020.

- [ ] T031 [P] [US-Primary] Create `.changeset/1190-activation-projectid-purity.md` —
  `@generacy-ai/generacy` **patch** (`workflow:speckit-bugfix`; internal `runActivation` purity
  refactor + two test fixes, no public export change). MUST be a newly-added file (the changeset
  gate greps `--diff-filter=A` against `origin/develop`). NFR-002. Copy the shape of a comparable
  existing `.changeset/*.md`.

## Phase 5: Verification
<!-- Run after all edits land. -->

- [ ] T040 [US-Primary] Verify SC-001 → SC-006 per quickstart.md, from `packages/generacy`:
  - `GENERACY_PROJECT_ID=any-value pnpm vitest run tests/unit/deploy/activation.test.ts` → green (SC-001)
  - `pnpm vitest run tests/unit/deploy/activation.test.ts` (var unset) → green (SC-002)
  - `npx vitest run __tests__/exports.test.ts` → green, no timeout (SC-006)
  - `pnpm --filter @generacy-ai/generacy test` with and without `GENERACY_PROJECT_ID` set → green (SC-005)
  - Record the FR-006 chosen option (60 s timeout) in the PR description.

## Dependencies & Execution Order

**Sequential chain**: T001 → T002 (index.ts needs the new options field) and T001 → T010
(test passes `projectId` through the new field).

**Parallel opportunities**:
- T020 (exports.test.ts) is a different file with no dependency on the refactor — run in
  parallel with Phase 2.
- T030 (audit) and T031 (changeset) touch neither the source refactor nor the tests — run in
  parallel with any prior phase.

**Blocking**: T040 (verification) runs last, after T001, T002, T010, T020, T031 all land.
