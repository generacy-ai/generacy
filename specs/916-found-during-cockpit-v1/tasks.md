# Tasks: `blocked:stuck-*` label provisioning 422s + swallowed-as-race + latent 404 at apply time (#916)

**Input**: Design documents from `/specs/916-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 / US2 / US3)

## Phase 1: Static invariants (FR-001, FR-002)

Independent, no-dependency edits. All three tasks may run in parallel.

- [ ] T001 [P] [US2] Shorten `blocked:stuck-feedback-loop` description in `packages/workflow-engine/src/actions/github/label-definitions.ts` to Q4→A wording: `'PR-feedback loop paused: last cycle could not advance the trigger. Remove to retry.'` (85 chars). No other fields touched.
- [ ] T002 [P] [US2] Shorten `blocked:stuck-validate-fix` description in `packages/workflow-engine/src/actions/github/label-definitions.ts` to Q4→A wording: `'Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap. Remove to retry.'` (94 chars). No other fields touched.
- [ ] T003 [P] [US2] Shorten `blocked:stuck-merge-conflicts` description in `packages/workflow-engine/src/actions/github/label-definitions.ts` to Q4→A wording: `'Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry.'` (86 chars). No other fields touched.
- [ ] T004 [P] [US2] Create `packages/workflow-engine/src/actions/github/__tests__/label-definitions.test.ts`: parameterized `describe.each(WORKFLOW_LABELS)` asserting each `label.description.length <= 100`, plus bulk `expect(WORKFLOW_LABELS.every(l => l.description.length <= 100)).toBe(true)`. Per FR-002 / SC-002 / `contracts/label-description-invariant.md`.

## Phase 2: Shared classifier (FR-004)

Foundation for both `LabelManager` and `LabelSyncService` consumers. Must land before Phase 3 and Phase 4.

- [ ] T005 [US1] Create `packages/workflow-engine/src/actions/github/classify-label-provisioning-error.ts`. Export `type ProvisioningErrorClassification = { readonly kind: 'already-exists' } | { readonly kind: 'error'; readonly cause: string; readonly statusCode?: number }` and `function classifyLabelProvisioningError(err: unknown): ProvisioningErrorClassification`. Implementation: extract message via `err instanceof Error ? err.message : String(err)`; race detection `/already[ _]exists/i` → `{ kind: 'already-exists' }`; HTTP-status extraction `/HTTP\s+(\d{3})/` → optional `statusCode`; strip leading `Failed to create label <name>: ` prefix; return `{ kind: 'error', cause, statusCode }`. Per `contracts/classify-label-provisioning-error.md`.
- [ ] T006 [US1] Re-export `classifyLabelProvisioningError` and `ProvisioningErrorClassification` from `packages/workflow-engine/src/index.ts` public API surface so `@generacy-ai/orchestrator` can import them.
- [ ] T007 [P] [US1] Create `packages/workflow-engine/src/actions/github/__tests__/classify-label-provisioning-error.test.ts` covering: (a) `Error("label already exists")` → `already-exists`; (b) `Error("HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)")` → `error`, statusCode `422`, cause contains `description is too long`; (c) `Error("HTTP 401: Bad credentials")` → `error`, statusCode `401`; (d) `Error("HTTP 403: Resource not accessible by integration")` → `error`, statusCode `403`; (e) `Error("HTTP 500: Internal Server Error")` → `error`, statusCode `500`; (f) `Error("Failed to create label foo: HTTP 422: ...")` → `error`, cause has the `Failed to create label foo: ` prefix stripped; (g) non-Error input (`"gone"`) → `error`, cause `gone`.

## Phase 3: LabelManager rewrite (FR-003, FR-005, FR-008)

Depends on Phase 2 (imports `classifyLabelProvisioningError`). Tasks T008–T011 all touch `packages/orchestrator/src/worker/label-manager.ts` — run sequentially. T012 is a new file (parallel with T008–T011 in principle, but easier to sequence after T011 to lock in the type shape).

- [ ] T008 [US1, US3] Create `packages/orchestrator/src/worker/provisioning-failure.ts` exporting `interface ProvisioningError { readonly cause: string; readonly statusCode?: number; readonly classifiedAt: number }`. Per data-model.md.
- [ ] T009 [US3] Add class-level state to `packages/orchestrator/src/worker/label-manager.ts`: `private static readonly provisioningFailures = new Map<string, Map<string, ProvisioningError>>()` alongside existing `ensuredRepos` / `ensureInFlight`. Extend `LabelManager.resetEnsureCacheForTests()` (currently around line 51) to also call `LabelManager.provisioningFailures.clear()`. Import `ProvisioningError` from `./provisioning-failure.js`.
- [ ] T010 [US1, US3] Rewrite the ensure-pass closure at `packages/orchestrator/src/worker/label-manager.ts:315-347`: widen closure return type from `Promise<void>` to `Promise<{ hadNonRaceFailure: boolean }>`; add local `let hadNonRaceFailure = false` and `const succeededOrRaced = new Set<string>()`; import `classifyLabelProvisioningError` from `@generacy-ai/workflow-engine`; in the catch block dispatch: race → `this.logger.debug({ label: label.name, owner, repo, err: String(err) }, 'Workflow label already exists (race)')` + `succeededOrRaced.add(label.name)`; error → `this.logger.error({ label: label.name, owner, repo, err: String(err), statusCode: classification.statusCode, cause: classification.cause }, 'Failed to create workflow label (provisioning error)')` + write to `provisioningFailures` map + set `hadNonRaceFailure = true`. After the loop, delete lineage entries for every `succeededOrRaced` label. Return `{ hadNonRaceFailure }`. Per FR-003 / FR-005 / FR-008 / SC-003 / SC-004.
- [ ] T011 [US3] Update the `ensureInFlight` storage at `packages/orchestrator/src/worker/label-manager.ts:350-355`: store `promise.then(() => undefined)` in `ensureInFlight` so shared awaiters see `void` (Q3→A). Await the wide promise inline; gate `LabelManager.ensuredRepos.add(key)` on `!hadNonRaceFailure`. Keep the `finally { LabelManager.ensureInFlight.delete(key) }` cleanup. Per FR-005 / D3 in research.md.
- [ ] T012 [US1] Enrich `addLabels` in `packages/orchestrator/src/worker/label-manager.ts` with lineage-map lookup: after the underlying `github.addLabels` call, on catch where the error message contains `HTTP 404` or `Not Found` AND the requested `labels` array includes at least one name present in `WORKFLOW_LABELS.map(l => l.name)`, look up `LabelManager.provisioningFailures.get(`${owner}/${repo}`)`; for each 404-implicated label with a lineage entry, prepend `label "<name>": <cause> (HTTP <statusCode>)` to the thrown error's message. If no lineage entry (cross-process gap), rethrow the raw 404 unchanged. Per FR-008 / SC-007 / `contracts/provisioning-lineage-map.md`.

## Phase 4: LabelSyncService per-label loop (FR-004 consumer)

Depends on Phase 2. Independent of Phase 3.

- [ ] T013 [US1] Rewrite `packages/orchestrator/src/services/label-sync-service.ts:69-107` `syncRepo`: import `classifyLabelProvisioningError` from `@generacy-ai/workflow-engine`; keep the narrow `try/catch` around only the `listLabels` call at the top (a `listLabels` failure remains fatal for the repo → return `{ success: false, error: <cause>, ... }`); remove the outer `try/catch` at line 103; introduce `let hadError = false; let firstError: string | undefined`; wrap each per-label `createLabel` / `updateLabel` in per-label `try/catch`; on catch dispatch via `classifyLabelProvisioningError`: race → `logger.info` (interface has no `debug` — D4 / D5 in research.md) + `results.push({ name: label.name, action: 'unchanged' })` + `unchanged++` + continue; error → `logger.error` with `{ label, owner, repo, err, statusCode?, cause }` + set `hadError = true` + `firstError ??= classification.cause` + continue. Return `{ owner, repo, success: !hadError, created, updated, unchanged, error: firstError, results }`. Per FR-004 / D5 in research.md.

## Phase 5: Regression tests (FR-006, FR-007)

All test-only work. Depends on Phases 3 + 4 for the implementations under test. T014–T017 touch three different test files and may run in parallel.

- [ ] T014 [P] [US1, US2, US3] Add a new `describe('classifies provisioning failures')` block to `packages/orchestrator/src/worker/__tests__/label-manager.ensure.test.ts`: mock `github.createLabel` to throw `new Error('Failed to create label ' + name + ': HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)')` for every `blocked:stuck-*` name; call `lm.onPhaseComplete('plan')`; assert (a) three `mockLogger.error` calls with `{ label, statusCode: 422, cause: expect.stringContaining('description is too long') }` and message `'Failed to create workflow label (provisioning error)'`; (b) `mockLogger.warn` NOT called with `'may already exist'`; (c) `github.addLabels` still called (outer op runs); (d) `LabelManager.ensuredRepos.has('test-owner/test-repo') === false`; (e) `LabelManager.provisioningFailures.get('test-owner/test-repo')?.size === 3`; (f) a subsequent `onPhaseComplete('specify')` on the same manager re-invokes `listLabels` + `createLabel` (retry). Per FR-006 / SC-003 / SC-005 / SC-006.
- [ ] T015 [P] [US1] Update the existing race-behavior test at `packages/orchestrator/src/worker/__tests__/label-manager.ensure.test.ts:104-124`: change log assertion from `mockLogger.warn` → `mockLogger.debug`; change substring match from `'Failed to create workflow label'` → `'Workflow label already exists (race)'`; assert `ensuredRepos.has(key) === true` (race still populates cache); assert `LabelManager.provisioningFailures.get(key)` is undefined or empty (race does NOT write to lineage). Per FR-007 / SC-004.
- [ ] T016 [P] [US1, US3] Create `packages/orchestrator/src/worker/__tests__/label-manager.addlabels-enrichment.test.ts`: two fixtures. (1) Same-process 404 lineage: prime lineage via a failed pass (T014 fixture shape), then mock `github.addLabels` to throw `new Error('HTTP 404: Not Found')` on `[blocked:stuck-feedback-loop, agent:paused]`; assert the thrown error from the `LabelManager` method includes `label "blocked:stuck-feedback-loop": description is too long (HTTP 422)`. (2) Cross-process 404 lineage (map miss): call `LabelManager.resetEnsureCacheForTests()`, then `github.addLabels` returns 404 without a prior lineage entry; assert the thrown error is the raw 404 unchanged. Per FR-008 / SC-007.
- [ ] T017 [P] [US1] Create `packages/orchestrator/src/services/__tests__/label-sync-service.classify.test.ts`: two fixtures. (1) All-races: every `createLabel` throws `new Error('label already exists')` — assert `success: true`, `logger.info` called (not `error`), all labels in `results` with `action: 'unchanged'`. (2) One 422: one `createLabel` throws `new Error('HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)')`, others succeed — assert `success: false`, `error` contains `description is too long`, `logger.error` called once with `{ label, statusCode: 422, cause: expect.stringContaining('description is too long') }`, the other labels still recorded in `results`. Per FR-004 / D5 in research.md.

## Phase 6: Verification

- [ ] T018 Run the quickstart in `specs/916-found-during-cockpit-v1/quickstart.md` and confirm all steps pass. Run the full suites: `pnpm --filter @generacy-ai/workflow-engine test` and `pnpm --filter @generacy-ai/orchestrator test`. Confirm no `WORKFLOW_LABELS` entry exceeds 100 chars, the classifier tests pass, the ensure-pass regression fixture passes, and the enrichment + sync-service tests pass.

## Dependencies & Execution Order

**Phase sequencing (must complete in order)**:
- Phase 1 → (Phase 2 → (Phase 3 || Phase 4) → Phase 5) → Phase 6

**Concrete dependency graph**:
- Phase 1 (T001–T004) has no dependencies — pure `label-definitions.ts` edits + a new static test file.
- Phase 2 (T005 → T006 → T007) — T005 defines the classifier; T006 re-exports it; T007 tests it. T006 blocks Phase 3's imports.
- Phase 3 (T008 → T009 → T010 → T011 → T012) — sequential because T009–T012 all edit `label-manager.ts`; T008 defines the type that T009 imports.
- Phase 4 (T013) — depends on Phase 2 (T006 re-export) only. Independent of Phase 3.
- Phase 5 (T014, T015, T016, T017) — all four run in parallel. T014 + T015 + T016 depend on Phase 3 (test the LabelManager rewrite); T017 depends on Phase 4 (tests the sync-service rewrite).
- Phase 6 (T018) — final verification once Phases 1–5 are green.

**Parallel opportunities**:
- Within Phase 1: T001, T002, T003, T004 all `[P]` — same file for T001–T003 (three separate string edits), different file for T004.
- Within Phase 5: T014, T015, T016, T017 all `[P]` — three distinct test files (`label-manager.ensure.test.ts` for T014+T015 same file but non-overlapping regions; `label-manager.addlabels-enrichment.test.ts` for T016; `label-sync-service.classify.test.ts` for T017). Sequence T014 → T015 within `label-manager.ensure.test.ts` if the parallel edit tool struggles with in-file coordination.
- Phase 3 and Phase 4 can proceed in parallel after Phase 2 lands, since they touch disjoint files.

**Atomic PR (FR-009)**: All 18 tasks ship in a single PR — no feature-flagging, no staged rollout.
