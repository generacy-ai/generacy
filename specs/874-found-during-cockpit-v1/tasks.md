# Tasks: Acting-identity resolution for the `cluster-identity` trust rule

**Input**: Design documents from `/specs/874-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)

## Phase 1: Foundation — normalization helper (blocks everything downstream)

- [ ] T001 [US1] Add `normalizeLogin(raw: string): string` exported helper in `packages/workflow-engine/src/security/comment-trust.ts` implementing the pipeline `raw.trim().toLowerCase().replace(/\[bot\]$/, '')` per `contracts/normalize-login.contract.md`.
- [ ] T002 [US1] Apply `normalizeLogin()` to both sides of the `botLogin === comment.author` comparison in `packages/workflow-engine/src/security/comment-trust.ts` (currently around line 87). Empty-string result must not match — guard the branch.
- [ ] T003 [US1] Apply `normalizeLogin()` to both sides of the `clusterIdentity === comment.author` comparison in `packages/workflow-engine/src/security/comment-trust.ts` (currently around line 94). Empty-string result must not match — guard the branch.
- [ ] T004 [US1] Add SC-002 table-driven test in `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`: 16 fixture pairs from `contracts/normalize-login.contract.md` × 2 (bot-path and cluster-identity-path) all return `{ trusted: true, reason: 'bot' }` / `{ trusted: true, reason: 'cluster-identity' }`. Include the 4 negative fixtures (must not match). Include the empty/edge input cases from the contract.

## Phase 2: Orchestrator — acting-identity resolver (depends on Phase 1's `normalizeLogin` export)

- [ ] T005 [US2] Create `packages/orchestrator/src/services/acting-identity.ts` exporting `resolveActingIdentity(logger: Logger): string | undefined`. Reads `process.env['CLUSTER_ACTING_LOGIN']`, trims, and on non-empty: normalizes via imported `normalizeLogin` from `@generacy-ai/workflow-engine`, emits `logger.info({ actingLogin, source: 'env' }, 'Acting identity resolved: <normalized> (from CLUSTER_ACTING_LOGIN)')`, returns normalized value. On unset/empty: emits the exact FR-006 error line from `contracts/acting-identity-resolver.contract.md` and returns `undefined`.
- [ ] T006 [P] [US2] Create `packages/orchestrator/src/services/__tests__/acting-identity.test.ts` covering the 7 test cases from `contracts/acting-identity-resolver.contract.md`: env set (bot login, display case, whitespace-wrapped, `[bot]`-suffixed), env unset, env empty, env whitespace-only. Assert exact FR-006 error shape including `triedChain: ['CLUSTER_ACTING_LOGIN']` and `outcome: 'unset-or-empty'`.

## Phase 3: Orchestrator wiring — thread acting identity to trust callsites (depends on Phase 2)

- [ ] T007 [US1] In `packages/orchestrator/src/server.ts`, call `resolveActingIdentity(server.log)` once in `createServer()` near line 161 alongside the existing `resolveClusterIdentity()` call. Store as local `actingIdentity: string | undefined`. Do NOT modify or replace the `resolveClusterIdentity()` call — assignee identity keeps flowing through `filterByAssignee()` unchanged.
- [ ] T008 [US1] In `packages/orchestrator/src/server.ts` at line 337, change `ClaudeCliWorkerDeps.clusterIdentity` to receive `actingIdentity` (not `clusterGithubUsername`).
- [ ] T009 [US1] In `packages/orchestrator/src/server.ts` at the `PrFeedbackMonitorService` construction site (currently passing `clusterGithubUsername` at line ~209 of the referenced service), change the constructor arg to `actingIdentity`.
- [ ] T010 [US1] Add regression test in `packages/orchestrator/src/services/__tests__/` (or extend existing) asserting FR-007: the trust predicate NEVER consults `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`, or `gh api /user` for the acting-identity comparison. Prove this by constructing a scenario where `CLUSTER_GITHUB_USERNAME` is set to a login and `CLUSTER_ACTING_LOGIN` is unset — a comment authored by `CLUSTER_GITHUB_USERNAME` must NOT be trusted via `cluster-identity`.

## Phase 4: Skip-warn observability (FR-005) — depends on Phase 3 wiring

- [ ] T011 [US2] In `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` at line 285 ("PR has unresolved threads but every comment author is untrusted"), extend the warn context per `contracts/skip-warn-shape.contract.md` Site 1: add top-level `clusterIdentity: string | null` (raw value or null) and `normalizedClusterIdentity: string | null`, and per-entry `normalizedAuthor: string` inside each `untrustedCommentSkips` element. Use `normalizeLogin()` from `@generacy-ai/workflow-engine`.
- [ ] T012 [US2] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` at line 263 ("Zero-trusted unresolved threads — retaining waiting-for:address-pr-feedback label (FR-002)"), apply the same shape extension as T011 (Site 2 in the contract).
- [ ] T013 [US2] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` at line 210 ("Skipped PR review comment from untrusted author"), extend the info log context per Site 3 of the contract: add `normalizedAuthor`, `clusterIdentity`, and `normalizedClusterIdentity`.
- [ ] T014 [US2] In `packages/orchestrator/src/worker/pr-feedback-handler.ts` at line 125, update the existing `triedChain` from `['config', 'CLUSTER_GITHUB_USERNAME', 'GH_USERNAME', 'gh api user']` to `['CLUSTER_ACTING_LOGIN']`. Update message text to: `'Acting identity unresolvable at handler runtime — cluster-identity trust rule will not fire; tier-based trust still applies.'`
- [ ] T015 [US2] Extend or update `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`: update the H7 case that currently asserts the old chain to assert `['CLUSTER_ACTING_LOGIN']`; add a new case asserting `Generacy-AI` provisioned + author `generacy-ai[bot]` (REST) and `generacy-ai` (GraphQL) both resolve to `reason: cluster-identity`.

## Phase 5: Scaffolder plumbing (FR-003) — parallelizable with Phase 3/4

- [ ] T016 [P] [US1] In `packages/generacy/src/cli/commands/cluster/scaffolder.ts`, extend the `ScaffoldEnvInput` type with optional `actingLogin?: string`. In `scaffoldEnvFile()`, emit `CLUSTER_ACTING_LOGIN=${input.actingLogin}` in the "Identity (from cloud LaunchConfig — do not edit)" section directly below `GENERACY_ORG_ID` **only when set (truthy after trim)**. Emit nothing when unset.
- [ ] T017 [P] [US1] Extend `packages/generacy/src/cli/commands/launch/types.ts` `LaunchConfigSchema` with `actingLogin: z.string().min(1).optional()`.
- [ ] T018 [US1] In `packages/generacy/src/cli/commands/launch/scaffolder.ts`, thread `config.actingLogin` into the `scaffoldEnvFile()` call. Depends on T016 + T017.
- [ ] T019 [US1] In `packages/generacy/src/cli/commands/deploy/scaffolder.ts`, thread `config.actingLogin` into the `scaffoldEnvFile()` call. Depends on T016 + T017.
- [ ] T020 [P] [US1] Extend `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` with three cases: (a) `actingLogin` absent → generated `.env` contains no `CLUSTER_ACTING_LOGIN=` line; (b) `actingLogin: 'generacy-ai'` → single `CLUSTER_ACTING_LOGIN=generacy-ai` line placed directly under `GENERACY_ORG_ID=`; (c) `actingLogin: ' generacy-ai '` — verify raw value written (normalization is a container-side concern, per plan §5).

## Phase 6: Integration test surface fixup

- [ ] T021 [US1] Update the stub in `pr-feedback-integration.test.ts` (per plan.md line 175 pointer at "line 2352") that currently pattern-matches `ctx.clusterIdentity && comment.author === ctx.clusterIdentity` — replace with the normalization branch mirroring the production predicate. Add one new fixture asserting a `[bot]` suffix mismatch normalizes correctly end-to-end. Locate the file via grep for the exact pattern before modifying.

## Phase 7: Manual verification (see `quickstart.md`)

- [ ] T022 [US1] Run the §1-§3 quickstart flow: scaffold or upgrade a local cluster, add `CLUSTER_ACTING_LOGIN=generacy-ai` to `.env`, restart, verify `reason: cluster-identity` fires on cockpit-authored comments and no `untrustedCommentSkips` warn appears for that PR.
- [ ] T023 [US2] Run the §4 degraded-mode flow: remove the var, restart, verify exactly one `error`-level boot line naming `triedChain: ['CLUSTER_ACTING_LOGIN']`, and verify every skip-warn context contains `clusterIdentity: null` + `normalizedClusterIdentity: null` and each skip entry contains `normalizedAuthor`.

## Dependencies & Execution Order

**Sequential ordering (critical path)**:
1. **Phase 1 first** — `normalizeLogin` is imported by every downstream change. T001 → T002/T003 (same file, serialize) → T004.
2. **Phase 2 after Phase 1** — resolver imports `normalizeLogin`. T005 blocks T006 (test targets the impl).
3. **Phase 3 after Phase 2** — wiring uses resolver return type. T007 → T008 + T009 (both edit `server.ts`, serialize). T010 depends on T007-T009.
4. **Phase 4 after Phase 3** — skip-warn changes require the acting-identity value to be threaded. T011, T012, T013, T014 all touch orchestrator files; T012/T013/T014 share `pr-feedback-handler.ts` (serialize). T015 depends on T014.
5. **Phase 5 can run in parallel with Phase 3/4** — scaffolder changes are in a separate package and don't depend on orchestrator wiring. T016 + T017 parallel; T018/T019 depend on both; T020 depends on T016.
6. **Phase 6 after Phase 1-4** — integration fixup mirrors production predicate.
7. **Phase 7 after all code changes** — requires built + running cluster.

**Parallel opportunities within phases**:
- T006 is `[P]` — separate test file, only depends on T005's impl surface.
- T016, T017, T020 are `[P]` — different files in the scaffolder area (types vs env-writer vs test).
- Phase 5 as a whole can proceed concurrently with Phases 3-4 once Phase 1 lands (`normalizeLogin` export is the only cross-package dep, and Phase 5 doesn't consume it).

**File-serialization constraints**:
- `packages/workflow-engine/src/security/comment-trust.ts` — T001/T002/T003 (same file).
- `packages/orchestrator/src/server.ts` — T007/T008/T009 (same file).
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` — T012/T013/T014 (same file).
