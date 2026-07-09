# Tasks: Self-authored comment trust via GraphQL `viewerDidAuthor`

**Input**: Design documents from `/specs/878-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Pre-implementation Gate

- [ ] T001 [US1] FR-007 grep-audit: search `packages/orchestrator/src` and `packages/workflow-engine/src` for any self-recognition consumer on the pr-feedback surface that does not go through `getPRReviewThreads()` (the thread-shaped GraphQL client). Search terms: `clusterIdentity`, `resolveActingIdentity`, `CLUSTER_ACTING_LOGIN`, `normalizeLogin(.*actingLogin|.*clusterIdentity)`. Expected result: only the sites enumerated in plan.md. If a straggler surfaces, migrate it to `getPRReviewThreads()` in the same PR (FR-007 Q2→B remedy) rather than halting.

## Phase 2: GraphQL Query & Type Extensions

- [ ] T002 [US1] Add optional `viewerDidAuthor?: boolean` field to `Comment` interface in `packages/workflow-engine/src/types/github.ts` (~lines 72–94). Include the JSDoc block from `data-model.md` describing "populated by `getPRReviewThreads()` only" semantics.

- [ ] T003 [US1] Extend `getPRReviewThreads()` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (~lines 479–576):
  - Add `viewerDidAuthor` to the GraphQL query's `comments.nodes` selection.
  - Add `viewerDidAuthor: boolean | null` to the parsed-response type inside `comments.nodes[]`.
  - Inside the `commentNodes.map(...)` loop, populate the field with a conditional assignment mirroring the existing `authorAssociation` pattern: `if (c.viewerDidAuthor !== null && c.viewerDidAuthor !== undefined) comment.viewerDidAuthor = c.viewerDidAuthor;`.

- [ ] T004 [US1] Add gh-cli tests covering `viewerDidAuthor` propagation from the mocked `gh api graphql` response into the parsed `Comment[]` — four rows from `contracts/review-thread-query.contract.md`: `true` → `true`, `false` → `false`, `null` → absent, missing key → absent.

## Phase 3: Trust Predicate Replacement

- [ ] T005 [US1] Rename `TrustReason` union entry `'cluster-identity'` → `'self-authored'` in `packages/workflow-engine/src/security/comment-trust.ts`. Hard rename per Q1→D — no dual-emit. TS compiler flags every consumer; fix them in the same commit.

- [ ] T006 [US1] Remove the `clusterIdentity?: string` field from `CommentTrustContext` in `packages/workflow-engine/src/security/comment-trust.ts`. Callers stop threading it; the self-authored signal now lives on the comment itself.

- [ ] T007 [US1] Replace decision 1.5 in `isTrustedCommentAuthor()` in `packages/workflow-engine/src/security/comment-trust.ts` per `contracts/trust-predicate.contract.md`:
  - `comment.viewerDidAuthor === true` → `{ trusted: true, reason: 'self-authored' }`.
  - `comment.viewerDidAuthor !== false` (i.e., `null` / `undefined` / non-boolean) → `ctx.logger.warn({ commentId, observedValue }, 'viewerDidAuthor missing/non-boolean on comment; treating as not self-authored')` and fall through to decision 2.
  - Delete the `normalizeLogin(comment.author)` vs `normalizeLogin(ctx.clusterIdentity)` comparison. `normalizeLogin` itself stays (decision 1's `botLogin` path still calls it).

- [ ] T008 [US1] Rewrite `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`:
  - Delete the 16 positive + 4 negative `normalizeLogin` fixture pairs used for the cluster-identity path.
  - Delete the T1–T6 cluster-identity tests.
  - Add fixtures S1–S7 from `contracts/trust-predicate.contract.md` (self-authored true, false, false+OWNER, undefined + warn, null + warn, botLogin-wins ordering, surface-agnostic).

## Phase 4: Orchestrator Cleanup

- [ ] T009 [US1] Delete `packages/orchestrator/src/services/acting-identity.ts` and `packages/orchestrator/src/services/__tests__/acting-identity.test.ts`. No replacement — the mechanism they serve is dissolved.

- [ ] T010 [US1] Update `packages/orchestrator/src/server.ts` (~lines 45, 172, 347, 416):
  - Delete `resolveActingIdentity` import and call site.
  - Delete `actingIdentity` from the `ClaudeCliWorker` constructor threading.
  - Delete `actingIdentity` from the `PrFeedbackMonitorService` constructor threading.

- [ ] T011 [US1] Update `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (~lines 95, 103, 216–221, 298–314) per `contracts/skip-warn-shape.contract.md` Site 1:
  - Delete `actingIdentity` constructor arg + field.
  - At the trust-filter site (~line 216), record `viewerDidAuthor` on each `untrustedCommentSkips[]` entry alongside `commentId` / `author` / `authorAssociation` / `reason`.
  - Rewrite the zero-trusted warn payload (~lines 298–314): drop top-level `clusterIdentity` and `normalizedClusterIdentity`; drop per-skip `normalizedAuthor`; add per-skip `viewerDidAuthor: s.viewerDidAuthor ?? null`.

- [ ] T012 [US1] Update `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` (~lines 1677–1715) to match the new constructor signature and skip-warn evidence shape from T011.

- [ ] T013 [US1] Update `packages/orchestrator/src/worker/pr-feedback-handler.ts` (~lines 79, 123–131, 169, 192–227, 272–288) per `contracts/skip-warn-shape.contract.md` Sites 2 & 3:
  - Delete `clusterIdentity` constructor arg + field.
  - Delete the FR-006 degraded-mode error log block (~lines 123–131).
  - Add `viewerDidAuthor?: boolean` to the local `untrustedSkips` element type (~line 169).
  - Trust-filter loop (~line 205) records `viewerDidAuthor` into each pushed object.
  - Rewrite per-skip info log (~lines 212–227): drop `normalizedAuthor` / `clusterIdentity` / `normalizedClusterIdentity`; add `viewerDidAuthor: c.viewerDidAuthor ?? null`.
  - Rewrite zero-trusted warn (~lines 272–288): drop top-level `clusterIdentity` / `normalizedClusterIdentity`; drop per-skip `normalizedAuthor`; add per-skip `viewerDidAuthor: s.viewerDidAuthor ?? null`.

- [ ] T014 [US1] Update `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` (~line 1023) to match the new constructor signature and evidence shape from T013.

- [ ] T015 [US1] Update `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts` fixtures and assertions: replace `'cluster-identity'` reason strings with `'self-authored'`; replace `clusterIdentity` context threading with per-comment `viewerDidAuthor` on fixture comments; assert the SC-001 scenario (only unresolved comment has `viewerDidAuthor: true`, `authorAssociation: 'NONE'` → trusted, handler proceeds).

## Phase 5: Scaffolder Cleanup (generacy CLI)

- [ ] T016 [P] [US1] Delete `actingLogin?: string` from `ScaffoldEnvInput`, the `actingLoginLines` computation, and the `CLUSTER_ACTING_LOGIN=…` interpolation in generated `.env` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` (~lines 54–60, 347–350, 358).

- [ ] T017 [P] [US1] Delete `actingLogin: config.actingLogin` forwarding in `packages/generacy/src/cli/commands/launch/scaffolder.ts` (~line 114).

- [ ] T018 [P] [US1] Delete `actingLogin: config.actingLogin` forwarding in `packages/generacy/src/cli/commands/deploy/scaffolder.ts` (~line 73).

- [ ] T019 [P] [US1] Delete `actingLogin: z.string().min(1).optional()` from `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts` (~line 75).

- [ ] T020 [US1] Update `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` (~lines 735–800): delete the 4 `CLUSTER_ACTING_LOGIN` tests (absent / present / whitespace / raw-value-written); add a negative test asserting the generated `.env` never contains the string `CLUSTER_ACTING_LOGIN`.

## Phase 6: Polish

- [ ] T021 [US1] Run SC-003 grep-audit: `grep -r CLUSTER_ACTING_LOGIN packages/*/src` must return zero matches. If a straggler surfaces, remove it before opening the PR.

- [ ] T022 [US1] Add one-line notes to the changeset:
  - Breaking change (FR-004): `TrustReason` union entry `'cluster-identity'` renamed to `'self-authored'` on the `pr-feedback` surface.
  - Operator note (FR-005): `CLUSTER_ACTING_LOGIN` is unused and safe to remove from existing `.env` and `docker-compose.yml`. No auto-cleanup; no startup compat log.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (audit gate) blocks all implementation phases.
- T002 (Comment type) blocks T003, T007, T011, T013.
- T003 blocks T004.
- T005 (TrustReason rename) blocks T007, T011, T013, T015 (all consume the union).
- T006 (drop `clusterIdentity` from context) blocks T011, T013.
- T007 blocks T008.
- T009 (delete acting-identity files) blocks T010.
- T011 blocks T012.
- T013 blocks T014.
- T011 + T013 block T015.
- T016 blocks T020.
- All implementation tasks block T021 (SC-003 grep-audit) and T022 (changeset notes).

**Parallel opportunities**:
- **Scaffolder cleanup group**: T016 / T017 / T018 / T019 touch four separate files with no cross-dependencies → run in parallel after T001.
- **Independent from workflow-engine changes**: the entire Phase 5 (scaffolder) is independent from Phases 2–4 and can start immediately after T001.
- **Test updates**: T012 / T014 / T015 touch different test files and can be authored in parallel once their production sources (T011 / T013) are in place.

**Recommended execution order** (single atomic PR, per FR-008 / Q5→D):
1. T001 (audit gate).
2. T002 → T003 → T004 (query + type + client tests).
3. T005 + T006 in the same commit (union rename + context field removal — TS compiler surfaces the callers to fix).
4. T007 → T008 (predicate + predicate tests).
5. T009 → T010 (delete acting-identity, unwire server).
6. T011 → T012, T013 → T014 in parallel; then T015 (integration).
7. T016 / T017 / T018 / T019 in parallel; then T020.
8. T021 (SC-003 grep-audit) — must return zero.
9. T022 (changeset notes) — final commit before opening PR.
