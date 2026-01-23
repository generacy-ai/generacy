# Data Model: Workflow Step Execution Engine

## Core Entities

### ActionType (Enum)
```typescript
type ActionType =
  | 'workspace.prepare'   // Git branch operations
  | 'agent.invoke'        // Claude Code CLI invocation
  | 'verification.check'  // Test/lint execution
  | 'pr.create'           // GitHub PR creation
  | 'shell';              // Generic shell command (fallback)
```

### ActionHandler (Interface)
```typescript
interface ActionHandler {
  /**
   * The action type this handler processes
   */
  readonly type: ActionType;

  /**
   * Check if this handler can process the given step
   */
  canHandle(step: WorkflowStep): boolean;

  /**
   * Execute the action and return structured result
   */
  execute(step: WorkflowStep, context: ActionContext): Promise<ActionResult>;

  /**
   * Validate step configuration before execution (optional)
   */
  validate?(step: WorkflowStep): ValidationResult;
}
```

### ActionContext
```typescript
interface ActionContext {
  /**
   * The full workflow definition
   */
  workflow: ExecutableWorkflow;

  /**
   * Current phase being executed
   */
  phase: WorkflowPhase;

  /**
   * Current step being executed
   */
  step: WorkflowStep;

  /**
   * Workflow input parameters
   */
  inputs: Record<string, unknown>;

  /**
   * Outputs from previously executed steps
   * Key is `${phaseName}.${stepName}` for uniqueness
   */
  stepOutputs: Map<string, StepOutput>;

  /**
   * Merged environment variables (workflow + phase + step)
   */
  env: Record<string, string>;

  /**
   * Working directory for command execution
   */
  workdir: string;

  /**
   * Abort signal for cancellation
   */
  signal: AbortSignal;

  /**
   * Logger for action execution
   */
  logger: Logger;
}
```

### ActionResult
```typescript
interface ActionResult {
  /**
   * Whether the action completed successfully
   */
  success: boolean;

  /**
   * Structured output from the action (preferably JSON)
   * Used for variable interpolation in subsequent steps
   */
  output: unknown;

  /**
   * Raw stdout from command execution
   */
  stdout?: string;

  /**
   * Raw stderr from command execution
   */
  stderr?: string;

  /**
   * Error message if action failed
   */
  error?: string;

  /**
   * Exit code from command (0 = success)
   */
  exitCode?: number;

  /**
   * Execution duration in milliseconds
   */
  duration: number;

  /**
   * Files modified by this action (for tracking)
   */
  filesModified?: string[];
}
```

### StepOutput
```typescript
interface StepOutput {
  /**
   * Raw string output
   */
  raw: string;

  /**
   * Parsed JSON output (null if not valid JSON)
   */
  parsed: unknown | null;

  /**
   * Exit code from execution
   */
  exitCode: number;

  /**
   * Timestamp when step completed
   */
  completedAt: Date;
}
```

## Action-Specific Types

### WorkspacePrepareInput
```typescript
interface WorkspacePrepareInput {
  /**
   * Branch name to create/checkout
   */
  branch: string;

  /**
   * Base branch to create from (optional, defaults to current)
   */
  baseBranch?: string;

  /**
   * Whether to force checkout (discard local changes)
   */
  force?: boolean;
}
```

### WorkspacePrepareOutput
```typescript
interface WorkspacePrepareOutput {
  /**
   * The branch that was checked out
   */
  branch: string;

  /**
   * Previous branch before checkout
   */
  previousBranch: string;

  /**
   * Whether a new branch was created
   */
  created: boolean;
}
```

### AgentInvokeInput
```typescript
interface AgentInvokeInput {
  /**
   * The prompt/task to send to the agent
   */
  prompt: string;

  /**
   * Optional list of allowed tools
   */
  allowedTools?: string[];

  /**
   * Maximum execution time in seconds
   */
  timeout?: number;

  /**
   * Maximum number of agent turns
   */
  maxTurns?: number;

  /**
   * Working directory for the agent
   */
  workdir?: string;
}
```

### AgentInvokeOutput
```typescript
interface AgentInvokeOutput {
  /**
   * Summary of what the agent accomplished
   */
  summary: string;

  /**
   * Files modified by the agent
   */
  filesModified: string[];

  /**
   * Conversation ID for reference
   */
  conversationId?: string;

  /**
   * Number of turns taken
   */
  turns: number;

  /**
   * Any structured data returned by agent
   */
  data?: Record<string, unknown>;
}
```

### VerificationCheckInput
```typescript
interface VerificationCheckInput {
  /**
   * Command to run (e.g., "npm test", "npm run lint")
   */
  command: string;

  /**
   * Working directory
   */
  workdir?: string;

  /**
   * Environment variables to set
   */
  env?: Record<string, string>;

  /**
   * Expected exit code (default: 0)
   */
  expectedExitCode?: number;
}
```

### VerificationCheckOutput
```typescript
interface VerificationCheckOutput {
  /**
   * Whether verification passed
   */
  passed: boolean;

  /**
   * Test/lint output
   */
  output: string;

  /**
   * Number of tests passed (if applicable)
   */
  testsPassed?: number;

  /**
   * Number of tests failed (if applicable)
   */
  testsFailed?: number;

  /**
   * Lint errors count (if applicable)
   */
  lintErrors?: number;
}
```

### PrCreateInput
```typescript
interface PrCreateInput {
  /**
   * PR title
   */
  title: string;

  /**
   * PR body/description
   */
  body?: string;

  /**
   * Base branch for the PR
   */
  base?: string;

  /**
   * Whether to create as draft
   */
  draft?: boolean;

  /**
   * Labels to add to the PR
   */
  labels?: string[];

  /**
   * Reviewers to request
   */
  reviewers?: string[];
}
```

### PrCreateOutput
```typescript
interface PrCreateOutput {
  /**
   * Created PR number
   */
  number: number;

  /**
   * PR URL
   */
  url: string;

  /**
   * PR state
   */
  state: 'open' | 'draft';

  /**
   * Head branch
   */
  headBranch: string;

  /**
   * Base branch
   */
  baseBranch: string;
}
```

## Interpolation Types

### InterpolationContext
```typescript
interface InterpolationContext {
  /**
   * Workflow inputs
   */
  inputs: Record<string, unknown>;

  /**
   * Step outputs keyed by step ID
   */
  steps: Record<string, StepOutput>;

  /**
   * Environment variables
   */
  env: Record<string, string>;

  /**
   * Built-in functions
   */
  functions: {
    success: () => boolean;
    failure: () => boolean;
    always: () => boolean;
  };
}
```

### VariableReference
```typescript
interface VariableReference {
  /**
   * Full variable expression (e.g., "steps.build.output.version")
   */
  expression: string;

  /**
   * Type: inputs, steps, env, or function
   */
  type: 'inputs' | 'steps' | 'env' | 'function';

  /**
   * Path segments after type
   */
  path: string[];
}
```

## Retry Types

### RetryConfig
```typescript
interface RetryConfig {
  /**
   * Maximum number of attempts (including first try)
   */
  maxAttempts: number;

  /**
   * Initial delay between retries in milliseconds
   */
  delay: number;

  /**
   * Backoff strategy
   */
  backoff: 'constant' | 'linear' | 'exponential';

  /**
   * Maximum delay cap in milliseconds
   */
  maxDelay?: number;

  /**
   * Jitter factor (0-1) to add randomness
   */
  jitter?: number;
}
```

### RetryState
```typescript
interface RetryState {
  /**
   * Current attempt number (1-indexed)
   */
  attempt: number;

  /**
   * Errors from previous attempts
   */
  previousErrors: Error[];

  /**
   * Next delay in milliseconds (if retrying)
   */
  nextDelay?: number;

  /**
   * Whether more retries are available
   */
  canRetry: boolean;
}
```

## Validation Types

### ValidationResult
```typescript
interface ValidationResult {
  /**
   * Whether validation passed
   */
  valid: boolean;

  /**
   * Validation errors (if any)
   */
  errors: ValidationError[];

  /**
   * Validation warnings (if any)
   */
  warnings: ValidationWarning[];
}

interface ValidationError {
  field: string;
  message: string;
  code: string;
}

interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}
```

## Relationships

```
ExecutableWorkflow
    └── WorkflowPhase[]
            └── WorkflowStep[]
                    │
                    ▼ (dispatched to)
              ActionHandler
                    │
                    ├── ActionContext (input)
                    │       ├── stepOutputs: Map<string, StepOutput>
                    │       ├── inputs: Record<string, unknown>
                    │       └── env: Record<string, string>
                    │
                    └── ActionResult (output)
                            ├── success: boolean
                            ├── output: unknown (→ stored in stepOutputs)
                            └── duration: number
```

---

*Generated by speckit*
