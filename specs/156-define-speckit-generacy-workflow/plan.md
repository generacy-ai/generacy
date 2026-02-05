# Implementation Plan: Define speckit as Generacy workflow actions

**Feature**: Create Generacy workflow actions that implement the speckit methodology
**Branch**: `156-define-speckit-generacy-workflow`
**Status**: Complete

## Summary

This plan implements speckit workflow actions in the Generacy workflow engine, enabling the specify → clarify → plan → tasks → implement development methodology to be used in `.generacy.yaml` workflow definitions.

The implementation follows **Option C: Hybrid approach** as determined in clarifications:
- **Library calls** for deterministic operations (`create_feature`, `get_paths`, `check_prereqs`, `copy_template`)
- **agent.invoke delegation** for AI-dependent operations (`specify`, `clarify`, `plan`, `tasks`, `implement`)

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript |
| Framework | Generacy workflow-engine |
| Package Manager | pnpm |
| Target Package | `packages/workflow-engine` |
| Test Framework | vitest |

### Dependencies

| Dependency | Purpose | Version |
|------------|---------|---------|
| `@modelcontextprotocol/sdk` | MCP client for tool invocation | existing |
| `simple-git` | Git operations | existing |
| `zod` | Input validation | existing |

## Architecture Overview

### Action Type Strategy

Following clarification Q3, we implement a **single dispatching action type** (`speckit`) that routes internally based on operation parameter. This keeps the ActionType union manageable while providing clear namespacing.

```typescript
// Single ActionType with operation routing
type ActionType =
  | ... existing types ...
  | 'speckit'

// Usage in YAML
uses: speckit.create_feature  # Parsed as type=speckit, operation=create_feature
uses: speckit.specify         # Parsed as type=speckit, operation=specify
```

### Gate Implementation

Following clarification Q2, we implement **gates as a new StepDefinition field** for cleaner YAML syntax:

```typescript
interface StepDefinition {
  // ... existing fields ...
  gate?: string;  // New field for review checkpoints
}
```

### Workflow Templates

Following clarification Q5, we provide **static YAML files** in `workflows/` that users copy and customize.

## Project Structure

```
packages/workflow-engine/
├── src/
│   ├── actions/
│   │   └── builtin/
│   │       └── speckit/
│   │           ├── index.ts              # SpecKitAction class & registration
│   │           ├── types.ts              # Input/output types for all operations
│   │           ├── operations/
│   │           │   ├── create-feature.ts # Deterministic: direct library call
│   │           │   ├── get-paths.ts      # Deterministic: direct library call
│   │           │   ├── check-prereqs.ts  # Deterministic: direct library call
│   │           │   ├── copy-template.ts  # Deterministic: direct library call
│   │           │   ├── specify.ts        # AI-dependent: agent.invoke
│   │           │   ├── clarify.ts        # AI-dependent: agent.invoke
│   │           │   ├── plan.ts           # AI-dependent: agent.invoke
│   │           │   ├── tasks.ts          # AI-dependent: agent.invoke
│   │           │   └── implement.ts      # AI-dependent: agent.invoke
│   │           └── lib/
│   │               ├── feature.ts        # Ported from speckit MCP
│   │               ├── paths.ts          # Ported from speckit MCP
│   │               ├── prereqs.ts        # Ported from speckit MCP
│   │               ├── templates.ts      # Ported from speckit MCP
│   │               └── fs.ts             # Shared filesystem utilities
│   ├── types/
│   │   └── action.ts                     # Add 'speckit' to ActionType
│   │   └── workflow.ts                   # Add 'gate' to StepDefinition
│   └── loader/
│       └── schema.ts                     # Add gate field validation

workflows/
├── speckit-feature.yaml       # Standard feature development
├── speckit-epic.yaml          # Epic with child issue creation
└── speckit-bugfix.yaml        # Simplified bug fix workflow
```

## Implementation Phases

### Phase 1: Core Infrastructure

1. **Update ActionType and StepDefinition**
   - Add `speckit` to ActionType union in `types/action.ts`
   - Update `parseActionType()` to handle `speckit.*` pattern
   - Add `gate?: string` to StepDefinition in `types/workflow.ts`
   - Update Zod schema in `loader/schema.ts`

2. **Create SpecKitAction base class**
   - Single action handler for all speckit operations
   - Internal dispatch based on operation parameter
   - Common error handling and logging

### Phase 2: Deterministic Operations

Port these operations from speckit MCP server (direct library calls):

1. **speckit.create_feature**
   - Input: `description`, `short_name?`, `number?`, `parent_epic_branch?`
   - Output: `branch_name`, `feature_num`, `spec_file`, `feature_dir`, `git_branch_created`
   - Port from: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/feature.ts`

2. **speckit.get_paths**
   - Input: `branch?`, `cwd?`
   - Output: `featureDir`, `specFile`, `planFile`, `tasksFile`, etc.
   - Port from: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/paths.ts`

3. **speckit.check_prereqs**
   - Input: `require_spec?`, `require_plan?`, `require_tasks?`
   - Output: `valid`, `featureDir`, `availableDocs[]`, `errors[]`
   - Port from: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/prereqs.ts`

4. **speckit.copy_template**
   - Input: `templates[]`, `feature_dir?`, `dest_filename?`
   - Output: `copied[]`, `skipped[]`
   - Port from: `/workspaces/claude-plugins/plugins/speckit/mcp-server/src/tools/templates.ts`

### Phase 3: AI-Dependent Operations

Implement via agent.invoke delegation:

1. **speckit.specify**
   - Compose prompt for spec generation
   - Delegate to agent.invoke with appropriate timeout
   - Output: `spec_file`, `summary`

2. **speckit.clarify**
   - Compose prompt for clarification question generation
   - Post questions to GitHub issue (via gh CLI)
   - Output: `questions_count`, `questions[]`

3. **speckit.plan**
   - Compose prompt for plan generation
   - Output: `plan_file`, `artifacts_created[]`

4. **speckit.tasks**
   - Compose prompt for task list generation
   - Output: `tasks_file`, `task_count`

5. **speckit.implement**
   - Compose prompt for task implementation
   - Track progress through task list
   - Output: `tasks_completed`, `files_modified[]`

### Phase 4: Workflow Templates

Create static YAML templates:

1. **speckit-feature.yaml** - Standard feature workflow
2. **speckit-epic.yaml** - Epic with child issues
3. **speckit-bugfix.yaml** - Simplified bugfix

### Phase 5: Gate Integration

1. **Update workflow executor**
   - Check for `gate` field after step execution
   - If gate present, pause for approval
   - Support configured gate handlers

## Key Technical Decisions

### Decision 1: Single ActionType with Internal Dispatch

**Rationale**: Keeps the ActionType union small (adds only 1 type vs 6+), follows plugin-style architecture, easier to add operations later.

**Implementation**:
```typescript
// In parseActionType()
if (actionString.startsWith('speckit.') || actionString.startsWith('speckit/')) {
  return 'speckit';
}

// In SpecKitAction
canHandle(step: StepDefinition): boolean {
  const actionType = parseActionType(step);
  return actionType === 'speckit';
}

protected async executeInternal(step: StepDefinition, context: ActionContext) {
  const operation = this.extractOperation(step); // e.g., 'create_feature'
  switch (operation) {
    case 'create_feature': return this.executeCreateFeature(step, context);
    case 'specify': return this.executeSpecify(step, context);
    // ... etc
  }
}
```

### Decision 2: Library Porting vs MCP Wrapping

**Rationale**: Porting deterministic logic directly is faster, more reliable, and doesn't require MCP server coordination. AI operations use agent.invoke because they need LLM capabilities.

### Decision 3: Gate as StepDefinition Field

**Rationale**: Cleaner YAML syntax, easier workflow authoring, integrates naturally with step execution flow.

## API Contracts

### speckit.create_feature

**Input**:
```typescript
interface CreateFeatureInput {
  description: string;      // Required: Feature description
  short_name?: string;      // Optional: Branch short name
  number?: number;          // Optional: Explicit feature number
  parent_epic_branch?: string; // Optional: Parent epic branch
}
```

**Output**:
```typescript
interface CreateFeatureOutput {
  branch_name: string;
  feature_num: string;
  spec_file: string;
  feature_dir: string;
  git_branch_created: boolean;
  branched_from_epic?: boolean;
}
```

### speckit.specify

**Input**:
```typescript
interface SpecifyInput {
  feature_dir: string;      // Required: Path to feature directory
  issue_url?: string;       // Optional: GitHub issue to extract context
  timeout?: number;         // Optional: Agent timeout (default: 300s)
}
```

**Output**:
```typescript
interface SpecifyOutput {
  spec_file: string;
  summary: string;
  user_stories_count: number;
}
```

### speckit.clarify

**Input**:
```typescript
interface ClarifyInput {
  feature_dir: string;
  issue_number?: number;    // Optional: Post questions to this issue
  timeout?: number;
}
```

**Output**:
```typescript
interface ClarifyOutput {
  questions_count: number;
  questions: Array<{
    topic: string;
    question: string;
    options?: string[];
  }>;
  posted_to_issue?: boolean;
}
```

### speckit.plan

**Input**:
```typescript
interface PlanInput {
  feature_dir: string;
  timeout?: number;
}
```

**Output**:
```typescript
interface PlanOutput {
  plan_file: string;
  artifacts_created: string[];
  technologies: string[];
}
```

### speckit.tasks

**Input**:
```typescript
interface TasksInput {
  feature_dir: string;
  timeout?: number;
}
```

**Output**:
```typescript
interface TasksOutput {
  tasks_file: string;
  task_count: number;
  phases: string[];
}
```

### speckit.implement

**Input**:
```typescript
interface ImplementInput {
  feature_dir: string;
  task_filter?: string;     // Optional: Pattern to filter tasks
  timeout?: number;
}
```

**Output**:
```typescript
interface ImplementOutput {
  tasks_completed: number;
  tasks_total: number;
  files_modified: string[];
  tests_passed?: boolean;
}
```

## Testing Strategy

### Unit Tests

- Test each operation handler in isolation
- Mock file system operations
- Validate input/output types

### Integration Tests

- Test full workflow execution with real files
- Test gate pausing behavior
- Test output passing between steps

### Test Files

```
packages/workflow-engine/
└── tests/
    └── actions/
        └── speckit/
            ├── create-feature.test.ts
            ├── get-paths.test.ts
            ├── specify.test.ts
            └── workflow-integration.test.ts
```

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Speckit logic changes upstream | Keep ported code minimal; document source mapping |
| Agent.invoke timeout issues | Configurable timeouts; retry logic |
| Git operations fail | Graceful degradation; clear error messages |
| Gate approval delays workflow | Non-blocking option; timeout with default action |

## Success Criteria

1. All 6 speckit operations work in workflow YAML
2. Gates pause execution for human approval
3. Step outputs accessible in subsequent steps
4. Workflow templates are complete and documented
5. Tests pass with >80% coverage
6. Works in both headless and VS Code environments

---

*Generated by speckit*
