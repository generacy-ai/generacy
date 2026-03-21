# Tasks: Display Execution Slot and Cluster Usage in Cloud Dashboard

**Input**: Design documents from `/specs/400-context-part-billing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## User Stories
- **US1**: View execution slot usage (renamed from concurrent agents)
- **US2**: View cluster connection usage (new metric)
- **US3**: See upgrade prompts when at capacity

## Phase 1: Type & Data Layer Updates

- [ ] T001 [P] [US1] Add `activeExecutions` optional field to `OrgUsage` interface and `OrgUsageSchema` in `packages/generacy-extension/src/api/types.ts`
- [ ] T002 [P] [US2] Add `connectedClusters` optional field to `OrgUsage` interface and `OrgUsageSchema` in `packages/generacy-extension/src/api/types.ts`
- [ ] T003 [US1] Rename `concurrentAgents` → `executionSlots` in `getTierLimits()` return type and all three tier cases in `packages/generacy-extension/src/api/endpoints/orgs.ts`
- [ ] T004 [US2] Add `maxClusters` to `getTierLimits()` return type and switch cases (starter: 1, team: 3, enterprise: -1) in `packages/generacy-extension/src/api/endpoints/orgs.ts`

## Phase 2: Dashboard UI Updates — Overview Section

- [ ] T005 [US1] Rename "Concurrent Agents" label → "Execution Slots" in `getOverviewSection()` and update `tierLimits.concurrentAgents` → `tierLimits.executionSlots` in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts` (line ~104)
- [ ] T006 [US2] Add "Clusters" stat item to `getOverviewSection()` showing `connectedClusters` / `maxClusters` in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`

## Phase 3: Dashboard UI Updates — Usage Section

- [ ] T007 [US1] Rename "Concurrent Agents" progress bar → "Execution Slots" in `getUsageSection()` and update variable names from `concurrentPercent` → `executionSlotPercent` in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts` (line ~131–162)
- [ ] T008 [US1] Add threshold classes (warning/critical) to execution slots progress bar — currently only agent hours has them. Use `activeExecutions ?? currentConcurrentAgents` as the current value and `tierLimits.executionSlots` as the limit in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`
- [ ] T009 [US1] Add overage state for execution slots: when `activeExecutions > limit`, show bar at 100% with `critical` class and text "X of Y slots active — Z completing from prior plan" in `getUsageSection()`
- [ ] T010 [US2] Add new "Cluster Connections" progress bar in `getUsageSection()` with threshold classes (normal/warning/critical) using `connectedClusters` (fallback 0) and `tierLimits.maxClusters` in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`
- [ ] T011 [US2] Add overage state for cluster connections: same pattern as T009, "X of Y clusters connected — Z completing from prior plan" in `getUsageSection()`

## Phase 4: Upgrade Prompts & Styling

- [ ] T012 [US3] Add inline upgrade prompt below execution slots bar when at capacity: "All execution slots in use. Upgrade your plan for more concurrent workflows." with link to upgrade flow in `getUsageSection()`
- [ ] T013 [US3] Add inline upgrade prompt below cluster connections bar when at cluster limit: "Cluster limit reached. Upgrade to connect additional clusters." with link to upgrade flow in `getUsageSection()`
- [ ] T014 [US3] Add `.usage-upgrade-prompt` CSS class in `getStyles()` for capacity-specific upgrade prompts in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`

## Phase 5: Update Call Sites & Compile Check

- [ ] T015 Update `getDashboardHtml()` to pass `usage` data to `getOverviewSection()` (needed for `connectedClusters` display) in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts` (line ~41)
- [ ] T016 Run TypeScript compile check (`pnpm tsc --noEmit`) to verify no type errors from the `concurrentAgents` → `executionSlots` rename across all call sites

## Dependencies & Execution Order

**Sequential phase dependencies:**
- Phase 1 (T001–T004) must complete before Phase 2+ (types must exist before UI uses them)
- Phase 2 (T005–T006) and Phase 3 (T007–T011) can begin after Phase 1
- Phase 4 (T012–T014) can run after Phase 3 (prompts sit below progress bars)
- Phase 5 (T015–T016) runs last to validate everything compiles

**Parallel opportunities within phases:**
- T001 + T002: Independent field additions to the same interface (can be done together)
- T003 + T004: Both modify `getTierLimits()` but different parts (best done sequentially to avoid conflicts)
- T005 + T006: Different stat items in the same function
- T007–T009 (execution slots) and T010–T011 (clusters) can be interleaved but share the same function
- T012 + T013 + T014: Independent additions but all in the same file region

**Critical path:** T001/T002 → T003/T004 → T007/T008 → T009 → T012 → T015 → T016
