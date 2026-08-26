# Tasks: Route-aware session invalidation + transition logging

**Input**: Design documents from `/specs/1199-context-claude-code-sessions/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/resolve-route-consumption.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

> **⚠ HARD-BLOCK (Q4→A)**: No implementation code lands until generacy#1198 (owner
> of the `resolveRoute` export in `@generacy-ai/generacy-plugin-claude-code`) merges
> to `develop`. Verified 2026-08-26: the export is still absent (only repo-wide
> match is cluster-relay's unrelated dispatcher helper). The implement phase must
> pause/requeue until #1198 lands. T001 gates every subsequent task.

## Phase 1: Prerequisite gate (blocking)

- [X] T001 [US1] Rebase `1199-context-claude-code-sessions` on `develop` and verify
      generacy#1198 has landed: confirm `resolveRoute` is a public export of
      `@generacy-ai/generacy-plugin-claude-code` (`packages/generacy-plugin-claude-code/src/index.ts`)
      with signature `resolveRoute(model?: string): 'subscription' | 'gateway'`.
      Also check whether #1198 exports a **named** route type — if so, bind trackers/fields
      to it instead of `ReturnType<typeof resolveRoute>` (data-model.md §Route). If the
      export is still absent, STOP and requeue — do not proceed to Phase 2.

## Phase 2: Core Implementation (phase-loop invalidation + logging)

<!-- All of Phase 2 depends on T001 (the resolveRoute export). -->

- [X] T002 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, import `resolveRoute`
      from `@generacy-ai/generacy-plugin-claude-code` and declare a new local tracker
      `let currentRoute: ReturnType<typeof resolveRoute> | undefined;` next to
      `currentProvider`/`currentModel` (`:331-336`). (FR-001, FR-005)

- [X] T003 [US1] In `phase-loop.ts`, after `resolveAgentForPhase` (`:771-775`), compute
      `const nextRoute = resolveRoute(nextModel);`. Insert a route-change block AFTER the
      existing provider-switch block (`:780-786`, unchanged) and BEFORE the
      model-transition block (`:788-803`, unchanged): when
      `currentRoute !== undefined && currentRoute !== nextRoute`, log
      `agent.route.transition` with `{phase, prevRoute: currentRoute, nextRoute, prevModel: currentModel, nextModel}`
      and set `currentSessionId = undefined`. `undefined → X` must initialize only (no
      line, no drop). (FR-002, FR-003; Q2→A both lines co-fire; Q3→A first-phase no-op)

- [X] T004 [US1] In `phase-loop.ts`, update the post-spawn tracker block (`:826-827`) to
      also set `currentRoute = nextRoute;` alongside `currentProvider`/`currentModel`, so
      spawn failures don't strand state. Verify the existing `agent.model.transition`
      line (`:793-803`) is unchanged (FR-004). (FR-001)

- [X] T005 [US2] In `packages/orchestrator/src/worker/types.ts`, add optional
      `route?: string` to `CliSpawnOptions` (typed `string`, not the union — the spawner
      logs it verbatim and never branches, keeping `types.ts` free of a plugin import).
      (FR-006, data-model.md §CliSpawnOptions extension)

- [X] T006 [US2] In `phase-loop.ts`, pass `route: nextRoute` in the `spawnPhase` options
      object (`:807-823`). Depends on T003 (`nextRoute`) and T005 (`CliSpawnOptions.route`).
      (FR-006)

- [X] T007 [US2] In `packages/orchestrator/src/worker/cli-spawner.ts`, add
      `route: options.route` to the payload of the existing "Spawning/Resuming Claude CLI
      session for phase" log (`:53-63`). No new event name; the `:453` 'Starting phase'
      line in phase-loop is untouched. Depends on T005. (FR-006, Q5→A)

## Phase 3: Direct-caller launch logs (FR-007)

<!-- Independent of each other; all depend on T001. Each computes route = resolveRoute(model)
     from its already-resolved model and adds it to the launch log. No session changes. -->

- [X] T008 [P] [US2] In `packages/orchestrator/src/worker/pr-feedback-handler.ts`
      (`:895-898`), compute `const route = resolveRoute(model)` and add `route` to the
      'Spawning Claude CLI for PR feedback' log payload. No launch-option change. (FR-007)

- [X] T009 [P] [US2] In `packages/orchestrator/src/worker/review-executor.ts`
      (`:241-244`), compute `const route = resolveRoute(model)` and add `route` to the
      'Spawning Claude CLI for review phase' log payload. No launch-option change. (FR-007)

- [X] T010 [P] [US2] In `packages/orchestrator/src/worker/remediate-executor.ts`
      (`:108-120`), compute `const route = resolveRoute(model)` and add `route` to the
      'Spawning Claude CLI for remediate phase' log payload. No launch-option change. (FR-007)

- [X] T011 [P] [US2] In `packages/orchestrator/src/worker/merge-conflict-handler.ts`
      `spawnAgentForConflict` (`:766-810` — **no pre-launch info line today**), compute
      `const route = resolveRoute(model)` and add a NEW
      `logger.info({ cwd, provider, model, effort, route }, 'MergeConflictHandler: spawning agent CLI for conflict resolution')`
      adjacent to the launch. No launch-option change. (FR-007)

## Phase 4: Tests

<!-- Depends on Phases 2-3. New suite uses the D-4 test seam: partial vi.mock of
     the plugin with a stubbed resolveRoute (default 'subscription'). -->

- [X] T012 [US1] Create `packages/orchestrator/src/worker/__tests__/phase-loop.route-transition.test.ts`.
      Partial-mock `@generacy-ai/generacy-plugin-claude-code` (real module + stubbed
      `resolveRoute`) and steer route per model. Cover:
      - **SC-001**: same provider, `claude-opus-4-8` → `openrouter/a/b`, route
        `subscription` → `gateway`: second spawn gets `resumeSessionId: undefined`;
        `agent.route.transition` logged with `{phase, prevRoute: 'subscription', nextRoute: 'gateway', prevModel, nextModel}`.
      - **SC-002**: `claude-opus-4-8` → `claude-sonnet-5`, both `subscription`: session
        kept (second spawn resumes), `agent.model.transition` logged, NO `agent.route.transition`.
      - **Q2→A**: provider A/`subscription` → provider B/`gateway`: provider-switch line
        AND `agent.route.transition` both logged; session dropped once.
      - **Q3→A**: first CLI phase (`currentRoute` undefined): no transition line, no drop.
      - **FR-006**: spawn-site log/options payload includes `route`.

- [ ] T013 [P] [US2] Update the four direct-caller test suites (pr-feedback-handler,
      review-executor, remediate-executor, merge-conflict-handler) to assert `route` is
      present in each launch log payload (and that the new merge-conflict line exists),
      and that launch options are unchanged. (FR-007)

- [ ] T014 [US1] Verify SC-003 regression: run the existing phase-loop suites under the
      default subscription-only `resolveRoute` mock; they must stay green with no extra
      transition lines. Adjust only spawn-log assertions that need the additive `route`
      field. (SC-003, FR-008)

## Phase 5: Changeset & Verification

- [ ] T015 [US1] Add `.changeset/1199-route-aware-session-invalidation.md`:
      `@generacy-ai/orchestrator` **patch** — internal session-invalidation wiring + log
      fields; no new public exports, no new label vocabulary; the plugin is not modified
      (no bump there). Single file. (CLAUDE.md changeset gate)

- [ ] T016 [US1] Run `pnpm -r build` and the full orchestrator test suite
      (`pnpm --filter @generacy-ai/orchestrator test`); both must be green. (SC-004)

## Dependencies & Execution Order

**Sequential gate**:
- T001 (prerequisite export verification) blocks **everything** in Phases 2–5. If #1198
  has not landed, STOP after T001 and requeue.

**Phase 2 (phase-loop core)** — mostly sequential (same file):
- T002 → T003 → T004 (all edit `phase-loop.ts`; order by dependency).
- T005 (`types.ts`) independent; T006 depends on T003 + T005; T007 depends on T005.

**Phase 3 (direct callers)** — T008, T009, T010, T011 are all `[P]` (different files,
no shared state, each depends only on T001).

**Phase 4 (tests)** — T012 depends on Phase 2; T013 `[P]` depends on Phase 3; T014
depends on Phases 2–3.

**Phase 5** — T015 anytime after code exists; T016 last (gates on all prior work).

**Parallel opportunities**:
- T008 / T009 / T010 / T011 concurrently.
- T005 concurrently with T002–T003 (different files) if coordinated before T006.
