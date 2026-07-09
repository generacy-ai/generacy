# Tasks: Base-advance re-validate + bounded validate-fix cycle

**Input**: Design documents from `/specs/892-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (base-advance-monitor.md, evidence-hash.md, validate-fix-handler.md)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = base-advance monitor; US2 = validate-fix cycle; F = foundational (shared by both)

---

## Phase 1: Foundational shared surface

- [ ] T001 [F] Add `getRefHeadSha(owner, repo, ref): Promise<string>` to `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts` (per contract D8; throws `GhAuthError` on HTTP 401 via existing #762 path).
- [ ] T002 [F] Implement `getRefHeadSha` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — `gh api repos/{o}/{r}/commits/{ref} --jq .sha`, validates 40-hex return, follows existing `executeGh` 401 mapping.
- [ ] T003 [P] [F] Add unit test for `getRefHeadSha` in `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.test.ts` (or adjacent) — happy path, malformed SHA rejection, 401 → `GhAuthError`.
- [ ] T004 [F] Add `isDuplicateRaw(key: string): Promise<boolean>` and `markProcessedRaw(key: string): Promise<void>` thin passthroughs to `PhaseTrackerService` in `packages/orchestrator/src/services/phase-tracker-service.ts` — internally identical to existing `isDuplicate`/`markProcessed` but with caller-controlled full key (per plan D6).
- [ ] T005 [P] [F] Extend `packages/orchestrator/src/services/__tests__/phase-tracker-service.test.ts` with one case: `isDuplicateRaw(fullKey)` behaves identically to existing phase-namespaced calls; regression guard against future refactor breaking key layout.
- [ ] T006 [F] Extend `WorkerContext` in `packages/orchestrator/src/worker/types.ts` with optional `resumeReason?: 'base-advance'` and `baseSha?: string` fields; thread through from resume payload (per data-model.md).

---

## Phase 2: Evidence hash pure function (US2 foundation)

<!-- Phase boundary rationale: evidence-hash.ts is a pure function with no cross-file deps; must exist before ValidateFixHandler. Can start immediately after Phase 1 (T004 unused here) — no ordering dep on T001–T003 either. -->

- [ ] T007 [P] [US2] Create fixture files in `packages/orchestrator/src/worker/__tests__/fixtures/`: `next-build-missing-module.stdout.txt`, `next-build-missing-module-rerun.stdout.txt`, `next-build-type-error.stdout.txt`, `vitest-single-failure.stdout.txt`, `vitest-multi-failure.stdout.txt`, `vitest-multi-failure-shuffled.stdout.txt`, `unknown-shape.stdout.txt`, `empty.stdout.txt` (per evidence-hash.md test surface).
- [ ] T008 [US2] Implement `hashValidationEvidence(stdout)` in `packages/orchestrator/src/worker/evidence-hash.ts` — full normalization pipeline (ANSI/timestamps/paths/PIDs/tmp/ports), `next build` + `vitest` extraction patterns, fallback path, SHA-256 hex hash of sorted `JSON.stringify({ failures })`. Export `EvidenceExtract`, `EvidenceHashResult`.
- [ ] T009 [P] [US2] Write `packages/orchestrator/src/worker/__tests__/evidence-hash.test.ts` — 8 cases per contract: same red / cosmetic re-run → same hash; reordered failures → same hash; different module → different hash; extract field shapes; fallback path; empty stdout; idempotent normalization; no env leakage (mock `Date.now`, `TZ`).

---

## Phase 3: BaseAdvanceMonitorService (US1)

<!-- Phase boundary: depends on Phase 1 (T001, T002, T004). Parallelizable with Phase 2. -->

- [ ] T010 [US1] Add `ResumeItem`, `ResumeEnqueueCallback`, `BaseAdvanceMonitorConfig` types to `packages/orchestrator/src/services/base-advance-monitor-service.ts` (or a shared `types.ts` if pattern-matching adjacent services). Shape per data-model.md §Core types.
- [ ] T011 [US1] Implement `BaseAdvanceMonitorService` in `packages/orchestrator/src/services/base-advance-monitor-service.ts`: `startPolling`/`stopPolling`/`pollCycle`/`pollRepo`, group PRs by base, one `getRefHeadSha` per group, atomic `isDuplicateRaw`+`markProcessedRaw` dedupe, semaphore concurrency, `AuthHealthSink` on `GhAuthError`, mirror `LabelMonitorService`/`PrFeedbackMonitorService` pattern.
- [ ] T012 [P] [US1] Write `packages/orchestrator/src/services/__tests__/base-advance-monitor-service.test.ts` — 8 cases per base-advance-monitor.md contract: happy path SHA change, multi-PR grouping (1 API call, N enqueues), multi-base grouping, boot re-arm, `GhAuthError` → authHealth+skip group, `enqueueResume` failure → no markProcessed → retry next cycle, `stopPolling` mid-cycle, empty repo.
- [ ] T013 [US1] Wire `BaseAdvanceMonitorService` construction in `packages/orchestrator/src/server.ts` alongside `LabelMonitorService` (mirror line ~347 wiring): pass `phaseTracker`, `createClient`, `enqueueResume` (production points at cockpit-resume handler; tests inject stub), `tokenProvider`, `authHealth`. Register `.stopPolling()` in graceful-shutdown hook.

---

## Phase 4: ValidateFixHandler (US2)

<!-- Phase boundary: depends on Phase 2 (T008 evidence-hash) and Phase 1 (T004 phase-tracker, T006 WorkerContext). -->

- [ ] T014 [US2] Extend `AgentLauncher` intent union in `packages/orchestrator/src/launcher/types.ts` with `ValidateFixIntent { kind: 'validate-fix'; prNumber; prompt; evidenceHash }`. Routes through same plugin dispatch as `pr-feedback` (no new plugin).
- [ ] T015 [US2] Implement `ValidateFixHandler` in `packages/orchestrator/src/worker/validate-fix-handler.ts` per validate-fix-handler.md: hash → dedupe check → mark processed BEFORE spawn → `collectSiblingOwnedFiles` (on-demand `gh pr diff --name-only`) → prompt build with stdout + extract + do-not-create list + hash → spawn via `agentLauncher.launch` with `buildLaunchCredentials(config.credentialRole)` → `commitChanges` → post-hoc sibling-file overlap check → `pushChanges` → emit `cluster.validate-fix` event. All failure paths early-return with emit.
- [ ] T016 [US2] Split `commitAndPushChanges` (or add `commitChanges`+`pushChanges`) in `packages/orchestrator/src/worker/pr-manager.ts` (or wherever `commitAndPushChanges` lives — verify via Grep) so the sibling-overlap check runs between commit and push. Preserve existing `PrFeedbackHandler` caller behavior via combined helper.
- [ ] T017 [P] [US2] Write `packages/orchestrator/src/worker/__tests__/validate-fix-handler.test.ts` — 9 cases per contract: first red on hash, duplicate hash → escalation, no-diff → blocked, sibling-file overlap → revert + blocked, successful attempt, spawn crash, sibling `prDiffNames` failure → partial + warn, `credentialRole` inheritance, event schema shape validation.
- [ ] T018 [US2] Wire `ValidateFixHandler` construction and phase-loop invocation in `packages/orchestrator/src/worker/claude-cli-worker.ts` (dep injection + pass into `PhaseLoopDeps`) and in the validate `catch` block of `packages/orchestrator/src/worker/phase-loop.ts`, gated STRUCTURALLY by `WorkerContext.resumeReason === 'base-advance'`. First-time reds continue to hit `LabelManager.onError('validate')`.

---

## Phase 5: End-to-end + regression

<!-- Phase boundary: depends on all preceding phases. -->

- [ ] T019 [US1+US2] Write `packages/orchestrator/src/__tests__/base-advance-e2e.test.ts` — 3-sibling convergence scenario (spec regression tests #1 + #4): three cross-dependent siblings all red at `failed:validate`; simulate sibling #1 merge → base SHA change → monitor picks up → re-validate on #2 → green → merges → re-validate on #3 → green → merges. Uses `ioredis-mock` + stubbed `GhCliGitHubClient` at command boundary.
- [ ] T020 [P] [US2] Verify no regression in `packages/orchestrator/src/services/__tests__/label-monitor-service.test.ts` — must be UNCHANGED per plan (LabelMonitorService gets no new responsibilities). Run suite; if it fails, back out label-adjacent changes.
- [ ] T021 [US2] Add `blocked:stuck-validate-fix` to the known-labels list wherever LabelManager enumerates gate/status labels (Grep for `blocked:stuck-` occurrences to find call site — likely `label-manager.ts`). If enumeration is implicit (labels are just strings), skip.

---

## Dependencies & Execution Order

**Phase dependencies (sequential):**
- Phase 1 (foundational) → unblocks Phase 3 (US1) and Phase 4 (US2)
- Phase 2 (evidence-hash) → unblocks Phase 4 (US2)
- Phases 3 and 4 can run in parallel after Phase 1 + Phase 2
- Phase 5 (e2e) depends on Phases 3 and 4 being complete

**Task-level parallel opportunities within phases:**
- Phase 1: T003 [P] and T005 [P] are test files with no shared editing surface
- Phase 2: T007 [P] (fixtures) and T009 [P] (tests) can run alongside T008 (impl) once the file exists — but T009 depends on T008's exports, so start T007 first, then T008, then T009 in parallel with any Phase 3/4 impl work
- Phase 3: T012 [P] (tests) parallel with T013 (server wiring) after T011 impl exists
- Phase 4: T017 [P] (tests) parallel with T018 (wiring) after T015 impl exists
- Phase 5: T020 [P] (regression check) parallel with T019 (e2e write) and T021 (label registration)

**Ordering invariant (D7, structural):**
- `ValidateFixHandler.handle()` MUST be invoked from exactly one call site — `PhaseLoop`'s validate `catch` block, gated by `resumeReason === 'base-advance'`. T018 is the only wiring task; reviewer checklist for any future PR touching this handler.

**Recommended execution order for a single agent:**
1. T001 → T002 → T003 (interface + impl + test for `getRefHeadSha`)
2. T004 → T005 (PhaseTrackerService passthroughs)
3. T006 (WorkerContext fields)
4. T007 → T008 → T009 (evidence hash: fixtures, impl, tests)
5. T010 → T011 → T012 → T013 (US1: types, monitor impl, tests, server wiring)
6. T014 → T015 → T016 → T017 → T018 (US2: intent, handler impl, commit split, tests, wiring)
7. T019 → T020 → T021 (e2e, regression, label registration)

---

*Generated by speckit*
