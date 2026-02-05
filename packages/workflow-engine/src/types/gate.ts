/**
 * Gate types for workflow review checkpoints.
 * Gates allow workflows to pause for human approval at defined points.
 */
import type { ExecutableWorkflow } from './execution.js';
import type { PhaseDefinition, StepDefinition } from './workflow.js';
import type { ActionResult } from './action.js';

/**
 * Standard gate types for speckit workflows
 */
export type GateType =
  | 'spec-review'
  | 'clarification-review'
  | 'plan-review'
  | 'tasks-review'
  | 'implementation-review'
  | string; // Allow custom gate types

/**
 * Gate configuration options
 */
export interface GateConfig {
  /** Gate identifier */
  type: GateType;

  /**
   * Timeout before auto-action in milliseconds.
   * Default: undefined (indefinite wait)
   */
  timeout_ms?: number;

  /**
   * Action to take on timeout.
   * - 'approve': Auto-approve and continue
   * - 'reject': Fail the step
   * - 'block': Keep waiting (default)
   */
  timeout_action?: 'approve' | 'reject' | 'block';

  /** Custom approval handler (optional) */
  handler?: GateHandler;
}

/**
 * Context passed to gate handlers
 */
export interface GateContext {
  /** The full workflow being executed */
  workflow: ExecutableWorkflow;

  /** Current phase containing the gated step */
  phase: PhaseDefinition;

  /** The step with the gate */
  step: StepDefinition;

  /** Result from executing the step (before gate) */
  stepResult: ActionResult;

  /** The gate type string from step.gate */
  gateType: string;

  /** Workflow execution ID for state tracking */
  executionId?: string;
}

/**
 * Result from gate approval check
 */
export interface GateResult {
  /** Whether the gate was approved */
  approved: boolean;

  /** Who approved/rejected (username or 'system') */
  approvedBy?: string;

  /** Optional comments from reviewer */
  comments?: string;

  /** Whether the result was due to timeout */
  timedOut?: boolean;

  /** Timestamp of the decision */
  decidedAt?: string;
}

/**
 * Interface for custom gate handlers.
 * Implementations can integrate with external approval systems.
 */
export interface GateHandler {
  /**
   * Check if gate is already approved (non-blocking).
   * Called first to see if approval exists without waiting.
   */
  checkApproval(context: GateContext): Promise<boolean>;

  /**
   * Wait for approval with optional timeout.
   * Called if checkApproval returns false.
   */
  waitForApproval(context: GateContext, timeoutMs?: number): Promise<GateResult>;

  /**
   * Optional: Notify reviewers that approval is needed.
   * Called before waitForApproval.
   */
  requestApproval?(context: GateContext): Promise<void>;
}

/**
 * Default gate handler that always blocks.
 * Workflows should be resumed manually after human review.
 */
export class DefaultGateHandler implements GateHandler {
  async checkApproval(_context: GateContext): Promise<boolean> {
    // Default: not pre-approved, requires explicit decision
    return false;
  }

  async waitForApproval(context: GateContext, timeoutMs?: number): Promise<GateResult> {
    // Default implementation: pause workflow (never auto-approve)
    // The workflow will need to be resumed with explicit decision
    if (timeoutMs === undefined) {
      // Indefinite wait - workflow pauses
      return {
        approved: false,
        approvedBy: 'system',
        comments: `Workflow paused at gate: ${context.gateType}. Resume with explicit approval.`,
        timedOut: false,
      };
    }

    // With timeout, we could implement polling, but default blocks
    return {
      approved: false,
      approvedBy: 'system',
      comments: `Gate timeout (${timeoutMs}ms). Workflow paused.`,
      timedOut: true,
    };
  }
}

/**
 * Parse gate string into GateConfig
 */
export function parseGateConfig(gateString: string): GateConfig {
  // Simple format: just the gate type
  // Could be extended to parse "type:timeout:action" format
  return {
    type: gateString as GateType,
  };
}
