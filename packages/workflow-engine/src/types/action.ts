/**
 * Action system types.
 * Defines interfaces for action handlers, context, and results.
 */
import type { ExecutableWorkflow } from './execution.js';
import type { PhaseDefinition, StepDefinition } from './workflow.js';
import type { Logger } from './logger.js';

/**
 * Built-in action types supported by the workflow engine.
 * These are the core actions that are always available.
 */
export type BuiltinActionType =
  | 'workspace.prepare'        // Git branch operations
  | 'agent.invoke'             // Claude Code CLI invocation
  | 'verification.check'       // Test/lint execution
  | 'pr.create'                // GitHub PR creation
  | 'shell'                    // Generic shell command (fallback)
  | 'humancy.request_review'   // Human review checkpoint
  | 'speckit';                 // Speckit workflow operations

/**
 * GitHub action namespace types
 */
export type GitHubActionType =
  | 'github.preflight'
  | 'github.get_context'
  | 'github.review_changes'
  | 'github.commit_and_push'
  | 'github.merge_from_base'
  | 'github.create_draft_pr'
  | 'github.mark_pr_ready'
  | 'github.update_pr'
  | 'github.read_pr_feedback'
  | 'github.respond_pr_feedback'
  | 'github.add_comment'
  | 'github.sync_labels';

/**
 * Workflow action namespace types
 */
export type WorkflowActionType =
  | 'workflow.update_phase'
  | 'workflow.check_gate'
  | 'workflow.update_stage';

/**
 * Epic action namespace types
 */
export type EpicActionType =
  | 'epic.post_tasks_summary'
  | 'epic.check_completion'
  | 'epic.update_status'
  | 'epic.create_pr'
  | 'epic.close'
  | 'epic.dispatch_children';

/**
 * All known action types (built-in + namespaced).
 * Use ActionIdentifier for dynamic/custom actions.
 */
export type ActionType =
  | BuiltinActionType
  | GitHubActionType
  | WorkflowActionType
  | EpicActionType;

/**
 * Action identifier - can be any namespaced string (e.g., 'github.preflight', 'custom.action')
 * This allows for extensibility beyond the predefined types.
 */
export type ActionIdentifier = string;

/**
 * Action namespace definition for plugin registration
 */
export interface ActionNamespace {
  /** Namespace name (e.g., 'github', 'workflow', 'epic') */
  namespace: string;
  /** Description of the namespace */
  description?: string;
  /** Action handlers in this namespace */
  handlers: ActionHandler[];
}

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
  /** Emit a streaming event (log output or step output) */
  emitEvent?: (event: {
    type: 'log:append' | 'step:output';
    data: Record<string, unknown>;
  }) => void;
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
  /** The action type this handler processes (can be namespaced) */
  readonly type: ActionIdentifier;

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
 * Urgency levels for human review requests
 */
export type HumancyUrgency = 'low' | 'normal' | 'blocking_soon' | 'blocking_now';

/**
 * Input for humancy.request_review action
 */
export interface HumancyReviewInput {
  /**
   * Content or file path to present for review.
   * Supports variable interpolation: ${steps.preview.output.summary}
   */
  artifact: string;

  /**
   * Review instructions and context for the human reviewer.
   * Describes what to check and why approval is needed.
   */
  context: string;

  /**
   * Review urgency level.
   * - 'low': No time pressure, can wait days
   * - 'normal': Default, expect response within hours
   * - 'blocking_soon': Blocking workflow, need response soon
   * - 'blocking_now': Critical, immediate attention needed
   * @default 'normal'
   */
  urgency?: HumancyUrgency;

  /**
   * Timeout in milliseconds for waiting on human response.
   * After timeout, action fails with timeout reason.
   * @default 86400000 (24 hours)
   */
  timeout?: number;
}

/**
 * Output from humancy.request_review action
 */
export interface HumancyReviewOutput {
  /**
   * Whether the human approved the review.
   * Used in conditional step execution: ${steps.review.approved}
   */
  approved: boolean;

  /**
   * Optional comments from the reviewer.
   * Present when rejection requires explanation.
   */
  comments?: string;

  /**
   * Identifier of the user who responded.
   * From Humancy user profile.
   */
  respondedBy?: string;

  /**
   * ISO timestamp when response was received.
   */
  respondedAt?: string;

  /**
   * Unique ID of the review request.
   * Can be used for audit/tracking.
   */
  reviewId: string;
}

/**
 * Check if an action identifier is a namespaced action
 * @param identifier The action identifier to check
 * @returns true if the identifier contains a namespace (e.g., 'github.preflight')
 */
export function isNamespacedAction(identifier: string): boolean {
  return identifier.includes('.') && !identifier.startsWith('.');
}

/**
 * Parse namespace and action name from an identifier
 * @param identifier The action identifier (e.g., 'github.preflight')
 * @returns Object with namespace and name, or null if not namespaced
 */
export function parseNamespacedAction(identifier: string): { namespace: string; name: string } | null {
  if (!isNamespacedAction(identifier)) {
    return null;
  }
  const dotIndex = identifier.indexOf('.');
  return {
    namespace: identifier.substring(0, dotIndex),
    name: identifier.substring(dotIndex + 1),
  };
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
    // Check for namespaced actions first (e.g., 'github.preflight', 'workflow.update_phase')
    if (isNamespacedAction(uses)) {
      // Return the namespaced action directly if it's a known type
      return uses as ActionType;
    }

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
    if (uses.includes('humancy.request_review') || uses.includes('humancy/request_review') || uses.includes('humancy')) {
      return 'humancy.request_review';
    }
    // Check for speckit actions (speckit.* or speckit/*)
    if (uses.startsWith('speckit.') || uses.startsWith('speckit/')) {
      return 'speckit';
    }
  }

  // Check 'action' field as fallback
  const action = step.action;
  if (action) {
    // Check for namespaced actions (e.g., 'github.preflight')
    if (isNamespacedAction(action)) {
      return action as ActionType;
    }

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
    if (action === 'humancy.request_review' || action === 'humancy-request-review') {
      return 'humancy.request_review';
    }
    if (action === 'shell' || action === 'run') {
      return 'shell';
    }
    // Check for speckit actions (speckit.* or speckit/*)
    if (action.startsWith('speckit.') || action.startsWith('speckit/')) {
      return 'speckit';
    }
  }

  // If step has command or script, treat as shell
  if (step.command || step.script) {
    return 'shell';
  }

  // Default to shell for unknown actions
  return 'shell';
}
