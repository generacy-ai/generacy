# Tasks: Dependency-Blocked Implement Pause

**Input**: Design documents from `/specs/1211-problem-clarify-phase-answer/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Workflow-Engine — Types, Labels & Client

- [ ] T001 [P] [US1] Add new labels to `packages/workflow-engine/src/actions/github/labels/label-definitions.ts`
  - `completed:dependencies` (color `0E8A16`)
  - `waiting-for:dependency-limit` (color `FBCA04`)
  - `completed:dependency-limit` (color `0E8A16`)
  - Place alongside the existing `waiting-for:dependencies` entry

- [ ] T002 [P] [US1] Add `IssueRefState` type to `packages/workflow-engine/src/types/github.ts`
  - Fields: `state`, `stateReason`, `isPullRequest`, `merged`
  - Per `data-model.md` §5

- [ ] T003 [US1] Add `getIssueRefState` to `GitHubClient` interface and implement in `GhCliGitHubClient`
  - `packages/workflow-engine/src/actions/github/client/interface.ts`: add method signature
  - `packages/workflow-engine/src/actions/github/client/gh-cli.ts`: implement via `gh api repos/{o}/{r}/issues/{n}` + follow-up `pulls/{n}` for `merged`
  - Per `research.md` D-7 and `contracts/sentinel-and-gate-protocol.md` §6

## Phase 2: Orchestrator — Sentinel Parsing & Types

- [ ] T004 [P] [US1] Parse `SPECKIT_IMPLEMENT_BLOCKED` sentinel in `packages/orchestrator/src/worker/output-capture.ts`
  - Add `SENTINEL_BLOCKED_PREFIX = 'SPECKIT_IMPLEMENT_BLOCKED: '` alongside `SENTINEL_PREFIX`
  - Mirror the `SPECKIT_IMPLEMENT_PARTIAL` parse branch byte-for-byte (per `research.md` D-1)
  - Last-wins, malformed-JSON warn+ignore, line still captured as text

- [ ] T005 [P] [US1] Extend `ImplementPartialResult` with `blocked_on?: string[]` in `packages/orchestrator/src/worker/types.ts`
  - Both sentinels may populate the same object (Q2=A)
  - Per `data-model.md` §2

- [ ] T006 [P] [US1] Create `packages/orchestrator/src/worker/dependency-block.ts`
  - Pure functions: `parseDependencyRefs()` (ref grammar per `data-model.md` §3)
  - Marker comment format/parse helpers (block, limit, error, re-arm per `contracts/dependency-block-comments.md`)
  - Cycle counting: `countDependencyBlockCycles()` — count of block comments newer than newest limit comment (per `research.md` D-4)
  - Comment builders: `buildBlockComment()`, `buildLimitComment()`, `buildReArmComment()`, `buildErrorComment()`

## Phase 3: Orchestrator — Phase Loop & Gate Wiring

- [ ] T007 [US1] Add gate entries to `packages/orchestrator/src/worker/phase-resolver.ts`
  - `GATE_MAPPING` += `'dependencies'` and `'dependency-limit'`, both `{ phase: 'implement', resumeFrom: 'implement' }`
  - Per `research.md` D-5 and `contracts/sentinel-and-gate-protocol.md` §3

- [ ] T008 [US1] Add `'dependency-limit'` to `DEFAULT_RESUME_RETAIN_SUFFIXES` in `packages/orchestrator/src/worker/label-manager.ts`
  - Per `research.md` D-5 (prevents resume from stripping the operator's grant)

- [ ] T009 [US1] Implement the blocked branch in `packages/orchestrator/src/worker/phase-loop.ts`
  - Insert after `result.success` check for implement, **before** the increment re-loop and no-progress guard
  - 7-step sequence per `contracts/sentinel-and-gate-protocol.md` §4:
    1. Parse/validate refs (zero valid → fall through to normal flow)
    2. WIP commit/push via `prManager.commitPushAndEnsurePr` (honor `pushRefused` abort)
    3. Cycle-cap check; at ≥3 → post limit comment + `onGateHit('implement', 'waiting-for:dependency-limit')` → return gate-hit
    4. Post block marker comment with canonical refs
    5. Defensively remove lingering `completed:dependencies`
    6. `onGateHit('implement', 'waiting-for:dependencies')`
    7. `return { completed: false, gateHit: true }`

## Phase 4: Orchestrator — Dependency Monitor

- [ ] T010 [US3] Create `packages/orchestrator/src/services/dependency-monitor-service.ts`
  - Clone structure from `ClarificationAnswerMonitorService` (per `research.md` D-10)
  - Poll cycle per `data-model.md` §8: list issues with `waiting-for:dependencies` → read newest block marker → `getIssueRefState` per ref → all closed ⇒ re-arm
  - Re-arm sequence per `contracts/sentinel-and-gate-protocol.md` §5
  - In-memory `refFailures` map for Q5=B escalation (per `research.md` D-8)
  - Post re-arm comment with ⚠ flags for not-planned/unmerged closes (Q3=C)

- [ ] T011 [US3] Wire `DependencyMonitorService` into `packages/orchestrator/src/server.ts`
  - Construct and start in full mode only (beside clarification monitor)
  - Per `research.md` D-10

## Phase 5: Cockpit

- [ ] T012 [US2] Add `waiting-for:dependencies` and `waiting-for:dependency-limit` to `WAITING_PIPELINE_ORDER` in `packages/cockpit/src/state/precedence.ts`
  - Place `waiting-for:dependency-limit` beside `remediation-limit`
  - Place `waiting-for:dependencies` in the appropriate position
  - Gate-vocabulary derivation auto-makes both advance-able once `completed:*` labels exist in `WORKFLOW_LABELS`

## Phase 6: Tests

- [ ] T013 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/output-capture.blocked-sentinel.test.ts`
  - Valid sentinel → `blocked_on` populated, last-wins, malformed-JSON warn+ignore, sentinel line still in output text
  - Coexistence with PARTIAL sentinel

- [ ] T014 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/dependency-block.test.ts`
  - Ref grammar matrix (canonical, `#N`, bare `N`, invalid, mixed)
  - Marker comment round-trip format/parse
  - Cycle counting with and without limit comments

- [ ] T015 [P] [US1] Create `packages/workflow-engine/tests/actions/github/gh-cli.issue-ref-state.test.ts`
  - `getIssueRefState` for open issue, closed issue (completed/not_planned), open PR, merged PR, closed-unmerged PR
  - Non-zero exit throws

- [ ] T016 [US1] Create `packages/orchestrator/src/worker/__tests__/phase-loop.dependency-block.test.ts`
  - SC-001: implement with blocked sentinel → `onGateHit('implement','waiting-for:dependencies')` called, no `failed:implement`, WIP commit precedes gate
  - SC-002: no sentinel + unchanged `tasks_remaining` → no-progress guard still fires (regression pin)
  - FR-013: third block cycle → `waiting-for:dependency-limit` + limit comment; post-grant cycle count resets
  - Blocked with no valid refs → falls through to normal flow
  - Coexistence with PARTIAL: blocked wins control flow, partial counts recorded

- [ ] T017 [US3] Create `packages/orchestrator/src/services/__tests__/dependency-monitor-service.test.ts`
  - SC-003: all refs closed → `completed:dependencies` applied, `enqueueIfAbsent` called within one poll tick
  - Partially closed → gate held
  - FR-014: 2 consecutive failures → quiet retry; 3rd → escalation comment posted once (marker-deduped), gate held
  - Q3=C: not-planned close / unmerged PR close → ⚠ flags in re-arm comment

- [ ] T018 [P] [US2] Extend cockpit precedence test in `packages/cockpit/src/__tests__/`
  - SC-004: `waiting-for:dependencies` and `waiting-for:dependency-limit` present in `WAITING_PIPELINE_ORDER`
  - Gate-vocabulary derivation: `dependencies` gate advance-able once `completed:dependencies` exists

## Phase 7: Changeset

- [ ] T019 Write `.changeset/1211-dependency-blocked-pause.md`
  - `@generacy-ai/workflow-engine` **minor** (new label vocabulary + new public client method `getIssueRefState`)
  - `@generacy-ai/orchestrator` **patch** (internal worker/monitor wiring, no new public exports)
  - `@generacy-ai/cockpit` **patch** (`WAITING_PIPELINE_ORDER` additions, no new exports)

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7

**Parallel opportunities within phases**:
- Phase 1: T001, T002 can run in parallel (different files, no dependencies)
- Phase 2: T004, T005, T006 can run in parallel (different files, no cross-dependencies)
- Phase 3: T007, T008 can run in parallel (different files); T009 depends on Phase 2 + T007 + T008
- Phase 4: T010 depends on Phase 1 (client method) + T006 (marker parsing); T011 depends on T010
- Phase 5: T012 is independent of orchestrator work (different package)
- Phase 6: T013, T014, T015 can run in parallel; T016 depends on Phase 3; T017 depends on Phase 4; T018 depends on Phase 5
- Phase 7: T019 depends on all other phases being complete

**Cross-phase dependencies**:
- Phase 3 (T009) requires Phase 2 (T004-T006) for sentinel types and dependency-block helpers
- Phase 4 (T010) requires Phase 1 (T003-T004) for `getIssueRefState` and Phase 2 (T006) for marker parsing
- Phase 5 (T012) is independent — can run anytime after Phase 1 (labels must exist for cockpit derivation)