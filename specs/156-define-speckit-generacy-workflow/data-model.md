# Data Model: Speckit Workflow Actions

## Core Entities

### SpecKitOperation

The operation identifier extracted from step action string.

```typescript
type SpecKitOperation =
  | 'create_feature'
  | 'get_paths'
  | 'check_prereqs'
  | 'copy_template'
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'implement';
```

### FeaturePaths

Path configuration for a feature directory, returned by get_paths.

```typescript
interface FeaturePaths {
  repoRoot: string;
  branch: string;
  hasGit: boolean;
  featureDir: string;
  specFile: string;
  planFile: string;
  tasksFile: string;
  researchFile: string;
  dataModelFile: string;
  quickstartFile: string;
  contractsDir: string;
  checklistsDir: string;
  clarificationsFile: string;
}
```

## Input Types

### CreateFeatureInput

```typescript
interface CreateFeatureInput {
  /** Feature description used to generate spec content */
  description: string;

  /** Optional 2-4 word short name for the branch */
  short_name?: string;

  /** Optional explicit branch number (1-999) */
  number?: number;

  /** Parent epic branch to branch from (for epic children) */
  parent_epic_branch?: string;

  /** Working directory */
  cwd?: string;
}
```

### GetPathsInput

```typescript
interface GetPathsInput {
  /** Optional branch/feature name. Auto-detected if not provided. */
  branch?: string;

  /** Working directory */
  cwd?: string;
}
```

### CheckPrereqsInput

```typescript
interface CheckPrereqsInput {
  /** Branch/feature name. Auto-detected if not provided. */
  branch?: string;

  /** Whether spec.md is required (default: true) */
  require_spec?: boolean;

  /** Whether plan.md is required (default: false) */
  require_plan?: boolean;

  /** Whether tasks.md is required (default: false) */
  require_tasks?: boolean;

  /** Include tasks.md in available_docs if it exists */
  include_tasks?: boolean;

  /** Working directory */
  cwd?: string;
}
```

### CopyTemplateInput

```typescript
type TemplateName = 'spec' | 'plan' | 'tasks' | 'checklist' | 'agent-file';

interface CopyTemplateInput {
  /** List of template names to copy */
  templates: TemplateName[];

  /** Target feature directory. Auto-detected if not provided. */
  feature_dir?: string;

  /** Optional custom destination filename (single template only) */
  dest_filename?: string;

  /** Working directory */
  cwd?: string;
}
```

### SpecifyInput

```typescript
interface SpecifyInput {
  /** Path to feature directory */
  feature_dir: string;

  /** GitHub issue URL to extract context from */
  issue_url?: string;

  /** Agent timeout in seconds (default: 300) */
  timeout?: number;
}
```

### ClarifyInput

```typescript
interface ClarifyInput {
  /** Path to feature directory */
  feature_dir: string;

  /** GitHub issue number to post questions to */
  issue_number?: number;

  /** Agent timeout in seconds (default: 300) */
  timeout?: number;
}
```

### PlanInput

```typescript
interface PlanInput {
  /** Path to feature directory */
  feature_dir: string;

  /** Agent timeout in seconds (default: 600) */
  timeout?: number;
}
```

### TasksInput

```typescript
interface TasksInput {
  /** Path to feature directory */
  feature_dir: string;

  /** Agent timeout in seconds (default: 300) */
  timeout?: number;
}
```

### ImplementInput

```typescript
interface ImplementInput {
  /** Path to feature directory */
  feature_dir: string;

  /** Pattern to filter specific tasks */
  task_filter?: string;

  /** Agent timeout in seconds per task (default: 600) */
  timeout?: number;
}
```

## Output Types

### CreateFeatureOutput

```typescript
interface CreateFeatureOutput {
  success: boolean;
  branch_name: string;
  feature_num: string;
  spec_file: string;
  feature_dir: string;
  git_branch_created: boolean;
  branched_from_epic?: boolean;
  parent_epic_branch?: string;
}
```

### GetPathsOutput

```typescript
interface GetPathsOutput {
  success: boolean;
  exists: boolean;
  repoRoot: string;
  branch: string;
  hasGit: boolean;
  featureDir: string;
  specFile: string;
  planFile: string;
  tasksFile: string;
  researchFile: string;
  dataModelFile: string;
  quickstartFile: string;
  contractsDir: string;
  checklistsDir: string;
  clarificationsFile: string;
}
```

### CheckPrereqsOutput

```typescript
interface CheckPrereqsOutput {
  valid: boolean;
  featureDir: string;
  availableDocs: string[];
  errors?: string[];
}
```

### CopyTemplateOutput

```typescript
interface CopyTemplateOutput {
  success: boolean;
  copied: string[];
  skipped: string[];
  errors?: string[];
}
```

### SpecifyOutput

```typescript
interface SpecifyOutput {
  success: boolean;
  spec_file: string;
  summary: string;
  user_stories_count: number;
  functional_requirements_count: number;
}
```

### ClarifyOutput

```typescript
interface ClarificationQuestion {
  topic: string;
  context: string;
  question: string;
  options?: Array<{
    label: string;
    description: string;
  }>;
}

interface ClarifyOutput {
  success: boolean;
  questions_count: number;
  questions: ClarificationQuestion[];
  posted_to_issue?: boolean;
  clarifications_file: string;
}
```

### PlanOutput

```typescript
interface PlanOutput {
  success: boolean;
  plan_file: string;
  artifacts_created: string[];
  technologies: string[];
  phases_count: number;
}
```

### TasksOutput

```typescript
interface TasksOutput {
  success: boolean;
  tasks_file: string;
  task_count: number;
  phases: string[];
  estimated_complexity: 'simple' | 'moderate' | 'complex';
}
```

### ImplementOutput

```typescript
interface ImplementOutput {
  success: boolean;
  tasks_completed: number;
  tasks_total: number;
  tasks_skipped: number;
  files_modified: string[];
  tests_passed?: boolean;
  errors?: string[];
}
```

## Schema Extensions

### StepDefinition Extension

```typescript
// Extended StepDefinition with gate field
interface StepDefinition {
  name: string;
  uses?: string;
  action?: string;
  with?: Record<string, unknown>;
  command?: string;
  script?: string;
  timeout?: number;
  continueOnError?: boolean;
  condition?: string;
  env?: Record<string, string>;
  retry?: RetryConfig;

  /** NEW: Gate for review checkpoint */
  gate?: string;
}
```

### Gate Types

```typescript
type GateType =
  | 'spec-review'
  | 'clarification-review'
  | 'plan-review'
  | 'tasks-review'
  | 'implementation-review';

interface GateConfig {
  /** Gate identifier */
  type: GateType;

  /** Timeout before auto-action (optional, default: indefinite) */
  timeout_ms?: number;

  /** Action on timeout: 'approve' | 'reject' | 'block' */
  timeout_action?: 'approve' | 'reject' | 'block';

  /** Custom approval handler */
  handler?: GateHandler;
}

interface GateHandler {
  /** Check if gate is approved */
  checkApproval(context: GateContext): Promise<boolean>;

  /** Wait for approval with optional timeout */
  waitForApproval(context: GateContext): Promise<GateResult>;
}

interface GateContext {
  workflow: ExecutableWorkflow;
  phase: PhaseDefinition;
  step: StepDefinition;
  stepResult: ActionResult;
  gateType: string;
}

interface GateResult {
  approved: boolean;
  approvedBy?: string;
  comments?: string;
  timedOut?: boolean;
}
```

## Validation Rules

### Branch Name Pattern

```typescript
// Valid branch names
const FEATURE_NAME_PATTERN = /^(\d{1,3})[_-]([a-z0-9]+(?:-[a-z0-9]+)*)$/;

// Examples:
// ✓ 001-my-feature
// ✓ 42_user-auth
// ✗ feature-without-number
// ✗ 1000-too-many-digits
```

### Template Names

```typescript
// Valid template names
const VALID_TEMPLATES = ['spec', 'plan', 'tasks', 'checklist', 'agent-file'] as const;

// Validation
function validateTemplate(name: string): name is TemplateName {
  return VALID_TEMPLATES.includes(name as TemplateName);
}
```

### Input Validation Schema (Zod)

```typescript
import { z } from 'zod';

const CreateFeatureInputSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  short_name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid short name format')
    .optional(),
  number: z.number().int().min(1).max(999).optional(),
  parent_epic_branch: z.string().optional(),
  cwd: z.string().optional(),
});

const SpecifyInputSchema = z.object({
  feature_dir: z.string().min(1, 'Feature directory is required'),
  issue_url: z.string().url().optional(),
  timeout: z.number().positive().optional(),
});

// ... similar for other inputs
```

## Relationships

```
WorkflowDefinition
    └── PhaseDefinition[]
            └── StepDefinition[]
                    ├── uses: 'speckit.create_feature'
                    ├── with: CreateFeatureInput
                    ├── gate?: 'plan-review'
                    └── → ActionResult
                            └── output: CreateFeatureOutput

SpecKitAction
    ├── canHandle(step) → true if uses starts with 'speckit.'
    ├── extractOperation(step) → SpecKitOperation
    └── executeInternal(step, context)
            ├── Deterministic ops → lib/* functions
            └── AI ops → agent.invoke delegation

ExecutionContext
    └── stepOutputs: Map<stepId, StepOutput>
            └── output: CreateFeatureOutput | SpecifyOutput | ...
                    └── accessed via ${steps.stepId.output.field}
```

---

*Generated by speckit*
