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
 * Step definition from parsed workflow
 */
export interface WorkflowStep {
  name: string;
  action: string;
  command?: string;
  script?: string;
  timeout?: number;
  continueOnError?: boolean;
  condition?: string;
  env?: Record<string, string>;
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
  | 'step:output';

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
