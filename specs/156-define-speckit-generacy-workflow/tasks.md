# Tasks: Define speckit as Generacy workflow actions

**Input**: Design documents from `/specs/156-define-speckit-generacy-workflow/`
**Prerequisites**: plan.md (required), spec.md (required), research.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Core Infrastructure

### T001 Add 'speckit' to ActionType union
**File**: `packages/workflow-engine/src/types/action.ts`
- Add `'speckit'` to the ActionType union type
- Export any needed speckit-related type definitions

### T002 [P] Update parseActionType for speckit.* pattern
**File**: `packages/workflow-engine/src/types/action.ts`
- Modify `parseActionType()` to recognize `speckit.*` and `speckit/*` patterns
- Return `'speckit'` ActionType for any speckit-prefixed action string

### T003 [P] Add gate field to StepDefinition
**File**: `packages/workflow-engine/src/types/workflow.ts`
- Add optional `gate?: string` field to StepDefinition interface
- Document the field purpose with JSDoc comments

### T004 [P] Update Zod schema for gate field
**File**: `packages/workflow-engine/src/loader/schema.ts`
- Add `gate: z.string().optional()` to StepDefinitionSchema
- Ensure validation allows optional gate on any step

### T005 Create SpecKitAction base class structure
**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/index.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/types.ts`
- Create SpecKitAction class extending BaseAction
- Implement `canHandle()` to match speckit ActionType
- Implement `extractOperation()` helper to parse operation from step.uses
- Stub `executeInternal()` with switch dispatch pattern
- Define input/output TypeScript interfaces for all operations

---

## Phase 2: Deterministic Operations (Library Porting)

### T006 Port create_feature library logic
**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/create-feature.ts`
**Source**: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/feature.ts`
- Port `createFeature()` function from speckit MCP
- Remove MCP-specific response formatting
- Return typed `CreateFeatureOutput` directly
- Wire up operation handler in SpecKitAction

### T007 [P] Port get_paths library logic
**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/paths.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/get-paths.ts`
**Source**: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/paths.ts`
- Port path resolution logic
- Return typed `GetPathsOutput`
- Wire up operation handler

### T008 [P] Port check_prereqs library logic
**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/prereqs.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/check-prereqs.ts`
**Source**: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/prereqs.ts`
- Port prerequisite validation logic
- Return typed `CheckPrereqsOutput`
- Wire up operation handler

### T009 [P] Port copy_template library logic
**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/templates.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/copy-template.ts`
**Source**: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/templates.ts`
- Port template copying logic
- Return typed `CopyTemplateOutput`
- Wire up operation handler

### T010 Create shared filesystem utilities
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/fs.ts`
- Extract common filesystem operations used across operations
- Include path normalization, existence checks, directory creation
- Ensure consistent error handling

---

## Phase 3: AI-Dependent Operations (Agent Delegation)

### T011 Implement speckit.specify operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/specify.ts`
- Compose prompt for spec generation with feature context
- Call agent.invoke with appropriate timeout (default 300s)
- Parse agent result and return `SpecifyOutput`
- Handle agent errors gracefully

### T012 [P] Implement speckit.clarify operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`
- Compose prompt for clarification question generation
- Call agent.invoke to identify underspecified areas
- Return `ClarifyOutput` with questions array
- Support optional GitHub issue posting

### T013 [P] Implement speckit.plan operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts`
- Compose prompt for plan generation
- Include spec.md context in prompt
- Call agent.invoke with appropriate timeout
- Return `PlanOutput` with plan_file and artifacts

### T014 [P] Implement speckit.tasks operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks.ts`
- Compose prompt for task list generation
- Include spec.md and plan.md context
- Call agent.invoke
- Return `TasksOutput` with task count and phases

### T015 Implement speckit.implement operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`
- Compose prompt for task execution
- Include tasks.md and feature context
- Support task_filter for selective execution
- Track progress through task list
- Return `ImplementOutput` with completion stats

---

## Phase 4: Gate Integration

### T016 Update workflow executor for gate handling
**File**: `packages/workflow-engine/src/executor/step-executor.ts` (or equivalent)
- After step execution completes, check for `step.gate` field
- If gate present, call `handleGate()` method
- Implement gate pause mechanism
- Support gate timeout configuration (optional)

### T017 [P] Implement gate handler interface
**Files**:
- `packages/workflow-engine/src/types/gate.ts`
- `packages/workflow-engine/src/executor/gate-handler.ts`
- Define GateHandler interface with `waitForApproval()` method
- Implement default gate handler (blocks indefinitely)
- Allow custom gate handlers to be registered

---

## Phase 5: Workflow Templates

### T018 Create speckit-feature.yaml template
**File**: `workflows/speckit-feature.yaml`
- Standard feature development workflow
- Include all speckit operations in order: create_feature → specify → clarify → plan → tasks → implement
- Add appropriate gates after clarify, plan, tasks
- Document input parameters

### T019 [P] Create speckit-epic.yaml template
**File**: `workflows/speckit-epic.yaml`
- Epic with child issue creation workflow
- Include tasks_to_issues step after tasks
- Document epic-specific parameters
- Include iteration patterns for child issues

### T020 [P] Create speckit-bugfix.yaml template
**File**: `workflows/speckit-bugfix.yaml`
- Simplified bug fix workflow
- Skip clarify and plan phases
- Direct path: create_feature → specify → tasks → implement
- Fewer gates for faster iteration

---

## Phase 6: Testing

### T021 Write unit tests for SpecKitAction dispatch
**File**: `packages/workflow-engine/tests/actions/speckit/dispatch.test.ts`
- Test `canHandle()` returns true for speckit.* actions
- Test `extractOperation()` correctly parses operation names
- Test dispatch routes to correct handler

### T022 [P] Write unit tests for deterministic operations
**Files**:
- `packages/workflow-engine/tests/actions/speckit/create-feature.test.ts`
- `packages/workflow-engine/tests/actions/speckit/get-paths.test.ts`
- `packages/workflow-engine/tests/actions/speckit/check-prereqs.test.ts`
- `packages/workflow-engine/tests/actions/speckit/copy-template.test.ts`
- Mock filesystem operations
- Test input validation
- Test output structure

### T023 [P] Write unit tests for AI operations
**Files**:
- `packages/workflow-engine/tests/actions/speckit/specify.test.ts`
- `packages/workflow-engine/tests/actions/speckit/clarify.test.ts`
- `packages/workflow-engine/tests/actions/speckit/plan.test.ts`
- `packages/workflow-engine/tests/actions/speckit/tasks.test.ts`
- `packages/workflow-engine/tests/actions/speckit/implement.test.ts`
- Mock agent.invoke responses
- Test prompt composition
- Test error handling

### T024 Write integration test for full workflow
**File**: `packages/workflow-engine/tests/actions/speckit/workflow-integration.test.ts`
- Test speckit-feature.yaml execution end-to-end
- Use real files in test fixtures
- Verify output passing between steps
- Test gate pausing behavior

---

## Phase 7: Registration & Documentation

### T025 Register SpecKitAction in action registry
**File**: `packages/workflow-engine/src/actions/index.ts` (or action registry)
- Import SpecKitAction
- Register with action resolver
- Ensure speckit.* actions are properly resolved

### T026 Update README with speckit action documentation
**File**: `packages/workflow-engine/README.md` (or relevant docs)
- Document all speckit.* operations
- Include input/output specifications
- Provide example workflow YAML
- Document gate behavior

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Core Infrastructure) must complete before Phase 2/3
- Phase 2/3 (Operations) can run in parallel after Phase 1
- Phase 4 (Gates) depends on Phase 1
- Phase 5 (Templates) depends on Phase 2/3
- Phase 6 (Testing) depends on corresponding implementation phases
- Phase 7 (Registration) depends on all prior phases

**Parallel opportunities within phases**:
- T002, T003, T004 can run in parallel (different files)
- T007, T008, T009 can run in parallel (independent operations)
- T012, T013, T014 can run in parallel (independent operations)
- T018, T019, T020 can run in parallel (independent templates)
- T022, T023 can run in parallel (independent test files)

**Critical path**:
T001 → T005 → T006 → T011 → T015 → T016 → T025

---

*Generated by speckit*
