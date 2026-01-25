/**
 * Type definitions for the workflow runner.
 */

/**
 * Workflow execution status
 */
export type ExecutionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/**
 * Step execution status
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Execution mode
 */
export type ExecutionMode = 'normal' | 'dry-run';

/**
 * Retry configuration for a step
 */
export interface RetryConfig {
  /** Maximum number of attempts (including first try) */
  maxAttempts: number;
  /** Initial delay between retries in milliseconds */
  delay: number;
  /** Backoff strategy */
  backoff: 'constant' | 'linear' | 'exponential';
  /** Maximum delay cap in milliseconds */
  maxDelay?: number;
  /** Jitter factor (0-1) to add randomness */
  jitter?: number;
}

/**
 * Step definition from parsed workflow
 */
export interface WorkflowStep {
  name: string;
  action: string;
  /** Uses field for specifying action type (e.g., 'workspace.prepare', 'agent.invoke') */
  uses?: string;
  /** Input parameters for the action (from 'with' field in YAML) */
  with?: Record<string, unknown>;
  command?: string;
  script?: string;
  timeout?: number;
  continueOnError?: boolean;
  condition?: string;
  env?: Record<string, string>;
  /** Retry configuration */
  retry?: RetryConfig;
}

/**
 * Phase definition from parsed workflow
 */
export interface WorkflowPhase {
  name: string;
  steps: WorkflowStep[];
  condition?: string;
}

/**
 * Parsed workflow structure for execution
 */
export interface ExecutableWorkflow {
  name: string;
  description?: string;
  phases: WorkflowPhase[];
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Step execution result
 */
export interface StepResult {
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

/**
 * Phase execution result
 */
export interface PhaseResult {
  phaseName: string;
  status: StepStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  stepResults: StepResult[];
}

/**
 * Workflow execution result
 */
export interface ExecutionResult {
  workflowName: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  startTime: number;
  endTime?: number;
  duration?: number;
  phaseResults: PhaseResult[];
  env: Record<string, string>;
}

/**
 * Execution options
 */
export interface ExecutionOptions {
  /** Execution mode */
  mode: ExecutionMode;
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Start from specific phase */
  startPhase?: string;
  /** Start from specific step */
  startStep?: string;
  /** Enable verbose output */
  verbose?: boolean;
}

/**
 * Execution event types
 */
export type ExecutionEventType =
  | 'execution:start'
  | 'execution:complete'
  | 'execution:error'
  | 'execution:cancel'
  | 'phase:start'
  | 'phase:complete'
  | 'phase:error'
  | 'step:start'
  | 'step:complete'
  | 'step:error'
  | 'step:output'
  | 'action:start'
  | 'action:complete'
  | 'action:error'
  | 'action:retry';

/**
 * Execution event data
 */
export interface ExecutionEvent {
  type: ExecutionEventType;
  timestamp: number;
  workflowName: string;
  phaseName?: string;
  stepName?: string;
  message?: string;
  data?: unknown;
}

/**
 * Execution event listener
 */
export type ExecutionEventListener = (event: ExecutionEvent) => void;

/**
 * Request for executing a single step via the debug adapter.
 * Used by DebugSession to delegate individual step execution to WorkflowExecutor.
 */
export interface SingleStepRequest {
  /** The step to execute */
  step: WorkflowStep;
  /** The phase containing the step */
  phase: WorkflowPhase;
  /** Execution context for variable interpolation and output storage */
  context: unknown; // ExecutionContext (avoid circular import)
  /** Index of the phase in the workflow */
  phaseIndex: number;
  /** Index of the step within the phase */
  stepIndex: number;
}

/**
 * Result from executing a single step via the debug adapter.
 */
export interface SingleStepResult {
  /** Whether the step completed successfully */
  success: boolean;
  /** Step output (structured or string) */
  output: unknown | null;
  /** Error if step failed */
  error: Error | null;
  /** Execution duration in milliseconds */
  duration: number;
  /** Whether the step was skipped (e.g., condition not met) */
  skipped: boolean;
  /** Exit code from the action handler */
  exitCode?: number;
}
