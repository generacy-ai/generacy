# Tasks: GitHub Actions Plugin

**Input**: Design documents from `/specs/016-plugin-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Project Setup

- [ ] T001 Create package directory structure `packages/github-actions/`
- [ ] T002 [P] Create `package.json` with dependencies (@octokit/rest, @octokit/types, zod)
- [ ] T003 [P] Create `tsconfig.json` extending workspace config
- [ ] T004 [P] Create `vitest.config.ts` for test runner

---

## Phase 2: Core Types & Configuration

- [ ] T010 [US1] Create `src/types/config.ts` with GitHubActionsConfig interface and Zod schema
- [ ] T011 [P] [US2] Create `src/types/workflows.ts` with WorkflowRun, WorkflowStatus, WorkflowConclusion types
- [ ] T012 [P] [US2] Create `src/types/jobs.ts` with Job, Step, JobStatus, StepStatus types
- [ ] T013 [P] [US2] Create `src/types/artifacts.ts` with Artifact type
- [ ] T014 [P] [US2] Create `src/types/check-runs.ts` with CheckRun, CheckOutput, CheckAnnotation types
- [ ] T015 [P] [US2] Create `src/types/events.ts` with WorkflowCompletedEvent, WorkflowFailedEvent, CheckRunCompletedEvent types
- [ ] T016 Create `src/types/index.ts` barrel export for all types
- [ ] T017 Create `src/utils/errors.ts` with custom error classes (GitHubActionsError, RateLimitError, WorkflowNotFoundError)
- [ ] T018 [P] Create `src/utils/validation.ts` with input validation helpers

---

## Phase 3: GitHub API Client

- [ ] T020 Create `src/client.ts` with GitHubClient wrapper using @octokit/rest
- [ ] T021 Write tests `__tests__/client.test.ts` for client initialization and error handling

---

## Phase 4: Operations Layer

- [ ] T030 [US1] Create `src/operations/workflows.ts` with triggerWorkflow, triggerWorkflowDispatch
- [ ] T031 [US1] Write tests `__tests__/operations/workflows.test.ts`
- [ ] T032 [P] [US2] Create `src/operations/runs.ts` with getWorkflowRun, listWorkflowRuns, cancelWorkflowRun, rerunWorkflowRun
- [ ] T033 [P] [US2] Write tests `__tests__/operations/runs.test.ts`
- [ ] T034 [P] [US2] Create `src/operations/jobs.ts` with getJobs, getJobLogs
- [ ] T035 [P] [US2] Write tests `__tests__/operations/jobs.test.ts`
- [ ] T036 [P] [US2] Create `src/operations/artifacts.ts` with listArtifacts, downloadArtifact
- [ ] T037 [P] [US2] Write tests `__tests__/operations/artifacts.test.ts`
- [ ] T038 [US2] Create `src/operations/check-runs.ts` with createCheckRun, updateCheckRun
- [ ] T039 [US2] Write tests `__tests__/operations/check-runs.test.ts`

---

## Phase 5: Polling Infrastructure

- [ ] T040 [US2] Create `src/polling/types.ts` with PollingConfig interface
- [ ] T041 [US2] Create `src/polling/status-poller.ts` with StatusPoller class (poll loop, exponential backoff, terminal state detection)
- [ ] T042 [US2] Write tests `__tests__/polling/status-poller.test.ts`

---

## Phase 6: Event Emission

- [ ] T050 [US2] [US3] Create `src/events/types.ts` with EventBus interface definition (facet contract)
- [ ] T051 [US2] [US3] Create `src/events/emitter.ts` with event emission logic integrating with EventBus facet
- [ ] T052 [US2] [US3] Write tests `__tests__/events/emitter.test.ts`

---

## Phase 7: Plugin Assembly

- [ ] T060 Create `src/plugin.ts` with GitHubActionsPlugin class combining all operations
- [ ] T061 Create plugin manifest with facet declarations (provides: GitHubActions, requires: EventBus, optional: IssueTracker)
- [ ] T062 Write tests `__tests__/plugin.test.ts` for plugin initialization and facet injection
- [ ] T063 Create `src/index.ts` with public exports

---

## Phase 8: Integration & Polish

- [ ] T070 [US3] Add optional IssueTracker facet integration in plugin.ts (comment on issues when workflows complete)
- [ ] T071 [US3] Write tests for IssueTracker integration
- [ ] T072 Add JSDoc documentation to all public exports
- [ ] T073 Update workspace `pnpm-workspace.yaml` to include new package
- [ ] T074 Run full test suite and fix any issues
- [ ] T075 Verify build succeeds with `pnpm build`

---

## Dependencies & Execution Order

### Sequential Dependencies
1. **Phase 1 → Phase 2**: Types depend on project structure
2. **Phase 2 → Phase 3**: Client depends on types and config
3. **Phase 3 → Phase 4**: Operations depend on client
4. **Phase 4 → Phase 5**: Polling uses operations for API calls
5. **Phase 5 → Phase 6**: Event emission triggered by poller
6. **Phase 4-6 → Phase 7**: Plugin assembles all components
7. **Phase 7 → Phase 8**: Integration after core complete

### Parallel Opportunities Within Phases
- **Phase 1**: T002, T003, T004 can run in parallel (after T001)
- **Phase 2**: T011-T015 can run in parallel, T017-T018 can run in parallel
- **Phase 4**: T032-T037 pairs can run in parallel (runs, jobs, artifacts)
- **Phase 5-6**: Can run in parallel once Phase 4 is complete

### Critical Path
T001 → T010 → T020 → T030 → T041 → T060 → T074

### Estimated Task Count by User Story
- **US1 (Trigger Workflow)**: T010, T030, T031 (3 tasks)
- **US2 (Monitor Status)**: T011-T015, T032-T042, T050-T052, T060-T062 (18 tasks)
- **US3 (Issue Integration)**: T050-T052, T070-T071 (5 tasks)
- **Setup/Infrastructure**: T001-T004, T016-T018, T020-T021, T063, T072-T075 (14 tasks)
