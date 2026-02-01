/**
 * HumancyReviewAction - Human-in-the-loop review checkpoint action.
 * Pauses workflow execution to request human review and waits for response.
 */
import { v4 as uuid } from 'uuid';
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  StepDefinition,
  HumancyReviewInput,
  HumancyReviewOutput,
  HumancyUrgency,
} from '../../types/index.js';
import type { WorkflowState, WorkflowStore } from '../../types/store.js';
import { parseActionType } from '../../types/action.js';
import { FilesystemWorkflowStore } from '../../store/filesystem-store.js';

/** Default timeout for human review: 24 hours */
const DEFAULT_REVIEW_TIMEOUT = 24 * 60 * 60 * 1000;

/** Default urgency level */
const DEFAULT_URGENCY: HumancyUrgency = 'normal';

/**
 * Decision request payload for HumanHandler
 */
interface ReviewDecisionRequest {
  type: 'review';
  title: string;
  description: string;
  options: Array<{ id: string; label: string; requiresComment?: boolean }>;
  workflowId: string;
  stepId: string;
  urgency: HumancyUrgency;
  artifact?: string;
}

/**
 * Decision response from HumanHandler
 */
interface ReviewDecisionResponse {
  approved?: boolean;
  decision?: string;
  input?: string;
  respondedBy: string;
  respondedAt: string;
}

/**
 * Human handler interface for requesting decisions.
 * This interface allows dependency injection for testing.
 */
export interface HumanDecisionHandler {
  requestDecision(request: ReviewDecisionRequest, timeout: number): Promise<ReviewDecisionResponse>;
}

/**
 * HumancyReviewAction implementation.
 * Handles humancy.request_review workflow steps.
 */
export class HumancyReviewAction extends BaseAction {
  readonly type: ActionType = 'humancy.request_review';
  private store: WorkflowStore;
  private humanHandler: HumanDecisionHandler | null;

  /**
   * Create a new HumancyReviewAction
   * @param humanHandler Optional human handler for decision routing
   * @param store Optional workflow store for state persistence
   */
  constructor(humanHandler?: HumanDecisionHandler, store?: WorkflowStore) {
    super();
    this.humanHandler = humanHandler ?? null;
    this.store = store ?? new FilesystemWorkflowStore();
  }

  /**
   * Set the human handler for decision routing.
   * This allows late binding when the handler is created after the action.
   */
  setHumanHandler(handler: HumanDecisionHandler): void {
    this.humanHandler = handler;
  }

  /**
   * Set the workflow store for state persistence.
   */
  setStore(store: WorkflowStore): void {
    this.store = store;
  }

  /**
   * Check if this handler can process the given step
   */
  canHandle(step: StepDefinition): boolean {
    return parseActionType(step) === 'humancy.request_review';
  }

  /**
   * Validate step configuration
   */
  validate(step: StepDefinition): ValidationResult {
    const errors: Array<{ field: string; message: string; code: string }> = [];
    const warnings: Array<{ field: string; message: string; suggestion?: string }> = [];

    const inputs = step.with as Partial<HumancyReviewInput> | undefined;

    // At least artifact or context must be provided
    if (!inputs?.artifact && !inputs?.context) {
      errors.push({
        field: 'with',
        message: 'Either artifact or context must be provided',
        code: 'MISSING_REQUIRED_INPUT',
      });
    }

    // Validate urgency if provided
    if (inputs?.urgency) {
      const validUrgencies: HumancyUrgency[] = ['low', 'normal', 'blocking_soon', 'blocking_now'];
      if (!validUrgencies.includes(inputs.urgency)) {
        errors.push({
          field: 'with.urgency',
          message: `Invalid urgency value. Must be one of: ${validUrgencies.join(', ')}`,
          code: 'INVALID_URGENCY',
        });
      }
    }

    // Validate timeout if provided
    if (inputs?.timeout !== undefined) {
      if (typeof inputs.timeout !== 'number' || inputs.timeout <= 0) {
        errors.push({
          field: 'with.timeout',
          message: 'Timeout must be a positive number',
          code: 'INVALID_TIMEOUT',
        });
      }
    }

    // Warn if no human handler is configured
    if (!this.humanHandler) {
      warnings.push({
        field: 'handler',
        message: 'No human handler configured - review will simulate approval',
        suggestion: 'Configure HumanHandler for real human review integration',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Execute the humancy review action
   */
  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get input configuration
    const artifact = this.getInput<string>(step, context, 'artifact') ?? '';
    const reviewContext = this.getInput<string>(step, context, 'context') ?? '';
    const urgency = this.getInput<HumancyUrgency>(step, context, 'urgency') ?? DEFAULT_URGENCY;
    const timeout = this.getInput<number>(step, context, 'timeout') ?? DEFAULT_REVIEW_TIMEOUT;

    // Generate review ID
    const reviewId = `rev_${uuid()}`;

    // Get workflow ID from context (use name as ID since ExecutableWorkflow doesn't have id)
    const workflowId = `wf_${context.workflow.name.replace(/[^a-zA-Z0-9]/g, '_')}_${uuid().slice(0, 8)}`;
    const stepId = step.name;

    context.logger.info(`Requesting human review [${reviewId}] for step: ${step.name}`);
    context.logger.debug(`Artifact: ${artifact.substring(0, 100)}...`);
    context.logger.debug(`Context: ${reviewContext.substring(0, 100)}...`);
    context.logger.debug(`Urgency: ${urgency}, Timeout: ${timeout}ms`);

    try {
      // Save workflow state for potential resume
      await this.saveCheckpoint(workflowId, context, step, reviewId, artifact);

      let response: ReviewDecisionResponse;

      if (this.humanHandler) {
        // Real human handler integration
        const request: ReviewDecisionRequest = {
          type: 'review',
          title: `Review: ${step.name}`,
          description: reviewContext || `Please review the following artifact:\n\n${artifact}`,
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject', requiresComment: true },
          ],
          workflowId,
          stepId,
          urgency,
          artifact,
        };

        response = await this.humanHandler.requestDecision(request, timeout);
      } else {
        // Simulation mode - auto-approve after a brief delay
        context.logger.warn('No human handler configured - simulating approval');
        await new Promise((resolve) => setTimeout(resolve, 100));
        response = {
          approved: true,
          respondedBy: 'simulated',
          respondedAt: new Date().toISOString(),
        };
      }

      // Check for cancellation
      this.checkCancellation(context);

      // Build output
      const output: HumancyReviewOutput = {
        approved: response.approved ?? (response.decision === 'approve'),
        comments: response.input,
        respondedBy: response.respondedBy,
        respondedAt: response.respondedAt,
        reviewId,
      };

      context.logger.info(
        `Human review [${reviewId}] completed: ${output.approved ? 'APPROVED' : 'REJECTED'}`
      );

      // Clear checkpoint on success
      await this.clearCheckpoint(workflowId);

      return this.successResult(output, {
        stdout: JSON.stringify(output, null, 2),
      });
    } catch (error) {
      // Handle timeout error
      if (error instanceof Error && error.name === 'CorrelationTimeoutError') {
        context.logger.error(`Human review [${reviewId}] timed out after ${timeout}ms`);
        return this.failureResult('Human review timed out', {
          output: {
            reviewId,
            error: 'timeout',
            timeoutMs: timeout,
          },
        });
      }

      // Handle cancellation
      if (error instanceof Error && error.message === 'Action cancelled') {
        context.logger.warn(`Human review [${reviewId}] was cancelled`);
        return this.failureResult('Human review cancelled', {
          output: {
            reviewId,
            error: 'cancelled',
          },
        });
      }

      // Handle other errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.logger.error(`Human review [${reviewId}] failed: ${errorMessage}`);

      return this.failureResult(`Human review failed: ${errorMessage}`, {
        output: {
          reviewId,
          error: errorMessage,
        },
      });
    }
  }

  /**
   * Save workflow checkpoint before waiting for human response
   */
  private async saveCheckpoint(
    workflowId: string,
    context: ActionContext,
    step: StepDefinition,
    reviewId: string,
    artifact: string
  ): Promise<void> {
    // Convert step outputs map to record
    const stepOutputs: Record<string, { raw: string; parsed: unknown; exitCode: number; completedAt: string }> = {};
    for (const [id, output] of context.stepOutputs) {
      stepOutputs[id] = {
        raw: output.raw,
        parsed: output.parsed,
        exitCode: output.exitCode,
        completedAt: output.completedAt.toISOString(),
      };
    }

    const state: WorkflowState = {
      version: '1.0',
      workflowId,
      workflowFile: 'unknown', // ExecutableWorkflow doesn't track source file
      currentPhase: context.phase.name,
      currentStep: step.name,
      inputs: { ...context.inputs },
      stepOutputs,
      pendingReview: {
        reviewId,
        artifact,
        requestedAt: new Date().toISOString(),
      },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.store.save(state);
      context.logger.debug(`Saved workflow checkpoint for review [${reviewId}]`);
    } catch (error) {
      context.logger.warn(
        `Failed to save workflow checkpoint: ${error instanceof Error ? error.message : String(error)}`
      );
      // Non-fatal - continue without checkpoint
    }
  }

  /**
   * Clear workflow checkpoint after successful completion
   */
  private async clearCheckpoint(workflowId: string): Promise<void> {
    try {
      await this.store.delete(workflowId);
    } catch {
      // Ignore errors when clearing checkpoint
    }
  }
}
