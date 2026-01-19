/**
 * Workflow Runtime
 *
 * Single workflow execution runtime. Manages state machine transitions
 * and coordinates step execution.
 */

import type {
  WorkflowStep,
  ConditionalNext,
} from '../types/WorkflowDefinition.js';
import type {
  WorkflowState,
  WorkflowStatus,
  StepResult,
  StepError,
} from '../types/WorkflowState.js';
import type { WorkflowContext } from '../types/WorkflowContext.js';
import type {
  ErrorAction,
  ErrorHandler,
} from '../types/ErrorHandler.js';
import { defaultErrorHandler, isRetryAction, isAbortAction, isSkipAction, isFallbackAction, isEscalateAction } from '../types/ErrorHandler.js';
import { WorkflowEventEmitter } from '../events/WorkflowEventEmitter.js';
import { evaluateExpression } from '../utils/PropertyPathParser.js';
import type {
  WorkflowCompletedPayload,
  WorkflowFailedPayload,
  StepCompletedPayload,
  StepFailedPayload,
  StepWaitingPayload,
} from '../types/WorkflowEvent.js';
import { isHumanStepConfig, isConditionConfig } from '../types/WorkflowDefinition.js';

/**
 * Step executor function type.
 * Implementations are provided externally to allow different execution strategies.
 */
export type StepExecutor = (
  step: WorkflowStep,
  context: WorkflowContext,
  runtime: WorkflowRuntime
) => Promise<StepExecutionResult>;

/**
 * Result of executing a step
 */
export interface StepExecutionResult {
  /** Whether the step completed successfully */
  success: boolean;

  /** Output data from the step */
  output?: unknown;

  /** Error if step failed */
  error?: StepError;

  /** Whether the workflow should wait (for human steps) */
  waiting?: boolean;

  /** Optional override for next step ID */
  nextStepId?: string;
}

/**
 * Options for creating a workflow runtime
 */
export interface WorkflowRuntimeOptions {
  /** Event emitter for workflow events */
  eventEmitter?: WorkflowEventEmitter;

  /** Error handler for step failures */
  errorHandler?: ErrorHandler;

  /** Step executor function */
  stepExecutor?: StepExecutor;

  /** Default step timeout in milliseconds */
  defaultStepTimeout?: number;
}

/**
 * Default step executor that simulates step completion.
 * In production, this would be replaced with actual step execution logic.
 */
const defaultStepExecutor: StepExecutor = async (step, context) => {
  // Check if this is a human step that should wait
  if (step.type === 'human' && isHumanStepConfig(step.config)) {
    return {
      success: true,
      waiting: true,
      output: { action: step.config.action },
    };
  }

  // Check if this is a condition step
  if (step.type === 'condition' && isConditionConfig(step.config)) {
    const result = evaluateExpression(step.config.expression, context);
    return {
      success: true,
      output: { evaluated: result.result },
      nextStepId: result.result ? step.config.then : step.config.else,
    };
  }

  // Default: simulate successful completion
  return {
    success: true,
    output: { stepId: step.id, type: step.type },
  };
};

/**
 * Single workflow execution runtime.
 * Manages the state machine and step execution for one workflow instance.
 */
export class WorkflowRuntime {
  private state: WorkflowState;
  private eventEmitter: WorkflowEventEmitter;
  private errorHandler: ErrorHandler;
  private stepExecutor: StepExecutor;
  private defaultStepTimeout: number;
  private stepTimeoutHandle?: ReturnType<typeof setTimeout>;

  constructor(state: WorkflowState, options: WorkflowRuntimeOptions = {}) {
    this.state = state;
    this.eventEmitter = options.eventEmitter ?? new WorkflowEventEmitter();
    this.errorHandler = options.errorHandler ?? defaultErrorHandler;
    this.stepExecutor = options.stepExecutor ?? defaultStepExecutor;
    this.defaultStepTimeout = options.defaultStepTimeout ?? 300000; // 5 minutes
  }

  /**
   * Get the current workflow state.
   */
  getState(): WorkflowState {
    return this.state;
  }

  /**
   * Get the workflow ID.
   */
  get id(): string {
    return this.state.id;
  }

  /**
   * Get the current workflow status.
   */
  get status(): WorkflowStatus {
    return this.state.status;
  }

  /**
   * Get the current step ID.
   */
  get currentStepId(): string | null {
    return this.state.currentStepId;
  }

  /**
   * Get the workflow context.
   */
  get context(): WorkflowContext {
    return this.state.context;
  }

  /**
   * Start the workflow execution.
   */
  async start(): Promise<void> {
    if (this.state.status !== 'created') {
      throw new Error(`Cannot start workflow in ${this.state.status} state`);
    }

    const firstStep = this.state.definition.steps[0];
    if (!firstStep) {
      throw new Error('Workflow has no steps');
    }

    this.state.status = 'running';
    this.state.currentStepId = firstStep.id;
    this.state.startedAt = new Date().toISOString();
    this.updateTimestamp();

    this.eventEmitter.emitEvent('workflow:started', this.id, this.state.definitionName, {
      firstStepId: firstStep.id,
    });
  }

  /**
   * Execute the current step and advance to the next.
   * Returns when the step completes, fails, or workflow enters waiting state.
   */
  async executeStep(): Promise<void> {
    if (this.state.status !== 'running') {
      throw new Error(`Cannot execute step in ${this.state.status} state`);
    }

    const step = this.getCurrentStep();
    if (!step) {
      await this.complete();
      return;
    }

    const startedAt = new Date().toISOString();
    this.eventEmitter.emitEvent('step:started', this.id, this.state.definitionName, {
      stepId: step.id,
      stepType: step.type,
    });

    // Initialize step attempts if needed
    const currentAttempts = this.state.stepAttempts[step.id] ?? 0;
    this.state.stepAttempts[step.id] = currentAttempts + 1;

    try {
      // Set up timeout
      const timeout = step.timeout ?? this.state.definition.timeout ?? this.defaultStepTimeout;
      const timeoutPromise = this.createTimeout(timeout, step.id);

      // Execute step with timeout
      const result = await Promise.race([
        this.stepExecutor(step, this.state.context, this),
        timeoutPromise,
      ]);

      this.clearTimeout();

      if (!result.success) {
        await this.handleStepError(step, result.error ?? { code: 'STEP_FAILED', message: 'Step failed' }, startedAt);
        return;
      }

      // Record step result
      const completedAt = new Date().toISOString();
      const stepResult: StepResult = {
        stepId: step.id,
        success: true,
        output: result.output,
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      };
      this.state.stepResults[step.id] = stepResult;

      this.eventEmitter.emitEvent<StepCompletedPayload>('step:completed', this.id, this.state.definitionName, {
        stepId: step.id,
        stepType: step.type,
        durationMs: stepResult.durationMs,
        output: result.output,
      });

      // Check if workflow should wait (human step)
      if (result.waiting) {
        this.state.status = 'waiting';
        if (step.type === 'human' && isHumanStepConfig(step.config)) {
          this.eventEmitter.emitEvent<StepWaitingPayload>('step:waiting', this.id, this.state.definitionName, {
            stepId: step.id,
            action: step.config.action,
            urgency: step.config.urgency,
            prompt: step.config.prompt,
          });
        }
        this.updateTimestamp();
        return;
      }

      // Advance to next step
      const nextStepId = result.nextStepId ?? this.determineNextStep(step);
      if (nextStepId) {
        this.state.currentStepId = nextStepId;
        this.updateTimestamp();
      } else {
        await this.complete();
      }
    } catch (error) {
      this.clearTimeout();
      const stepError: StepError = {
        code: 'STEP_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      await this.handleStepError(step, stepError, startedAt);
    }
  }

  /**
   * Run the workflow until completion, waiting state, or failure.
   */
  async run(): Promise<void> {
    if (this.state.status === 'created') {
      await this.start();
    }

    while (this.state.status === 'running') {
      await this.executeStep();
    }
  }

  /**
   * Pause the workflow execution.
   */
  async pause(): Promise<void> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting') {
      throw new Error(`Cannot pause workflow in ${this.state.status} state`);
    }

    this.state.status = 'paused';
    this.updateTimestamp();

    this.eventEmitter.emitEvent('workflow:paused', this.id, this.state.definitionName, {
      currentStepId: this.state.currentStepId,
    });
  }

  /**
   * Resume the workflow execution.
   */
  async resume(): Promise<void> {
    if (this.state.status !== 'paused' && this.state.status !== 'waiting') {
      throw new Error(`Cannot resume workflow in ${this.state.status} state`);
    }

    this.state.status = 'running';
    this.updateTimestamp();

    this.eventEmitter.emitEvent('workflow:resumed', this.id, this.state.definitionName, {
      resumeStepId: this.state.currentStepId,
    });
  }

  /**
   * Provide input for a waiting (human) step and advance.
   */
  async provideInput(input: unknown): Promise<void> {
    if (this.state.status !== 'waiting') {
      throw new Error(`Cannot provide input in ${this.state.status} state`);
    }

    const step = this.getCurrentStep();
    if (!step) {
      throw new Error('No current step to provide input to');
    }

    // Store the input in context
    this.state.context.outputs[step.id] = input;

    // Resume and advance to next step
    this.state.status = 'running';
    const nextStepId = this.determineNextStep(step);
    if (nextStepId) {
      this.state.currentStepId = nextStepId;
      this.updateTimestamp();
    } else {
      await this.complete();
    }
  }

  /**
   * Cancel the workflow execution.
   */
  async cancel(reason?: string): Promise<void> {
    if (this.state.status === 'completed' || this.state.status === 'failed' || this.state.status === 'cancelled') {
      throw new Error(`Cannot cancel workflow in ${this.state.status} state`);
    }

    this.clearTimeout();
    this.state.status = 'cancelled';
    this.state.completedAt = new Date().toISOString();
    this.updateTimestamp();

    this.eventEmitter.emitEvent('workflow:cancelled', this.id, this.state.definitionName, {
      reason,
      currentStepId: this.state.currentStepId,
    });
  }

  /**
   * Get the current step definition.
   */
  private getCurrentStep(): WorkflowStep | undefined {
    if (!this.state.currentStepId) {
      return undefined;
    }
    return this.state.definition.steps.find((s) => s.id === this.state.currentStepId);
  }

  /**
   * Determine the next step ID based on step configuration.
   */
  private determineNextStep(step: WorkflowStep): string | undefined {
    if (!step.next) {
      return undefined;
    }

    if (typeof step.next === 'string') {
      return step.next;
    }

    // Evaluate conditional next
    for (const conditional of step.next as ConditionalNext[]) {
      const result = evaluateExpression(conditional.condition, this.state.context);
      if (result.result) {
        return conditional.stepId;
      }
    }

    return undefined;
  }

  /**
   * Handle a step error according to the error handler configuration.
   */
  private async handleStepError(step: WorkflowStep, error: StepError, startedAt: string): Promise<void> {
    const completedAt = new Date().toISOString();

    // Record step result
    const stepResult: StepResult = {
      stepId: step.id,
      success: false,
      error,
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    };
    this.state.stepResults[step.id] = stepResult;

    this.eventEmitter.emitEvent<StepFailedPayload>('step:failed', this.id, this.state.definitionName, {
      stepId: step.id,
      stepType: step.type,
      error,
    });

    // Determine error action
    const stepError = new Error(error.message);
    const handler = this.state.definition.onError ?? this.errorHandler;
    const action: ErrorAction = handler.onError(stepError, step, this.state.context);

    await this.executeErrorAction(action, step, error);
  }

  /**
   * Execute the error action determined by the error handler.
   */
  private async executeErrorAction(action: ErrorAction, step: WorkflowStep, error: StepError): Promise<void> {
    if (isRetryAction(action)) {
      const maxAttempts = action.maxAttempts ?? step.retries ?? 3;
      const attempts = this.state.stepAttempts[step.id] ?? 0;

      if (attempts < maxAttempts) {
        // Retry with delay
        if (action.delay) {
          await new Promise((resolve) => setTimeout(resolve, action.delay));
        }
        this.updateTimestamp();
        // Stay on current step for retry
        return;
      }
      // Max retries exceeded, fall through to abort
    }

    if (isSkipAction(action)) {
      // Skip this step and move to next
      const nextStepId = this.determineNextStep(step);
      if (nextStepId) {
        this.state.currentStepId = nextStepId;
        this.updateTimestamp();
      } else {
        await this.complete();
      }
      return;
    }

    if (isFallbackAction(action)) {
      // Jump to fallback step
      this.state.currentStepId = action.stepId;
      this.updateTimestamp();
      return;
    }

    if (isEscalateAction(action)) {
      // Enter waiting state for human intervention
      this.state.status = 'waiting';
      this.eventEmitter.emitEvent<StepWaitingPayload>('step:waiting', this.id, this.state.definitionName, {
        stepId: step.id,
        action: 'decide',
        urgency: action.urgency,
        prompt: action.message ?? `Error in step ${step.id}: ${error.message}`,
      });
      this.updateTimestamp();
      return;
    }

    // Default: abort (also handles explicit abort action)
    const reason = isAbortAction(action) ? action.reason : error.message;
    await this.fail(error, reason);
  }

  /**
   * Complete the workflow successfully.
   */
  private async complete(): Promise<void> {
    this.state.status = 'completed';
    this.state.currentStepId = null;
    this.state.completedAt = new Date().toISOString();
    this.updateTimestamp();

    const startedAt = this.state.startedAt ? new Date(this.state.startedAt).getTime() : Date.now();
    const completedAt = new Date(this.state.completedAt).getTime();

    this.eventEmitter.emitEvent<WorkflowCompletedPayload>('workflow:completed', this.id, this.state.definitionName, {
      durationMs: completedAt - startedAt,
      stepsCompleted: Object.keys(this.state.stepResults).length,
    });
  }

  /**
   * Fail the workflow with an error.
   */
  private async fail(error: StepError, reason: string): Promise<void> {
    this.state.status = 'failed';
    this.state.completedAt = new Date().toISOString();
    this.state.error = {
      code: error.code,
      message: reason,
      stepId: this.state.currentStepId ?? undefined,
      stack: error.stack,
    };
    this.updateTimestamp();

    this.eventEmitter.emitEvent<WorkflowFailedPayload>('workflow:failed', this.id, this.state.definitionName, {
      error: this.state.error,
      stepId: this.state.currentStepId ?? undefined,
    });
  }

  /**
   * Create a timeout promise for step execution.
   */
  private createTimeout(ms: number, stepId: string): Promise<StepExecutionResult> {
    return new Promise((_, reject) => {
      this.stepTimeoutHandle = setTimeout(() => {
        reject(new Error(`Step ${stepId} timed out after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * Clear the step timeout.
   */
  private clearTimeout(): void {
    if (this.stepTimeoutHandle) {
      clearTimeout(this.stepTimeoutHandle);
      this.stepTimeoutHandle = undefined;
    }
  }

  /**
   * Update the state timestamp.
   */
  private updateTimestamp(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}
