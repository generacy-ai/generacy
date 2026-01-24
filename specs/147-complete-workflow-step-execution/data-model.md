# Data Model: Complete Workflow Step Execution Engine

## Core Entities

### ExecutableWorkflow

Top-level workflow definition ready for execution.

```typescript
interface ExecutableWorkflow {
  name: string;
  description?: string;
  phases: WorkflowPhase[];
  env?: Record<string, string>;
  timeout?: number;
}
```

### WorkflowPhase

A logical grouping of steps within a workflow.

```typescript
interface WorkflowPhase {
  name: string;
  steps: WorkflowStep[];
  condition?: string;  // Expression to evaluate for conditional execution
}
```

### WorkflowStep

Individual step definition with action configuration.

```typescript
interface WorkflowStep {
  name: string;
  action: string;             // Action type identifier
  uses?: string;              // Alternative action specification (e.g., 'workspace.prepare')
  with?: Record<string, unknown>;  // Input parameters
  command?: string;           // Shell command (for shell action)
  script?: string;            // Multi-line script
  timeout?: number;           // Step timeout in milliseconds
  continueOnError?: boolean;  // Continue workflow on step failure
  condition?: string;         // Conditional execution expression
  env?: Record<string, string>;  // Step-specific environment
  retry?: RetryConfig;        // Retry configuration
}
```

### RetryConfig

Retry behavior configuration for a step.

```typescript
interface RetryConfig {
  maxAttempts: number;       // Maximum attempts (including first)
  delay: number;             // Initial delay in milliseconds
  backoff: 'constant' | 'linear' | 'exponential';
  maxDelay?: number;         // Maximum delay cap
  jitter?: number;           // Randomness factor (0-1)
}
```

## Action Types

### ActionType Enum

```typescript
type ActionType =
  | 'workspace.prepare'   // Git branch operations
  | 'agent.invoke'        // Claude Code CLI invocation
  | 'verification.check'  // Test/lint execution
  | 'pr.create'           // GitHub PR creation
  | 'shell';              // Generic shell command (fallback)
```

### ActionContext

Context provided to action handlers during execution.

```typescript
interface ActionContext {
  workflow: ExecutableWorkflow;
  phase: WorkflowPhase;
  step: WorkflowStep;
  inputs: Record<string, unknown>;        // Workflow inputs
  stepOutputs: Map<string, StepOutput>;   // Previous step outputs
  env: Record<string, string>;            // Merged environment
  workdir: string;                        // Working directory
  signal: AbortSignal;                    // Cancellation signal
  logger: ActionLogger;                   // Logging interface
}
```

### ActionResult

Result returned by action handlers.

```typescript
interface ActionResult {
  success: boolean;
  output: unknown;           // Structured output (preferably JSON)
  stdout?: string;           // Raw standard output
  stderr?: string;           // Raw standard error
  error?: string;            // Error message if failed
  exitCode?: number;         // Command exit code
  duration: number;          // Execution time in milliseconds
  filesModified?: string[];  // Files changed by this action
}
```

### StepOutput

Output stored for variable interpolation.

```typescript
interface StepOutput {
  raw: string;              // Raw string output
  parsed: unknown | null;   // Parsed JSON (null if not valid)
  exitCode: number;         // Exit code
  completedAt: Date;        // Completion timestamp
}
```

## Action-Specific Types

### WorkspacePrepareInput / Output

```typescript
interface WorkspacePrepareInput {
  branch: string;
  baseBranch?: string;
  force?: boolean;
}

interface WorkspacePrepareOutput {
  branch: string;
  previousBranch: string;
  created: boolean;
}
```

### AgentInvokeInput / Output

```typescript
interface AgentInvokeInput {
  prompt: string;
  allowedTools?: string[];
  timeout?: number;
  maxTurns?: number;
  workdir?: string;
}

interface AgentInvokeOutput {
  summary: string;
  filesModified: string[];
  conversationId?: string;
  turns: number;
  data?: Record<string, unknown>;
}
```

### VerificationCheckInput / Output

```typescript
interface VerificationCheckInput {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  expectedExitCode?: number;
}

interface VerificationCheckOutput {
  passed: boolean;
  output: string;
  testsPassed?: number;
  testsFailed?: number;
  lintErrors?: number;
}
```

### PrCreateInput / Output

```typescript
interface PrCreateInput {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
}

interface PrCreateOutput {
  number: number;
  url: string;
  state: 'open' | 'draft';
  headBranch: string;
  baseBranch: string;
}
```

## Execution Results

### ExecutionResult

Complete workflow execution result.

```typescript
interface ExecutionResult {
  workflowName: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  startTime: number;
  endTime?: number;
  duration?: number;
  phaseResults: PhaseResult[];
  env: Record<string, string>;
}

type ExecutionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
type ExecutionMode = 'normal' | 'dry-run';
```

### PhaseResult / StepResult

```typescript
interface PhaseResult {
  phaseName: string;
  status: StepStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  stepResults: StepResult[];
}

interface StepResult {
  stepName: string;
  phaseName: string;
  status: StepStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  output?: string;
  error?: string;
  exitCode?: number;
}

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
```

## Debug Integration Types

### Breakpoint

```typescript
interface Breakpoint {
  id: string;
  phaseName?: string;
  stepName: string;
  enabled: boolean;
  condition?: string;
  hitCount?: number;
  currentHits?: number;
}
```

### StepState

```typescript
interface StepState {
  step: WorkflowStep;
  phaseName: string;
  stepIndex: number;
  isPaused: boolean;
  startTime?: number;
  result?: StepResult;
  actionResult?: ActionResult;
}
```

## Relationships

```
ExecutableWorkflow
    └── phases: WorkflowPhase[]
            └── steps: WorkflowStep[]
                    └── retry?: RetryConfig
                    └── with?: action-specific inputs

ExecutionResult
    └── phaseResults: PhaseResult[]
            └── stepResults: StepResult[]

ActionContext
    └── workflow: ExecutableWorkflow
    └── phase: WorkflowPhase
    └── step: WorkflowStep
    └── stepOutputs: Map<stepId, StepOutput>
```

## Validation Rules

1. **WorkflowStep.name**: Required, must be unique within phase
2. **WorkflowStep.action or uses**: At least one required
3. **RetryConfig.maxAttempts**: Minimum 1
4. **RetryConfig.delay**: Minimum 0
5. **RetryConfig.jitter**: Range 0-1
6. **Action-specific inputs**: See individual handler validate() methods
