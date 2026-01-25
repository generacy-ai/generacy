/**
 * Execution state types.
 * Defines runtime state for workflow execution.
 */
import type { PhaseDefinition, StepDefinition, WorkflowDefinition } from './workflow.js';

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
 * Parsed workflow structure for execution
 * Extends WorkflowDefinition with runtime-resolved values
 */
export interface ExecutableWorkflow {
  /** Workflow name */
  name: string;
  /** Workflow description */
  description?: string;
  /** Workflow phases */
  phases: PhaseDefinition[];
  /** Resolved environment variables */
  env?: Record<string, string>;
  /** Default timeout */
  timeout?: number;
}

/**
 * Step execution result
 */
export interface StepResult {
  /** Step name */
  stepName: string;
  /** Phase name containing the step */
  phaseName: string;
  /** Execution status */
  status: StepStatus;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime?: number;
  /** Duration in milliseconds */
  duration?: number;
  /** Step output */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Exit code from command */
  exitCode?: number;
}

/**
 * Phase execution result
 */
export interface PhaseResult {
  /** Phase name */
  phaseName: string;
  /** Execution status */
  status: StepStatus;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime?: number;
  /** Duration in milliseconds */
  duration?: number;
  /** Results for each step in the phase */
  stepResults: StepResult[];
}

/**
 * Workflow execution result
 */
export interface ExecutionResult {
  /** Workflow name */
  workflowName: string;
  /** Final execution status */
  status: ExecutionStatus;
  /** Execution mode used */
  mode: ExecutionMode;
  /** Start timestamp */
  startTime: number;
  /** End timestamp */
  endTime?: number;
  /** Duration in milliseconds */
  duration?: number;
  /** Results for each phase */
  phaseResults: PhaseResult[];
  /** Environment variables used */
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
 * Request for executing a single step via the debug adapter.
 * Used by DebugSession to delegate individual step execution to WorkflowExecutor.
 */
export interface SingleStepRequest {
  /** The step to execute */
  step: StepDefinition;
  /** The phase containing the step */
  phase: PhaseDefinition;
  /** Execution context for variable interpolation and output storage */
  context: unknown;
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
