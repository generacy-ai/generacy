/**
 * Workflow definition types.
 * Defines the structure of workflow YAML files.
 */

/**
 * Input parameter definition
 */
export interface InputDefinition {
  /** Input name */
  name: string;
  /** Input description */
  description?: string;
  /** Default value */
  default?: unknown;
  /** Whether input is required */
  required?: boolean;
  /** Input type for validation */
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
}

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
export interface StepDefinition {
  /** Step name/identifier */
  name: string;
  /** Action type (e.g., 'shell', 'workspace.prepare') */
  action: string;
  /** Uses field for specifying action type (e.g., 'workspace.prepare', 'agent.invoke') */
  uses?: string;
  /** Input parameters for the action (from 'with' field in YAML) */
  with?: Record<string, unknown>;
  /** Shell command to execute */
  command?: string;
  /** Script content to execute */
  script?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to continue on error */
  continueOnError?: boolean;
  /** Condition expression for step execution */
  condition?: string;
  /** Step-specific environment variables */
  env?: Record<string, string>;
  /** Retry configuration */
  retry?: RetryConfig;
  /**
   * Gate for review checkpoint.
   * When set, workflow pauses for human approval after step completes.
   * Values like 'spec-review', 'clarification-review', 'plan-review', etc.
   */
  gate?: string;
}

/**
 * Phase definition from parsed workflow
 */
export interface PhaseDefinition {
  /** Phase name */
  name: string;
  /** Steps in this phase */
  steps: StepDefinition[];
  /** Condition expression for phase execution */
  condition?: string;
}

/**
 * Workflow definition from YAML file
 */
export interface WorkflowDefinition {
  /** Workflow name */
  name: string;
  /** Workflow description */
  description?: string;
  /** Workflow version */
  version?: string;
  /** Input parameter definitions */
  inputs?: InputDefinition[];
  /** Workflow phases */
  phases: PhaseDefinition[];
  /** Workflow-level environment variables */
  env?: Record<string, string>;
  /** Default timeout for all steps (milliseconds) */
  timeout?: number;
  /** Workflow-level retry configuration */
  retry?: RetryConfig;
}

/**
 * Alias for backward compatibility
 */
export type WorkflowStep = StepDefinition;
export type WorkflowPhase = PhaseDefinition;
