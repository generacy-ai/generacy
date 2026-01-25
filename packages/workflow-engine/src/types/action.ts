/**
 * Action system types.
 * Defines interfaces for action handlers, context, and results.
 */
import type { ExecutableWorkflow, PhaseDefinition, StepDefinition } from './execution.js';
import type { Logger } from './logger.js';

/**
 * Action types supported by the workflow engine
 */
export type ActionType =
  | 'workspace.prepare'   // Git branch operations
  | 'agent.invoke'        // Claude Code CLI invocation
  | 'verification.check'  // Test/lint execution
  | 'pr.create'           // GitHub PR creation
  | 'shell';              // Generic shell command (fallback)

/**
 * Step output stored for variable interpolation
 */
export interface StepOutput {
  /** Raw string output */
  raw: string;
  /** Parsed JSON output (null if not valid JSON) */
  parsed: unknown | null;
  /** Exit code from execution */
  exitCode: number;
  /** Timestamp when step completed */
  completedAt: Date;
}

/**
 * Context provided to action handlers during execution
 */
export interface ActionContext {
  /** The full workflow definition */
  workflow: ExecutableWorkflow;
  /** Current phase being executed */
  phase: PhaseDefinition;
  /** Current step being executed */
  step: StepDefinition;
  /** Workflow input parameters */
  inputs: Record<string, unknown>;
  /** Outputs from previously executed steps (keyed by stepId) */
  stepOutputs: Map<string, StepOutput>;
  /** Merged environment variables */
  env: Record<string, string>;
  /** Working directory for command execution */
  workdir: string;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Logger for action execution */
  logger: Logger;
}

/**
 * Result returned by action handlers
 */
export interface ActionResult {
  /** Whether the action completed successfully */
  success: boolean;
  /** Structured output from the action (preferably JSON) */
  output: unknown;
  /** Raw stdout from command execution */
  stdout?: string;
  /** Raw stderr from command execution */
  stderr?: string;
  /** Error message if action failed */
  error?: string;
  /** Exit code from command (0 = success) */
  exitCode?: number;
  /** Execution duration in milliseconds */
  duration: number;
  /** Files modified by this action (for tracking) */
  filesModified?: string[];
}

/**
 * Validation error structure
 */
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

/**
 * Validation warning structure
 */
export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Validation result from step configuration check
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation errors (if any) */
  errors: ValidationError[];
  /** Validation warnings (if any) */
  warnings: ValidationWarning[];
}

/**
 * Action handler interface
 * Defines the contract for all action implementations
 */
export interface ActionHandler {
  /** The action type this handler processes */
  readonly type: ActionType;

  /**
   * Check if this handler can process the given step
   * @param step The workflow step to check
   * @returns true if this handler can process the step
   */
  canHandle(step: StepDefinition): boolean;

  /**
   * Execute the action and return structured result
   * @param step The workflow step to execute
   * @param context Execution context with inputs, outputs, and environment
   * @returns Promise resolving to action result
   */
  execute(step: StepDefinition, context: ActionContext): Promise<ActionResult>;

  /**
   * Validate step configuration before execution (optional)
   * @param step The workflow step to validate
   * @returns Validation result with errors and warnings
   */
  validate?(step: StepDefinition): ValidationResult;
}

// --- Action-specific input/output types ---

/**
 * Input for workspace.prepare action
 */
export interface WorkspacePrepareInput {
  /** Branch name to create/checkout */
  branch: string;
  /** Base branch to create from (optional, defaults to current) */
  baseBranch?: string;
  /** Whether to force checkout (discard local changes) */
  force?: boolean;
}

/**
 * Output from workspace.prepare action
 */
export interface WorkspacePrepareOutput {
  /** The branch that was checked out */
  branch: string;
  /** Previous branch before checkout */
  previousBranch: string;
  /** Whether a new branch was created */
  created: boolean;
}

/**
 * Input for agent.invoke action
 */
export interface AgentInvokeInput {
  /** The prompt/task to send to the agent */
  prompt: string;
  /** Optional list of allowed tools */
  allowedTools?: string[];
  /** Maximum execution time in seconds */
  timeout?: number;
  /** Maximum number of agent turns */
  maxTurns?: number;
  /** Working directory for the agent */
  workdir?: string;
}

/**
 * Output from agent.invoke action
 */
export interface AgentInvokeOutput {
  /** Summary of what the agent accomplished */
  summary: string;
  /** Files modified by the agent */
  filesModified: string[];
  /** Conversation ID for reference */
  conversationId?: string;
  /** Number of turns taken */
  turns: number;
  /** Any structured data returned by agent */
  data?: Record<string, unknown>;
}

/**
 * Input for verification.check action
 */
export interface VerificationCheckInput {
  /** Command to run (e.g., "npm test", "npm run lint") */
  command: string;
  /** Working directory */
  workdir?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Expected exit code (default: 0) */
  expectedExitCode?: number;
}

/**
 * Output from verification.check action
 */
export interface VerificationCheckOutput {
  /** Whether verification passed */
  passed: boolean;
  /** Test/lint output */
  output: string;
  /** Number of tests passed (if applicable) */
  testsPassed?: number;
  /** Number of tests failed (if applicable) */
  testsFailed?: number;
  /** Lint errors count (if applicable) */
  lintErrors?: number;
}

/**
 * Input for pr.create action
 */
export interface PrCreateInput {
  /** PR title */
  title: string;
  /** PR body/description */
  body?: string;
  /** Base branch for the PR */
  base?: string;
  /** Whether to create as draft */
  draft?: boolean;
  /** Labels to add to the PR */
  labels?: string[];
  /** Reviewers to request */
  reviewers?: string[];
}

/**
 * Output from pr.create action
 */
export interface PrCreateOutput {
  /** Created PR number */
  number: number;
  /** PR URL */
  url: string;
  /** PR state */
  state: 'open' | 'draft';
  /** Head branch */
  headBranch: string;
  /** Base branch */
  baseBranch: string;
}

/**
 * Parse action type from a workflow step's 'uses' or 'action' field
 * @param step The workflow step to parse
 * @returns The detected action type, or 'shell' as fallback
 */
export function parseActionType(step: StepDefinition): ActionType {
  // Check 'uses' field first (preferred for action specification)
  const uses = step.uses;
  if (uses) {
    // Map uses values to action types
    if (uses.includes('workspace.prepare') || uses.includes('workspace/prepare')) {
      return 'workspace.prepare';
    }
    if (uses.includes('agent.invoke') || uses.includes('agent/invoke') || uses.includes('claude')) {
      return 'agent.invoke';
    }
    if (uses.includes('verification.check') || uses.includes('verification/check') || uses.includes('test') || uses.includes('lint')) {
      return 'verification.check';
    }
    if (uses.includes('pr.create') || uses.includes('pr/create') || uses.includes('pull-request')) {
      return 'pr.create';
    }
  }

  // Check 'action' field as fallback
  const action = step.action;
  if (action) {
    if (action === 'workspace.prepare' || action === 'workspace-prepare') {
      return 'workspace.prepare';
    }
    if (action === 'agent.invoke' || action === 'agent-invoke') {
      return 'agent.invoke';
    }
    if (action === 'verification.check' || action === 'verification-check' || action === 'test' || action === 'lint') {
      return 'verification.check';
    }
    if (action === 'pr.create' || action === 'pr-create') {
      return 'pr.create';
    }
    if (action === 'shell' || action === 'run') {
      return 'shell';
    }
  }

  // If step has command or script, treat as shell
  if (step.command || step.script) {
    return 'shell';
  }

  // Default to shell for unknown actions
  return 'shell';
}
