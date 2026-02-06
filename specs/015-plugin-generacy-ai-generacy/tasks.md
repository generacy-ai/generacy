# Tasks: @generacy-ai/generacy-plugin-jira

**Input**: Design documents from `/specs/015-plugin-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Foundation

- [ ] T001 Create `packages/jira/package.json` with dependencies (jira.js, zod, vitest, typescript)
- [ ] T002 [P] Create `packages/jira/tsconfig.json` extending workspace config
- [ ] T003 [P] Create `packages/jira/src/types/config.ts` with JiraConfig interface and Zod schema
- [ ] T004 Create `packages/jira/src/types/issues.ts` with JiraIssue, IssueType, Priority, IssueRef interfaces
- [ ] T005 [P] Create `packages/jira/src/types/projects.ts` with Project, Board, ProjectRef interfaces
- [ ] T006 [P] Create `packages/jira/src/types/sprints.ts` with Sprint interface
- [ ] T007 [P] Create `packages/jira/src/types/workflows.ts` with JiraStatus, StatusCategory, Transition interfaces
- [ ] T008 [P] Create `packages/jira/src/types/custom-fields.ts` with CustomField, CustomFieldType, FieldSchema interfaces
- [ ] T009 [P] Create `packages/jira/src/types/events.ts` with AdfDocument, AdfNode, AdfMark types
- [ ] T010 Create `packages/jira/src/types/index.ts` re-exporting all type modules
- [ ] T011 Create `packages/jira/src/utils/errors.ts` with JiraPluginError hierarchy (Auth, RateLimit, NotFound, Validation, Transition, Connection)
- [ ] T012 Create `packages/jira/src/utils/validation.ts` with config validation using Zod schemas
- [ ] T013 Create `packages/jira/src/client.ts` with JiraClient class wrapping Version3Client
- [ ] T014 Create `packages/jira/test/fixtures/` with sample JSON responses (issue-story.json, issue-epic.json, search-results.json, transitions.json)
- [ ] T015 Create `packages/jira/test/client.test.ts` with unit tests for client initialization and error wrapping

---

## Phase 2: Core Operations

- [ ] T016 [CRUD] Create `packages/jira/src/operations/issues.ts` with createIssue, getIssue, updateIssue, deleteIssue functions
- [ ] T017 [CRUD] Create `packages/jira/src/utils/adf.ts` with textToAdf and ensureAdf conversion utilities
- [ ] T018 [Search] Create `packages/jira/src/operations/search.ts` with searchIssues async generator for JQL queries
- [ ] T019 [Search] Create `packages/jira/src/utils/jql-builder.ts` with JqlBuilder helper class
- [ ] T020 [Comments] Create `packages/jira/src/operations/comments.ts` with addComment (plain text + ADF), getComments functions
- [ ] T021 [Workflow] Create `packages/jira/src/operations/transitions.ts` with getTransitions, transitionIssue functions
- [ ] T022 Create `packages/jira/test/fixtures/webhook-issue-updated.json` with sample webhook payloads
- [ ] T023 Create `packages/jira/test/operations/issues.test.ts` with unit tests for issue CRUD operations
- [ ] T024 [P] Create `packages/jira/test/operations/search.test.ts` with unit tests for JQL search and pagination
- [ ] T025 [P] Create `packages/jira/test/operations/comments.test.ts` with unit tests for comment operations
- [ ] T026 [P] Create `packages/jira/test/operations/transitions.test.ts` with unit tests for workflow transitions

---

## Phase 3: Advanced Features

- [ ] T027 [CustomFields] Create `packages/jira/src/operations/custom-fields.ts` with getCustomFields, getCustomField, setCustomField functions
- [ ] T028 [Sprints] Create `packages/jira/src/operations/sprints.ts` with getActiveSprint, getSprintsForBoard, addIssueToSprint functions
- [ ] T029 Create `packages/jira/test/operations/custom-fields.test.ts` with unit tests for custom field operations
- [ ] T030 [P] Create `packages/jira/test/operations/sprints.test.ts` with unit tests for sprint operations

---

## Phase 4: Webhooks

- [ ] T031 Create `packages/jira/src/webhooks/types.ts` with JiraWebhookEvent, JiraEventType, Changelog, ChangelogItem interfaces
- [ ] T032 Create `packages/jira/src/webhooks/parser.ts` with parseWebhookPayload, extractChanges functions
- [ ] T033 Create `packages/jira/src/webhooks/handler.ts` with JiraWebhookHandler class for event routing
- [ ] T034 Create `packages/jira/src/webhooks/verify.ts` with optional signature/IP verification helper
- [ ] T035 Create `packages/jira/test/webhooks/handler.test.ts` with unit tests for webhook event parsing and handling

---

## Phase 5: Integration

- [ ] T036 Create `packages/jira/src/plugin.ts` with JiraPlugin facade class combining all operations
- [ ] T037 Create `packages/jira/src/index.ts` exporting public API (JiraPlugin, types, errors)
- [ ] T038 Create `packages/jira/test/plugin.test.ts` with integration tests for JiraPlugin facade
- [ ] T039 Update root `pnpm-workspace.yaml` to include packages/jira if not already present
- [ ] T040 Run `pnpm install` and verify build with `pnpm --filter @generacy-ai/generacy-plugin-jira build`
- [ ] T041 Run all tests with `pnpm --filter @generacy-ai/generacy-plugin-jira test`

---

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 must complete first (package.json creates the package)
- T003-T009 (type modules) depend on T002 (tsconfig)
- T010 (type index) depends on T003-T009
- T011-T012 (utils) depend on T003 (config types)
- T013 (client) depends on T011-T012 (errors, validation)
- Phase 2 tasks depend on T013 (client)
- Phase 3 tasks depend on Phase 2 completion
- Phase 4 can run in parallel with Phase 3 (webhooks are independent)
- Phase 5 requires Phase 2-4 completion

**Parallel opportunities**:
- T002, T005-T009 can run in parallel (independent type files)
- T023-T026 can run in parallel (independent test files)
- T029-T030 can run in parallel (independent test files)
- Phase 3 and Phase 4 can partially overlap (different concerns)

**Critical path**: T001 → T002 → T003 → T013 → T016 → T036 → T037
