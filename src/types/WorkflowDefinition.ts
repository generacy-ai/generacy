/**
 * Workflow Definition Types
 *
 * The blueprint for a workflow, defining its steps and behavior.
 */

import type { ErrorHandler } from './ErrorHandler.js';

/**
 * The blueprint for a workflow, defining its steps and behavior.
 */
export interface WorkflowDefinition {
  /** Unique name identifying this workflow type */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Ordered list of steps to execute */
  steps: WorkflowStep[];

  /** Optional error handling configuration */
  onError?: ErrorHandler;

  /** Maximum duration in milliseconds before timeout */
  timeout?: number;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A single step within a workflow definition.
 */
export interface WorkflowStep {
  /** Unique identifier within the workflow */
  id: string;

  /** Step type determining execution behavior */
  type: StepType;

  /** Type-specific configuration */
  config: StepConfig;

  /** Next step(s) to execute after completion */
  next?: string | ConditionalNext[];

  /** Step-level timeout in milliseconds */
  timeout?: number;

  /** Number of retry attempts on failure */
  retries?: number;
}

/**
 * Available step types
 */
export type StepType = 'agent' | 'human' | 'integration' | 'condition' | 'parallel';

/**
 * Agent step: invoke an AI agent command
 */
export interface AgentStepConfig {
  /** Command to execute (e.g., "/speckit:specify") */
  command: string;

  /** Agent mode affecting behavior */
  mode: 'research' | 'coding' | 'review';

  /** Optional arguments to pass */
  args?: Record<string, unknown>;
}

/**
 * Human step: pause for human input
 */
export interface HumanStepConfig {
  /** Type of human action required */
  action: 'review' | 'approve' | 'input' | 'decide';

  /** How urgent is the human response */
  urgency: 'blocking_now' | 'blocking_soon' | 'when_available';

  /** Optional prompt/instructions for the human */
  prompt?: string;

  /** For 'decide' action: available options */
  options?: string[];
}

/**
 * Integration step: call external service
 */
export interface IntegrationStepConfig {
  /** Integration identifier */
  service: string;

  /** Operation to perform */
  operation: string;

  /** Operation parameters */
  params?: Record<string, unknown>;
}

/**
 * Condition step: branch based on context
 */
export interface ConditionConfig {
  /** Property path expression (e.g., "context.status == approved") */
  expression: string;

  /** Step ID if condition is true */
  then: string;

  /** Step ID if condition is false */
  else: string;
}

/**
 * Parallel step: execute branches concurrently
 */
export interface ParallelConfig {
  /** Array of step sequences to execute in parallel */
  branches: WorkflowStep[][];

  /** Join strategy: wait for all or first completion */
  join: 'all' | 'any';
}

/**
 * Union type for all step configurations
 */
export type StepConfig =
  | AgentStepConfig
  | HumanStepConfig
  | IntegrationStepConfig
  | ConditionConfig
  | ParallelConfig;

/**
 * Conditional navigation to next step
 */
export interface ConditionalNext {
  /** Property path expression to evaluate */
  condition: string;

  /** Step ID if condition is true */
  stepId: string;
}

/**
 * Type guards for step configurations
 */
export function isAgentStepConfig(config: StepConfig): config is AgentStepConfig {
  return 'command' in config && 'mode' in config;
}

export function isHumanStepConfig(config: StepConfig): config is HumanStepConfig {
  return 'action' in config && 'urgency' in config;
}

export function isIntegrationStepConfig(config: StepConfig): config is IntegrationStepConfig {
  return 'service' in config && 'operation' in config;
}

export function isConditionConfig(config: StepConfig): config is ConditionConfig {
  return 'expression' in config && 'then' in config && 'else' in config;
}

export function isParallelConfig(config: StepConfig): config is ParallelConfig {
  return 'branches' in config && 'join' in config;
}
