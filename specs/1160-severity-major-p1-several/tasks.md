# Tasks: Per-workflow/agent config keys parse but do not apply

**Input**: Design documents from `/specs/1160-severity-major-p1-several/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/config-resolution.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
  - US1 = per-workflow `validateCommand` (FR-001/FR-002)
  - US2 = per-workflow `preValidateCommand` (FR-003/FR-004)
  - US3 = `phases.review`/`phases.remediate` agent selection (FR-005)
  - US4 = `ciWaitTimeoutMs` per-workflow override (FR-006)

## Phase 1: Schema & Resolver Foundation

These land first: US4's schema field and the new agent helper are prerequisites for
later call-site wiring and tests. The two `phase-loop.ts` command fixes (US1/US2)
depend only on the *already-shipped* `resolveWorkflowOverrides` and are independent
of this phase.

- [X] T001 [US4] Add `ciWaitTimeoutMs: z.number().int().min(30_000).optional()` to the
  `.strict()` `WorkflowOverrideSchema` in `packages/config/src/template-schema.ts`,
  beside `maxRemediations`. `.min(30_000)` mirrors the `WorkerConfigSchema.ciWaitTimeoutMs`
  bound (config.ts:157) so an override cannot undercut the cluster floor. Preserve
  `.strict()` (unknown keys still rejected).

- [X] T002 [US4] In `packages/orchestrator/src/worker/config.ts`: add
  `ciWaitTimeoutMs: number` to `ResolvedWorkflowConfig` (config.ts:38-47) and resolve it
  in `resolveWorkflowOverrides` (config.ts:70-81) as
  `ciWaitTimeoutMs: wf?.ciWaitTimeoutMs ?? config.ciWaitTimeoutMs` (no repo tier — mirrors
  `maxRemediations`). De-stale the "Per-workflow-overridable" comment at config.ts:155 so
  it is now accurate. Depends on T001.

- [X] T003 [P] [US3] Add pure helper `resolveReviewLikeAgent(config, workflowName, phase:
  'review' | 'remediate')` to `packages/orchestrator/src/worker/config.ts`, beside
  `resolveAgentForPhase`. Behavior: `base = resolveAgentForPhase(config, workflowName,
  'implement')`; `tier = config.agents?.workflows?.[workflowName]?.phases?.[phase]`; then
  per field `provider = tier?.provider ?? base.provider`, `model = tier?.model ??
  base.model`, `effort = tier?.effort ?? base.effort`; reassemble with the same
  optional-field discipline as `resolveAgentForPhase` (only attach `model`/`effort` when
  defined). Remediate never consults the `review` tier (Q3=A) — its base is always the
  `implement` resolution. Export it. Independent of T001/T002 (different function in the
  same file — coordinate the edit if landed concurrently).

## Phase 2: Call-Site Wiring

- [X] T004 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, change the
  non-bugfix validate seed at ~line 696 from `let effectiveValidateCommand =
  config.validateCommand;` to seed from `resolveWorkflowOverrides(config, settings,
  workflowName).validateCommand`. Do NOT touch `resolveTargetedValidate` (phase-loop.ts:1815)
  — it already resolves per-workflow and overwrites `effectiveValidateCommand`, preserving
  FR-002 (targeted narrowing composes over the resolved base) by construction. Independent
  of Phase 1.

- [X] T005 [US2] In `packages/orchestrator/src/worker/phase-loop.ts`, replace the raw
  `config.preValidateCommand` read at the install step (~line 662) with
  `resolveWorkflowOverrides(config, settings, workflowName).preValidateCommand`. No new
  branch: `??` in the resolver preserves an explicit `""` and the existing `if (cmd)`
  truthiness guard already skips install on empty-string (FR-004), while `undefined`/`null`
  falls through to the cluster default (FR-003). Independent of Phase 1 and T004.

- [X] T006 [US4] In `packages/orchestrator/src/worker/phase-loop.ts`, wire the resolved
  `ciWaitTimeoutMs` into the `waitForCiGreen({ ciWaitTimeoutMs })` call at ~line 1333,
  reading `resolveWorkflowOverrides(config, settings, workflowName).ciWaitTimeoutMs`
  instead of `config.ciWaitTimeoutMs` raw. Depends on T002.

- [X] T007 [US3] In `packages/orchestrator/src/worker/review-executor.ts` (~line 126),
  replace `resolveAgentForPhase(config, w, 'implement')` with
  `resolveReviewLikeAgent(config, w, 'review')`. Depends on T003.

- [X] T008 [US3] In `packages/orchestrator/src/worker/remediate-executor.ts` (~line 98),
  replace `resolveAgentForPhase(config, w, 'implement')` with
  `resolveReviewLikeAgent(config, w, 'remediate')`. Depends on T003.

## Phase 3: Round-Trip Tests (FR-008 — acceptance gate)

Each key gets a test proving it reaches its runtime call site for the workflow it names.

- [X] T009 [P] [US4] MOD `packages/config/src/__tests__/template-schema.test.ts`: assert
  `WorkflowOverrideSchema` accepts `ciWaitTimeoutMs` (a legal ≥30_000 integer); assert a
  value `< 30_000` and a non-integer are rejected; assert an unknown key under
  `workflows.<name>` is still rejected (`.strict()` preserved). Depends on T001.

- [X] T010 [P] [US4] MOD/NEW
  `packages/orchestrator/src/worker/__tests__/config.resolve-workflow-overrides.test.ts`:
  assert `ciWaitTimeoutMs` precedence — workflow value wins (`wf?.ciWaitTimeoutMs`), falls
  through to `config.ciWaitTimeoutMs` when unset. Depends on T002.

- [X] T011 [P] [US3] NEW
  `packages/orchestrator/src/worker/__tests__/config.resolve-review-like-agent.test.ts`:
  cover the agent-resolution matrix from data-model.md — tier undefined → full implement
  agent; `model` only → phase model + implement provider/effort; `provider`+`effort` →
  phase provider/effort + implement model; all three → phase. Assert `phase: 'remediate'`
  never inherits the `review` tier (Q3=A). Depends on T003.

- [X] T012 [P] [US1] NEW
  `packages/orchestrator/src/worker/__tests__/phase-loop.validate-command.test.ts` (SC-001):
  given `workflows.speckit-feature.validateCommand = "X"`, assert `"X"` reaches the validate
  spawn for a `speckit-feature` job (not the cluster default); assert the precedence chain
  (`workflows.<name>` → `settings` → `config`); assert `speckit-bugfix` still applies
  `resolveTargetedValidate` narrowing on top of the resolved command (FR-002). Depends on T004.

- [X] T013 [P] [US2] NEW
  `packages/orchestrator/src/worker/__tests__/phase-loop.prevalidate-command.test.ts` (SC-002):
  given `workflows.<name>.preValidateCommand = "Y"`, assert `"Y"` runs at the install step;
  given `= ""`, assert the install step is skipped (not fall back); given unset, assert
  repo/cluster fall-through. Depends on T005.

- [X] T014 [P] [US4] NEW/MOD
  `packages/orchestrator/src/worker/__tests__/phase-loop.ci-wait-timeout.test.ts` (SC-004):
  given `workflows.<name>.ciWaitTimeoutMs = N`, assert `N` is the value passed to
  `waitForCiGreen` for that workflow (precedence: workflow → cluster base). Depends on T006.

## Phase 4: Changeset

- [X] T015 NEW `.changeset/1160-config-keys-apply.md`: `@generacy-ai/config` **minor**
  (additive optional `ciWaitTimeoutMs` on the public `WorkflowOverride` type = new
  user-facing config surface) + `@generacy-ai/orchestrator` **patch** (internal call-site
  wiring + new non-exported `resolveReviewLikeAgent`; no public export change). Single file,
  both bumps. Required by the changeset CI gate (both packages have non-test `src/` diffs).

## Dependencies & Execution Order

**Cross-task dependencies**:
- T002 → T001 (resolver field needs the schema field).
- T006 → T002 (wiring reads the resolved `ciWaitTimeoutMs`).
- T007, T008 → T003 (executors call the new helper).
- T004, T005 depend on nothing new (they wire the already-shipped `resolveWorkflowOverrides`).
- Each Phase 3 test depends on its corresponding wiring/foundation task (noted per task).
- T015 (changeset) can be written any time; land it before opening/merging the PR.

**Parallel opportunities**:
- **Phase 1**: T003 (agent helper) is independent of T001→T002 (schema/resolver chain). If
  landed concurrently in `config.ts`, coordinate the single-file edit.
- **Phase 2**: T004 and T005 are fully independent of Phase 1 and of each other but share
  `phase-loop.ts` with T006 — coordinate concurrent edits to that file. T007 and T008 are
  in separate files and parallel with each other once T003 lands.
- **Phase 3**: all tests (T009–T014) touch distinct files and run in parallel once their
  respective foundation/wiring tasks are done.

**Suggested order**: T001 → T002 → T003 (Phase 1) → T004/T005/T006/T007/T008 (Phase 2) →
T009–T014 (Phase 3) → T015 (changeset).

**Next step**: `/speckit:implement` to begin execution.
