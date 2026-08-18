# Tasks: Implement-phase product-diff guard — exclude agent-context files and measure the phase's own diff

**Input**: Design documents from `/specs/1107-summary-implement-phase-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/product-diff.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3), or `[Setup]`/`[Foundation]`/`[Wiring]`/`[Verify]`

## Phase 1: Setup

- [ ] T001 [Setup] Add the required changeset file `.changeset/1107-implement-product-diff-guard.md`:
  `@generacy-ai/workflow-engine` **minor** (new public `getCurrentCommitSha` / `getFilesChangedByOwnCommits` methods — new capability) and
  `@generacy-ai/orchestrator` **patch** (internal bugfix, no new public export). One file listing both packages.
  Per `CLAUDE.md`: must be a newly-added file; speckit phases do not emit changesets.

## Phase 2: Foundational primitives (blocks Core + Wiring)

These are independent local-git and Redis primitives; the exclusion set and phase-scoped diff depend on the git methods, and the phase-loop guard depends on the phase-tracker raw methods.

- [ ] T002 [P] [Foundation] Add two local-git methods to the `GitHubClient` interface in
  `packages/workflow-engine/src/actions/github/client/interface.ts`:
  `getCurrentCommitSha(): Promise<string>` and `getFilesChangedByOwnCommits(startRef: string): Promise<string[]>`.
  Place next to `getFilesChangedBetween`. (contracts/product-diff.md §GitHubClient)

- [ ] T003 [Foundation] Implement both methods in
  `packages/workflow-engine/src/actions/github/client/gh-cli.ts`, mirroring the existing
  `getFilesChangedBetween` (`gh-cli.ts:1382`) pattern (`executeCommand('git', …, { cwd: this.workdir })`):
  - `getCurrentCommitSha` → `git rev-parse HEAD`, trimmed.
  - `getFilesChangedByOwnCommits` → `git log --first-parent --no-merges --name-only --pretty=format: <startRef>..HEAD`,
    split / trim / dedupe / drop-empty. (Depends on T002)

- [ ] T004 [P] [Foundation] Add raw-key string get/set/clear to
  `packages/orchestrator/src/services/phase-tracker-service.ts`, next to the existing `#892`
  `isDuplicateRaw`/`markProcessedRaw` methods:
  `getValueRaw(key): Promise<string | null>` (null when Redis unavailable or key absent),
  `setValueRaw(key, value, ttlSeconds): Promise<void>` (`SET key value EX ttlSeconds`; no-op + warn when Redis unavailable),
  and a `clearRaw(key)` (reuse `redis.del`) if not already present. (data-model.md §PhaseTrackerService)

## Phase 3: Core implementation

- [ ] T005 [P] [US1] In `packages/orchestrator/src/worker/product-diff.ts`, add the exact-filename exclusion:
  - New constant `EXCLUDED_EXACT_PATHS = ['CLAUDE.md','AGENTS.md','GEMINI.md','.github/copilot-instructions.md']`.
  - Widen `isProductFile(path, prefixes = EXCLUDED_PATH_PREFIXES, exactPaths = EXCLUDED_EXACT_PATHS)`:
    returns `false` when `prefixes.some(p => path.startsWith(p))` **or** `exactPaths.includes(path)`.
  - Root-relative exact match only (Q3 → A): `CLAUDE.md.bak` and `packages/*/CLAUDE.md` stay product code.
  - Retain `EXCLUDED_PATH_PREFIXES` and `computeProductDiff` unchanged (FR-005). (contracts/product-diff.md §isProductFile)

- [ ] T006 [US2] In `packages/orchestrator/src/worker/product-diff.ts`, add
  `computePhaseScopedProductDiff(github, startRef): Promise<ProductDiffResult>`:
  `changedFiles = await github.getFilesChangedByOwnCommits(startRef)`;
  `productFiles = changedFiles.filter(p => isProductFile(p))`;
  set the result's `baseRef` field to `startRef` for diagnostics. `ProductDiffResult` shape unchanged.
  (Depends on T003, T005; contracts/product-diff.md §computePhaseScopedProductDiff)

## Phase 4: Wiring & guard enforcement

- [ ] T007 [P] [Wiring] In `packages/orchestrator/src/worker/types.ts`, add optional
  `phaseTracker?: PhaseTracker` to `PhaseLoopDeps`.

- [ ] T008 [Wiring] In `packages/orchestrator/src/worker/claude-cli-worker.ts`, pass the existing
  `this.phaseTracker` into `PhaseLoopDeps` at the phase-loop construction site. (Depends on T007)

- [ ] T009 [Wiring] In `packages/orchestrator/src/server.ts`, thread the already-constructed
  `workerPhaseTracker` (`server.ts:352,:380`) through to `PhaseLoopDeps` via `ClaudeCliWorker` — no new
  service instantiation. (Depends on T007, T008)

- [ ] T010 [US2] In `packages/orchestrator/src/worker/phase-loop.ts`, capture / persist / reuse the phase-start ref.
  Right after the pre-implement base-merge hook (`phase-loop.ts:301-317`) and before the CLI spawn, gated on
  `PHASES_REQUIRING_CHANGES`:
  `key = phase-start-ref:<owner>:<repo>:<issue>:<phase>`;
  `existing = await phaseTracker.getValueRaw(key)`;
  `startRef = existing ?? await github.getCurrentCommitSha()`;
  if `existing == null` → `await phaseTracker.setValueRaw(key, startRef, 7d)` (persist-once → spans all increments, Q5 → B).
  (Depends on T003, T004, T009; research.md Decision 2)

- [ ] T011 [US1] In `packages/orchestrator/src/worker/phase-loop.ts` step 5b guard (`:709-784`), switch the guard to the
  phase-scoped window and clear the ref on pass:
  `{ productFiles, changedFiles } = await computePhaseScopedProductDiff(github, startRef)` **inside the existing
  try/catch** (preserves `product-diff-error` detection failure, SC-005);
  `productFiles.length === 0` → fail via the existing `no-product-code-changes` surface (error evidence, stage comment,
  `escalateAndAlert`, loop abort — unchanged);
  on pass → `await phaseTracker.clearRaw(key)` before advancing; on failure → leave the key (TTL backstop).
  (Depends on T006, T010; FR-003)

- [ ] T012 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, extend the failure diagnostics (FR-004) at the
  existing structured log (`:755-758`) and error message (`:760-766`) to include: the phase-scoped `changedFiles` list,
  the `startRef` used and the resolved `baseRef` for context, `EXCLUDED_PATH_PREFIXES`, and `EXCLUDED_EXACT_PATHS`.
  (Depends on T011; contracts/product-diff.md §FR-004 diagnostics)

## Phase 5: Tests

- [ ] T013 [P] [US1] Unit tests in `packages/orchestrator/src/worker/__tests__/product-diff.test.ts` for the exclusion
  set and `computePhaseScopedProductDiff`: `isProductFile` cases from contracts/product-diff.md
  (`CLAUDE.md`→false, `CLAUDE.md.bak`→true, `packages/foo/CLAUDE.md`→true, `.github/copilot-instructions.md`→false,
  `specs/1107/plan.md`→false, real `src/**` path→true) and the new fn filtering a mocked `getFilesChangedByOwnCommits`.
  (SC-002)

- [ ] T014 [P] [Foundation] Unit tests in
  `packages/orchestrator/src/services/__tests__/phase-tracker-service.test.ts` for raw string get/set/clear:
  round-trip, TTL argument passed through, and null-return / no-op when Redis is unavailable.

- [ ] T015 [US2] Integration tests in
  `packages/orchestrator/src/worker/__tests__/phase-loop.product-diff.test.ts`:
  - **SC-001** field regression: branch already carrying an earlier-phase `CLAUDE.md` edit, implement phase writes only
    `specs/<slug>/conversation-log.jsonl` ⇒ phase **fails** with `no-product-code-changes`; validate never runs.
  - **SC-004**: implement phase with empty own-diff **fails** even when `baseRef...HEAD` contains earlier-phase product
    files (proves first-parent/no-merges window excludes base-merge + earlier-phase files, Q4).
  - **SC-002**: implement phase own-diff = `CLAUDE.md` only ⇒ fails.
  (Depends on T011, T012)

- [ ] T016 [P] [US3] Confirm the healthy path and detection-failure path stay green:
  update mocks for the new phase-scoped window as needed so existing defaults in
  `phase-loop.test.ts` / `claude-cli-worker.test.ts` pass (SC-003), and verify the `product-diff-error` classifier
  test at `phase-loop.test.ts:1061` is unchanged (SC-005). A phase-scoped diff with ≥1 real product file passes.

## Phase 6: Verification

- [ ] T017 [Verify] Run the full gate locally and confirm all success criteria:
  `pnpm --filter @generacy-ai/orchestrator --filter @generacy-ai/workflow-engine test` (SC-001..SC-005 green),
  `pnpm build` / typecheck for both packages, and `pnpm changeset status` shows the new
  `.changeset/1107-implement-product-diff-guard.md` covering both packages (changeset CI gate).

## Dependencies & Execution Order

**Sequential phases**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6.

**Critical path**: T002 → T003 → T006 → T010 → T011 → T012 → T015 → T017.

**Parallel opportunities**:
- Phase 2: T002 (interface) and T004 (phase-tracker) are independent `[P]`; T003 depends on T002.
- Phase 3: T005 (exclusion set) is `[P]`; T006 depends on T003 + T005.
- Phase 4: T007 is `[P]`; T008 → T009 → T010 → T011 → T012 are sequential (all edit `phase-loop.ts` / wiring chain).
- Phase 5: T013, T014, T016 are `[P]` (different files); T015 depends on the guard changes (T011/T012).

**Blocking notes**:
- The guard change (T011) cannot land before the phase-start-ref capture (T010), which needs both the git method (T003) and the phase-tracker raw methods (T004) wired through (T009).
- FR-006 (zero-tasks net) is **out of scope** (Clarification Q2 → A) — do not add it.
- No `packages/claude-plugin-cockpit/commands/*.md` files are edited by this issue, so no `playbook-verification.test.ts` re-pin task is required.
