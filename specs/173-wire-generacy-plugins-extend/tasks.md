# Tasks: Wire Generacy Plugins to Extend Latency Base Classes

**Input**: Design documents from `/specs/173-wire-generacy-plugins-extend/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = plugin standardization)

---

## Phase 1: Setup & Validation

- [X] T001 Verify Latency packages exist in workspace (`@generacy-ai/latency-plugin-dev-agent`, `@generacy-ai/latency-plugin-ci-cd`, `@generacy-ai/latency-plugin-issue-tracker`)
- [X] T002 Run `pnpm install` to ensure workspace is in sync

---

## Phase 2: Dev Agent Plugins

### generacy-plugin-copilot

- [X] T010 [P] [US1] Add `"@generacy-ai/latency-plugin-dev-agent": "workspace:*"` to `packages/generacy-plugin-copilot/package.json`
- [X] T011 [P] [US1] Update `packages/generacy-plugin-copilot/src/plugin/copilot-plugin.ts` to extend `AbstractDevAgentPlugin`
- [X] T012 [P] [US1] Implement `doInvoke()` method in CopilotPlugin
- [X] T013 [P] [US1] Implement `doInvokeStream()` method in CopilotPlugin
- [X] T014 [P] [US1] Implement `doGetCapabilities()` method in CopilotPlugin
- [X] T015 [P] [US1] Remove redundant interface implementations from CopilotPlugin
- [X] T016 [US1] Run tests for generacy-plugin-copilot: `pnpm --filter @generacy-ai/generacy-plugin-copilot test`

### generacy-plugin-claude-code

- [X] T020 [P] [US1] Add `"@generacy-ai/latency-plugin-dev-agent": "workspace:*"` to `packages/generacy-plugin-claude-code/package.json`
- [X] T021 [P] [US1] Update `packages/generacy-plugin-claude-code/src/plugin/claude-code-plugin.ts` to extend `AbstractDevAgentPlugin`
- [X] T022 [P] [US1] Implement `doInvoke()` method in ClaudeCodePlugin
- [X] T023 [P] [US1] Implement `doInvokeStream()` method in ClaudeCodePlugin
- [X] T024 [P] [US1] Implement `doGetCapabilities()` method in ClaudeCodePlugin
- [X] T025 [P] [US1] Remove redundant interface implementations from ClaudeCodePlugin
- [X] T026 [US1] Run tests for generacy-plugin-claude-code: `pnpm --filter @generacy-ai/generacy-plugin-claude-code test`

---

## Phase 3: CI/CD Plugins

### generacy-plugin-cloud-build

- [X] T030 [P] [US1] Add `"@generacy-ai/latency-plugin-ci-cd": "workspace:*"` to `packages/generacy-plugin-cloud-build/package.json`
- [X] T031 [P] [US1] Update `packages/generacy-plugin-cloud-build/src/plugin.ts` to extend `AbstractCICDPlugin`
- [X] T032 [P] [US1] Implement `doTrigger()` method in CloudBuildPlugin
- [X] T033 [P] [US1] Implement `doGetStatus()` method in CloudBuildPlugin
- [X] T034 [P] [US1] Implement `doCancel()` method in CloudBuildPlugin
- [X] T035 [P] [US1] Implement `doListPipelines()` method in CloudBuildPlugin
- [X] T036 [P] [US1] Remove redundant interface implementations from CloudBuildPlugin
- [X] T037 [US1] Run tests for generacy-plugin-cloud-build: `pnpm --filter @generacy-ai/generacy-plugin-cloud-build test`

### github-actions

- [X] T040 [P] [US1] Add `"@generacy-ai/latency-plugin-ci-cd": "workspace:*"` to `packages/github-actions/package.json`
- [X] T041 [P] [US1] Update `packages/github-actions/src/plugin.ts` to extend `AbstractCICDPlugin`
- [X] T042 [P] [US1] Implement `doTrigger()` method in GitHubActionsPlugin
- [X] T043 [P] [US1] Implement `doGetStatus()` method in GitHubActionsPlugin
- [X] T044 [P] [US1] Implement `doCancel()` method in GitHubActionsPlugin
- [X] T045 [P] [US1] Implement `doListPipelines()` method in GitHubActionsPlugin
- [X] T046 [P] [US1] Remove local `IssueTracker` interface redefinition from `packages/github-actions/src/plugin.ts`
- [X] T047 [P] [US1] Remove redundant interface implementations from GitHubActionsPlugin
- [X] T048 [US1] Run tests for github-actions: `pnpm --filter @generacy-ai/generacy-plugin-github-actions test`

---

## Phase 4: Issue Tracker Plugins

### github-issues

- [X] T050 [P] [US1] Add `"@generacy-ai/latency-plugin-issue-tracker": "workspace:*"` to `packages/github-issues/package.json`
- [X] T051 [P] [US1] Update `packages/github-issues/src/plugin.ts` to extend `AbstractIssueTrackerPlugin`
- [X] T052 [P] [US1] Implement `fetchIssue()` method in GitHubIssuesPlugin
- [X] T053 [P] [US1] Implement `doCreateIssue()` method in GitHubIssuesPlugin
- [X] T054 [P] [US1] Implement `doUpdateIssue()` method in GitHubIssuesPlugin
- [X] T055 [P] [US1] Implement `doListIssues()` method in GitHubIssuesPlugin
- [X] T056 [P] [US1] Implement `doAddComment()` method in GitHubIssuesPlugin
- [X] T057 [P] [US1] Remove redundant interface implementations from GitHubIssuesPlugin
- [X] T058 [US1] Run tests for github-issues: `pnpm --filter @generacy-ai/generacy-plugin-github-issues test`

### jira

- [X] T060 [P] [US1] Add `"@generacy-ai/latency-plugin-issue-tracker": "workspace:*"` to `packages/jira/package.json`
- [X] T061 [P] [US1] Update `packages/jira/src/plugin.ts` to extend `AbstractIssueTrackerPlugin`
- [X] T062 [P] [US1] Implement `fetchIssue()` method in JiraPlugin
- [X] T063 [P] [US1] Implement `doCreateIssue()` method in JiraPlugin
- [X] T064 [P] [US1] Implement `doUpdateIssue()` method in JiraPlugin
- [X] T065 [P] [US1] Implement `doListIssues()` method in JiraPlugin
- [X] T066 [P] [US1] Implement `doAddComment()` method in JiraPlugin
- [X] T067 [P] [US1] Remove redundant interface implementations from JiraPlugin
- [X] T068 [US1] Run tests for jira: `pnpm --filter @generacy-ai/generacy-plugin-jira test`

---

## Phase 5: Integration & Verification

- [X] T070 Run `pnpm install` to link new workspace dependencies
- [X] T071 Run `pnpm build` for all affected packages
- [X] T072 Run full test suite: `pnpm test`
- [X] T073 Verify no local interface redefinitions remain (search for `interface IssueTracker` in generacy packages)
- [X] T074 Verify all plugins properly extend their base classes

---

## Dependencies & Execution Order

### Phase Dependencies
- **Phase 1** (Setup): Must complete before any plugin work
- **Phases 2-4** (Plugin refactoring): Can run in parallel after Phase 1
- **Phase 5** (Integration): Must wait for all plugin phases to complete

### Intra-Phase Dependencies
Within each plugin:
1. `package.json` update (T0x0) must precede class refactoring
2. Class declaration change (T0x1) must precede method implementations
3. Method implementations (T0x2-T0x6) can run in parallel
4. Interface cleanup (T0x7) can run after class changes
5. Tests (T0x8) must run last for each plugin

### Parallel Opportunities
- All 6 plugins can be refactored in parallel (Phases 2-4)
- Within each plugin, method implementations marked `[P]` can be parallelized
- `package.json` updates across plugins are independent
- Test runs should be sequential to avoid resource contention

### Estimated Task Count
- Setup: 2 tasks
- Dev Agent Plugins: 14 tasks (7 per plugin)
- CI/CD Plugins: 17 tasks (8-9 per plugin)
- Issue Tracker Plugins: 18 tasks (9 per plugin)
- Integration: 5 tasks
- **Total: 56 tasks**
