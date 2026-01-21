# Tasks: Generacy VS Code Extension

**Input**: Design documents from `/specs/044-epic-generacy-vs-code/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete
**Mode**: Epic (coarse-grained task groups)

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Task group can run in parallel with other `[P]` groups in the same phase
- **[Story]**: Which user story this task group addresses

---

## Phase 1: Foundation & Project Setup
<!-- Phase boundary: Must complete before Phase 2 -->

### TG-001 [#46] [P] Extension Scaffolding & Build Configuration
**Scope**: 4-6 hours
**Files**: `packages/generacy-extension/package.json`, `packages/generacy-extension/tsconfig.json`, `packages/generacy-extension/.vscodeignore`, `packages/generacy-extension/esbuild.config.js`, `packages/generacy-extension/src/extension.ts`, `packages/generacy-extension/src/constants.ts`
**Tests**: `packages/generacy-extension/src/__tests__/extension.test.ts`

- [ ] Create `packages/generacy-extension` package with proper monorepo setup
- [ ] Configure `package.json` with extension manifest, commands, views, and activation events
- [ ] Set up TypeScript configuration extending workspace base
- [ ] Configure esbuild bundling for extension
- [ ] Implement extension entry point with activation/deactivation lifecycle
- [ ] Create constants file for extension-wide values
- [ ] Add `.vscodeignore` to exclude dev files from packaging
- [ ] Create basic extension activation test

---

### TG-002 [#47] [P] Shared Utilities & Infrastructure
**Scope**: 3-4 hours
**Files**: `packages/generacy-extension/src/utils/config.ts`, `packages/generacy-extension/src/utils/logger.ts`, `packages/generacy-extension/src/utils/errors.ts`
**Tests**: `packages/generacy-extension/src/utils/__tests__/`

- [ ] Implement configuration manager using VS Code settings API
- [ ] Create extension logger with output channel integration
- [ ] Build error handling utilities with user-friendly messages
- [ ] Add telemetry stub (opt-in, no actual tracking yet)

---

### TG-003 [#48] [P] YAML Schema & Validation Foundation
**Scope**: 4-5 hours
**Files**: `packages/generacy-extension/schemas/workflow.schema.json`, `packages/generacy-extension/src/language/schema.ts`, `packages/generacy-extension/src/language/validator.ts`
**Tests**: `packages/generacy-extension/src/language/__tests__/validator.test.ts`

- [ ] Create JSON Schema for workflow YAML files
- [ ] Implement schema loader that registers with YAML extension
- [ ] Build Zod-based runtime validator matching schema
- [ ] Create validation error formatter for diagnostics

---

## Phase 2: Local Mode - Workflow Explorer
<!-- Phase boundary: Complete Phase 1 before starting -->

### TG-004 [#49] Workflow Explorer Tree View
**Scope**: 5-7 hours
**Files**: `packages/generacy-extension/src/views/local/explorer/provider.ts`, `packages/generacy-extension/src/views/local/explorer/tree-item.ts`, `packages/generacy-extension/src/views/local/explorer/decorations.ts`, `packages/generacy-extension/src/providers/workflow-tree.ts`
**Tests**: `packages/generacy-extension/src/views/local/explorer/__tests__/`

- [ ] Implement `WorkflowTreeProvider` with file system watching
- [ ] Create tree item classes for workflows, phases, and steps
- [ ] Add file decorations for validation status (valid/invalid/unknown)
- [ ] Implement refresh and expand/collapse behavior
- [ ] Register tree view in extension activation
- [ ] Add context menu items for CRUD operations

---

### TG-005 [#50] [P] Workflow CRUD Commands
**Scope**: 3-4 hours
**Files**: `packages/generacy-extension/src/commands/workflow.ts`, `packages/generacy-extension/src/commands/index.ts`
**Tests**: `packages/generacy-extension/src/commands/__tests__/workflow.test.ts`

- [ ] Implement `generacy.createWorkflow` command with template selection
- [ ] Implement `generacy.renameWorkflow` command
- [ ] Implement `generacy.deleteWorkflow` command with confirmation
- [ ] Implement `generacy.duplicateWorkflow` command
- [ ] Create command registration module

---

### TG-006 [#51] [P] Template Library
**Scope**: 2-3 hours
**Files**: `packages/generacy-extension/resources/templates/`, `packages/generacy-extension/src/views/local/explorer/templates.ts`
**Tests**: Template validation in schema tests

- [ ] Create starter workflow templates (basic, multi-phase, with-triggers)
- [ ] Implement template selection quick pick UI
- [ ] Add template preview in selection dialog

---

## Phase 3: Local Mode - Editor Features
<!-- Phase boundary: Complete Phase 2 before starting -->

### TG-007 [#52] YAML IntelliSense & Diagnostics
**Scope**: 6-8 hours
**Files**: `packages/generacy-extension/src/views/local/editor/completion.ts`, `packages/generacy-extension/src/views/local/editor/diagnostics.ts`, `packages/generacy-extension/src/views/local/editor/hover.ts`, `packages/generacy-extension/src/language/formatter.ts`
**Tests**: `packages/generacy-extension/src/views/local/editor/__tests__/`

- [ ] Implement completion provider for workflow YAML
- [ ] Create diagnostic provider with real-time validation
- [ ] Build hover provider for documentation on hover
- [ ] Add variable/secret reference completions with `${{ }}` syntax
- [ ] Implement YAML formatter respecting workflow structure

---

### TG-008 [#53] [P] CodeLens & Quick Actions
**Scope**: 3-4 hours
**Files**: `packages/generacy-extension/src/views/local/editor/codelens.ts`
**Tests**: `packages/generacy-extension/src/views/local/editor/__tests__/codelens.test.ts`

- [ ] Add "Run Phase" CodeLens above each phase definition
- [ ] Add "Debug Step" CodeLens above each step
- [ ] Add "Validate" CodeLens at document top
- [ ] Implement quick fix code actions for common errors

---

## Phase 4: Local Mode - Runner
<!-- Phase boundary: Complete Phase 3 before starting -->

### TG-009 [#54] Local Workflow Executor
**Scope**: 6-8 hours
**Files**: `packages/generacy-extension/src/views/local/runner/executor.ts`, `packages/generacy-extension/src/views/local/runner/output-channel.ts`, `packages/generacy-extension/src/views/local/runner/terminal.ts`, `packages/generacy-extension/src/commands/runner.ts`
**Tests**: `packages/generacy-extension/src/views/local/runner/__tests__/`

- [ ] Implement workflow executor with phase/step iteration
- [ ] Create output channel for execution logs
- [ ] Build terminal integration for interactive commands
- [ ] Add environment variable configuration UI
- [ ] Implement dry-run mode that validates without executing
- [ ] Create run commands: `generacy.runWorkflow`, `generacy.runPhase`

---

### TG-010 [#55] [P] Execution Status UI
**Scope**: 2-3 hours
**Files**: `packages/generacy-extension/src/providers/status-bar.ts`
**Tests**: Integration tests with runner

- [ ] Implement status bar item showing current execution
- [ ] Add progress notification during execution
- [ ] Show execution summary on completion

---

## Phase 5: Local Mode - Debugger
<!-- Phase boundary: Complete Phase 4 before starting -->

### TG-011 [#56] Debug Adapter Protocol Implementation
**Scope**: 8-10 hours
**Files**: `packages/generacy-extension/src/debug/adapter.ts`, `packages/generacy-extension/src/debug/protocol.ts`, `packages/generacy-extension/src/debug/runtime.ts`, `packages/generacy-extension/src/debug/state.ts`
**Tests**: `packages/generacy-extension/src/debug/__tests__/`

- [ ] Implement Debug Adapter conforming to DAP specification
- [ ] Create protocol message handlers (initialize, launch, disconnect)
- [ ] Build workflow runtime with step-by-step execution
- [ ] Implement execution state tracking (variables, context, outputs)
- [ ] Register debug adapter factory in extension

---

### TG-012 [#57] Breakpoints & Stepping
**Scope**: 4-5 hours
**Files**: `packages/generacy-extension/src/views/local/debugger/breakpoints.ts`, `packages/generacy-extension/src/views/local/debugger/session.ts`, `packages/generacy-extension/src/views/local/debugger/adapter.ts`
**Tests**: `packages/generacy-extension/src/views/local/debugger/__tests__/`

- [ ] Implement breakpoint support on phases and steps
- [ ] Add setBreakpoints DAP handler
- [ ] Implement continue, stepIn, stepOut, stepOver handlers
- [ ] Create pause/resume functionality
- [ ] Add conditional breakpoint support

---

### TG-013 [#58] [P] State Inspection & Replay
**Scope**: 4-5 hours
**Files**: Extensions to debug state and UI

- [ ] Implement variables view showing current execution state
- [ ] Add watch expressions support
- [ ] Create "replay from step" functionality
- [ ] Build execution history panel
- [ ] Add error analysis with stack trace

---

## Phase 6: Authentication & API Client
<!-- Phase boundary: Complete Phase 5 before starting -->

### TG-014 [#59] API Client Foundation
**Scope**: 4-5 hours
**Files**: `packages/generacy-extension/src/api/client.ts`, `packages/generacy-extension/src/api/types.ts`
**Tests**: `packages/generacy-extension/src/api/__tests__/client.test.ts`

- [ ] Implement fetch-based HTTP client with error handling
- [ ] Create Zod schemas for all API response types
- [ ] Add request/response interceptors for auth headers
- [ ] Implement retry logic with exponential backoff
- [ ] Create API endpoint type definitions

---

### TG-015 [#60] GitHub OAuth Authentication
**Scope**: 5-6 hours
**Files**: `packages/generacy-extension/src/api/auth.ts`, `packages/generacy-extension/src/commands/cloud.ts`
**Tests**: `packages/generacy-extension/src/api/__tests__/auth.test.ts`

- [ ] Implement GitHub OAuth flow via VS Code URI handler
- [ ] Create SecretStorage integration for token persistence
- [ ] Build authentication state management
- [ ] Add login/logout commands
- [ ] Implement progressive authentication (anonymous → free → org)
- [ ] Handle token refresh and expiration

---

## Phase 7: Cloud Mode - Dashboard
<!-- Phase boundary: Complete Phase 6 before starting -->

### TG-016 [#61] Organization Dashboard Webview
**Scope**: 6-8 hours
**Files**: `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`, `packages/generacy-extension/src/views/cloud/dashboard/panel.ts`, `packages/generacy-extension/src/api/endpoints/orgs.ts`
**Tests**: `packages/generacy-extension/src/views/cloud/dashboard/__tests__/`

- [ ] Create webview panel for organization dashboard
- [ ] Implement organization overview section (name, tier, limits)
- [ ] Build member list with role display
- [ ] Add usage metrics visualization (agent hours, concurrent agents)
- [ ] Create billing summary section with upgrade CTAs
- [ ] Implement webview message passing for data updates

---

## Phase 8: Cloud Mode - Workflow Queue
<!-- Phase boundary: Complete Phase 7 before starting -->

### TG-017 [#62] Queue Tree View
**Scope**: 5-6 hours
**Files**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`, `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`, `packages/generacy-extension/src/providers/queue-tree.ts`, `packages/generacy-extension/src/api/endpoints/queue.ts`
**Tests**: `packages/generacy-extension/src/views/cloud/queue/__tests__/`

- [ ] Implement `QueueTreeProvider` with API polling
- [ ] Create tree items for queue entries with status icons
- [ ] Add filtering by status (pending, running, completed, failed)
- [ ] Add filtering by repository and assignee
- [ ] Implement real-time status updates via polling

---

### TG-018 [#63] [P] Queue Actions
**Scope**: 3-4 hours
**Files**: `packages/generacy-extension/src/views/cloud/queue/actions.ts`
**Tests**: Integration tests with queue provider

- [ ] Implement cancel action with confirmation
- [ ] Implement retry action for failed items
- [ ] Add priority adjustment (up/down)
- [ ] Create "View Details" action showing full queue item info

---

## Phase 9: Cloud Mode - Integrations
<!-- Phase boundary: Complete Phase 8 before starting -->

### TG-019 [#64] Integration Management
**Scope**: 5-6 hours
**Files**: `packages/generacy-extension/src/views/cloud/integrations/github.ts`, `packages/generacy-extension/src/views/cloud/integrations/status.ts`, `packages/generacy-extension/src/views/cloud/integrations/config.ts`, `packages/generacy-extension/src/api/endpoints/integrations.ts`
**Tests**: `packages/generacy-extension/src/views/cloud/integrations/__tests__/`

- [ ] Create integrations tree view showing connection status
- [ ] Implement GitHub App connection status display
- [ ] Add "Connect" action for disconnected integrations
- [ ] Build integration configuration panel
- [ ] Add webhook configuration UI

---

## Phase 10: Cloud Mode - Publishing
<!-- Phase boundary: Complete Phase 9 before starting -->

### TG-020 [#65] Workflow Publishing
**Scope**: 6-8 hours
**Files**: `packages/generacy-extension/src/views/cloud/publish/sync.ts`, `packages/generacy-extension/src/views/cloud/publish/compare.ts`, `packages/generacy-extension/src/views/cloud/publish/version.ts`, `packages/generacy-extension/src/api/endpoints/workflows.ts`
**Tests**: `packages/generacy-extension/src/views/cloud/publish/__tests__/`

- [ ] Implement `generacy.publishWorkflow` command
- [ ] Create diff comparison view (local vs cloud)
- [ ] Build version history panel
- [ ] Add rollback to previous version functionality
- [ ] Implement sync status indicators in explorer
- [ ] Create publish confirmation with changelog prompt

---

## Phase 11: Polish & Marketplace
<!-- Phase boundary: Complete Phase 10 before starting -->

### TG-021 [#66] Error Handling & UX Polish
**Scope**: 4-5 hours
**Files**: Enhancements across all modules
**Tests**: Error scenario tests

- [ ] Add comprehensive error messages for all failure modes
- [ ] Implement offline mode handling for cloud features
- [ ] Create welcome walkthrough for first-time users
- [ ] Add keyboard shortcuts for common actions
- [ ] Improve loading states and progress indicators

---

### TG-022 [#67] [P] Documentation & Marketplace Assets
**Scope**: 3-4 hours
**Files**: `packages/generacy-extension/README.md`, `packages/generacy-extension/CHANGELOG.md`, `packages/generacy-extension/resources/`
**Tests**: N/A

- [ ] Write comprehensive README for marketplace
- [ ] Create screenshots and GIFs for marketplace listing
- [ ] Design extension icon and banner
- [ ] Write CHANGELOG for initial release

---

### TG-023 [#68] [P] Marketplace Publishing
**Scope**: 2-3 hours
**Files**: `packages/generacy-extension/.vscode/launch.json`, CI/CD configuration
**Tests**: Extension packaging tests

- [ ] Configure `vsce` for packaging
- [ ] Set up CI/CD pipeline for automated publishing
- [ ] Test extension in clean VS Code instance
- [ ] Publish to VS Code Marketplace

---

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8 → Phase 9 → Phase 10 → Phase 11

**Parallel opportunities within phases**:
- **Phase 1**: TG-001, TG-002, TG-003 can run in parallel (foundational setup)
- **Phase 2**: TG-005 and TG-006 can run in parallel after TG-004 starts
- **Phase 3**: TG-008 can run in parallel with TG-007
- **Phase 4**: TG-010 can run in parallel with TG-009
- **Phase 5**: TG-013 can run in parallel with TG-012 (after TG-011)
- **Phase 8**: TG-018 can run in parallel with TG-017
- **Phase 11**: TG-022 and TG-023 can run in parallel with TG-021

**Critical path**:
TG-001 → TG-004 → TG-007 → TG-009 → TG-011 → TG-014 → TG-015 → TG-016 → TG-017 → TG-019 → TG-020 → TG-021 → TG-023

**Cross-phase dependencies**:
- TG-007 (IntelliSense) requires TG-003 (YAML Schema)
- TG-009 (Runner) requires TG-004 (Explorer) for workflow selection
- TG-011 (Debugger) requires TG-009 (Runner) as foundation
- TG-016+ (Cloud features) require TG-015 (Authentication)

---

*Generated by speckit*
