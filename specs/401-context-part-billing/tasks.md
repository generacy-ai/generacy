# Tasks: Show 'waiting for slot' indicator on queued workflows

**Input**: Design documents from `/specs/401-context-part-billing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- **Repo**: Tasks span two repos — `generacy` (VS Code extension) and `generacy-cloud` (web dashboard)

## Phase 1: Org Capacity Data Layer

- [ ] T001 [US1] Add `OrgCapacity` type and `getOrgCapacity()` method to extension API (`packages/generacy-extension/src/api/endpoints/orgs.ts`) — return `{ activeExecutions, maxConcurrentAgents, isAtCapacity }` derived from org data
- [ ] T002 [P] [US1] Create `useOrgCapacity()` hook (`generacy-cloud/packages/web/src/lib/hooks/use-org-capacity.ts`) — poll `GET /orgs/{orgId}` every 15s, expose `{ isAtCapacity, activeExecutions, maxConcurrentAgents }`, handle unlimited tier (`maxConcurrentAgents === -1`)

## Phase 2: VS Code Extension Views

- [ ] T003 [US1] Update `QueueTreeProvider` (`packages/generacy-extension/src/views/cloud/queue/provider.ts`) — fetch org capacity alongside queue data in `refresh()`, store as `this.orgCapacity`, pass to tree items
- [ ] T004 [US1] Update `QueueTreeItem` (`packages/generacy-extension/src/views/cloud/queue/tree-item.ts`) — when item is `pending` and org at capacity: use distinct icon (`$(watch)` amber), prepend "waiting for slot" to description, add "Execution Slots: X/Y in use" to tooltip
- [ ] T005 [US1] Update detail HTML (`packages/generacy-extension/src/views/cloud/queue/detail-html.ts`) — show "Queued — waiting for execution slot" status and "X/Y execution slots in use" capacity section when item is slot-waiting

## Phase 3: Cloud Web Dashboard Views

- [ ] T006 [US1] Update `QueuePanel` (`generacy-cloud/packages/web/src/components/projects/detail/dashboard/QueuePanel.tsx`) — consume `useOrgCapacity()`, show "Waiting for slot" text + amber badge styling on pending items when at capacity
- [ ] T007 [P] [US1] Update `ActiveWorkflowsPanel` (`generacy-cloud/packages/web/src/components/projects/detail/dashboard/ActiveWorkflowsPanel.tsx`) — add slot-waiting badge on pending workflow entries when at capacity
- [ ] T008 [P] [US1] Update `WorkflowJobCard` (`generacy-cloud/packages/web/src/components/projects/detail/workflows/WorkflowJobCard.tsx`) — add amber "Waiting for slot" badge alongside status badge for pending jobs when at capacity
- [ ] T009 [US1] Update `WorkflowJobDetail` (`generacy-cloud/packages/web/src/components/projects/detail/workflows/WorkflowJobDetail.tsx`) — show capacity breakdown ("X/Y execution slots in use") in detail view when slot-waiting

## Phase 4: Testing

- [ ] T010 [P] [US1] Add tree item tests (`packages/generacy-extension/src/views/cloud/queue/__tests__/tree-item.test.ts`) — test slot-waiting icon, description, and tooltip rendering; test normal pending unchanged; test unlimited tier (never slot-waiting)
- [ ] T011 [P] [US1] Add provider tests (`packages/generacy-extension/src/views/cloud/queue/__tests__/provider.test.ts`) — test capacity polling alongside queue refresh, test capacity passed to tree items, test graceful fallback when capacity data unavailable
- [ ] T012 [P] [US1] Add `useOrgCapacity` hook tests (`generacy-cloud/packages/web/src/lib/hooks/__tests__/use-org-capacity.test.ts`) — test polling interval, cleanup on unmount, unlimited tier handling, error/fallback behavior

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 & Phase 3 → Phase 4

**Within Phase 1**:
- T001 and T002 can run in parallel (`[P]`) — different repos, no shared code

**Within Phase 2** (sequential):
- T003 → T004 → T005 (provider feeds tree items, tree items inform detail view)

**Within Phase 3**:
- T006 first (establishes capacity hook consumption pattern)
- T007 and T008 can run in parallel after T006 (`[P]`)
- T009 after T006

**Within Phase 4**:
- T010, T011, T012 all run in parallel (`[P]`) — independent test files across repos

**Cross-repo note**: T001/T003-T005/T010-T011 target `generacy` repo. T002/T006-T009/T012 target `generacy-cloud` repo. These two groups can be developed in parallel by separate agents.
