/**
 * Workflow executor with phase/step iteration.
 * Handles workflow execution with event emission and result tracking.
 * Integrates action handlers, variable interpolation, and retry logic.
 */
import type {
  ExecutableWorkflow,
  ExecutionOptions,
  ExecutionResult,
  ExecutionStatus,
  ExecutionEventListener,
  PhaseResult,
  StepResult,
  StepDefinition,
  PhaseDefinition,
  StepOutput,
  Logger,
  ActionContext,
  ActionResult,
} from '../types/index.js';
import { createLogger } from '../types/logger.js';
import {
  getActionHandler,
  registerBuiltinActions,
} from '../actions/index.js';
import { ExecutionContext, interpolate, interpolateValue } from '../interpolation/index.js';
import { RetryManager, withTimeout, type RetryState } from '../retry/index.js';
import { ExecutionEventEmitter } from './events.js';

// Ensure built-in actions are registered
let actionsRegistered = false;
function ensureActionsRegistered(): void {
  if (!actionsRegistered) {
    registerBuiltinActions();
    actionsRegistered = true;
  }
}

/**
 * Reset the actions registration state (for testing)
 */
export function resetActionsRegistration(): void {
  actionsRegistered = false;
}

/**
 * Executor options
 */
export interface ExecutorOptions {
  /** Logger for execution output */
  logger?: Logger;
}

/**
 * Workflow executor class
 */
export class WorkflowExecutor {
  private currentExecution: ExecutionResult | undefined;
  private eventEmitter = new ExecutionEventEmitter();
  private executionContext: ExecutionContext | undefined;
  private abortController: AbortController | undefined;
  private logger: Logger;

  constructor(options: ExecutorOptions = {}) {
    ensureActionsRegistered();
    this.logger = options.logger ?? createLogger('WorkflowExecutor');
  }

  /**
   * Get current execution status
   */
  public getStatus(): ExecutionStatus {
    return this.currentExecution?.status ?? 'idle';
  }

  /**
   * Check if currently executing
   */
  public isRunning(): boolean {
    return this.currentExecution?.status === 'running';
  }

  /**
   * Get current execution result
   */
  public getCurrentExecution(): ExecutionResult | undefined {
    return this.currentExecution;
  }

  /**
   * Get the execution context (for accessing step outputs)
   */
  public getExecutionContext(): ExecutionContext | undefined {
    return this.executionContext;
  }

  /**
   * Add event listener
   */
  public addEventListener(listener: ExecutionEventListener): { dispose: () => void } {
    return this.eventEmitter.addEventListener(listener);
  }

  /**
   * Execute a workflow
   */
  public async execute(
    workflow: ExecutableWorkflow,
    options: ExecutionOptions = { mode: 'normal' },
    inputs?: Record<string, unknown>
  ): Promise<ExecutionResult> {
    // Check if already running
    if (this.isRunning()) {
      throw new Error('A workflow is already running. Cancel it first.');
    }

    // Initialize execution context for variable interpolation
    this.executionContext = new ExecutionContext(
      inputs,
      { ...workflow.env, ...options.env }
    );

    // Initialize execution result
    this.currentExecution = {
      workflowName: workflow.name,
      status: 'running',
      mode: options.mode,
      startTime: Date.now(),
      phaseResults: [],
      env: { ...workflow.env, ...options.env },
    };

    // Create abort controller
    this.abortController = new AbortController();

    // Emit start event
    this.eventEmitter.emitEvent('execution:start', workflow.name, {
      message: `Starting workflow: ${workflow.name}`,
    });

    // Log start
    this.logger.info(`Starting workflow: ${workflow.name} (mode: ${options.mode})`);

    if (options.mode === 'dry-run') {
      this.logger.info('DRY-RUN MODE: No actions will be executed');
    }

    try {
      // Find starting phase
      let startPhaseIndex = 0;
      if (options.startPhase) {
        const index = workflow.phases.findIndex(p => p.name === options.startPhase);
        if (index >= 0) {
          startPhaseIndex = index;
        }
      }

      // Execute phases
      for (let i = startPhaseIndex; i < workflow.phases.length; i++) {
        if (this.abortController.signal.aborted) {
          this.currentExecution.status = 'cancelled';
          break;
        }

        const phase = workflow.phases[i];
        if (!phase) {
          continue;
        }

        const phaseResult = await this.executePhase(
          workflow,
          phase,
          i,
          workflow.phases.length,
          options,
          i === startPhaseIndex ? options.startStep : undefined
        );

        this.currentExecution.phaseResults.push(phaseResult);

        // Stop if phase failed and not continuing on error
        if (phaseResult.status === 'failed') {
          this.currentExecution.status = 'failed';
          break;
        }
      }

      // Set final status if not already set
      if (this.currentExecution.status === 'running') {
        this.currentExecution.status = 'completed';
      }

    } catch (error) {
      this.currentExecution.status = 'failed';
      this.eventEmitter.emitEvent('execution:error', workflow.name, {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Finalize execution
    this.currentExecution.endTime = Date.now();
    this.currentExecution.duration = this.currentExecution.endTime - this.currentExecution.startTime;

    // Log completion
    this.logger.info(
      `Workflow ${this.currentExecution.status}: ${workflow.name} (${this.currentExecution.duration}ms)`
    );

    // Emit completion event
    this.eventEmitter.emitEvent(
      this.currentExecution.status === 'completed' ? 'execution:complete' : 'execution:error',
      workflow.name,
      {
        message: `Workflow ${this.currentExecution.status}: ${workflow.name}`,
        data: this.currentExecution,
      }
    );

    // Cleanup
    this.abortController = undefined;

    return this.currentExecution;
  }

  /**
   * Execute a single phase
   */
  public async executePhase(
    workflow: ExecutableWorkflow,
    phase: PhaseDefinition,
    phaseIndex: number,
    totalPhases: number,
    options: ExecutionOptions,
    startStep?: string
  ): Promise<PhaseResult> {
    const result: PhaseResult = {
      phaseName: phase.name,
      status: 'running',
      startTime: Date.now(),
      stepResults: [],
    };

    // Log phase start
    this.logger.info(`Phase [${phaseIndex + 1}/${totalPhases}]: ${phase.name}`);

    // Emit phase start event
    this.eventEmitter.emitEvent('phase:start', workflow.name, {
      phaseName: phase.name,
      message: `Starting phase: ${phase.name}`,
    });

    // Check phase condition
    if (phase.condition && options.mode !== 'dry-run') {
      const shouldRun = await this.evaluateCondition(phase.condition, options);
      if (!shouldRun) {
        result.status = 'skipped';
        result.endTime = Date.now();
        result.duration = 0;
        this.logger.info(`Phase "${phase.name}" skipped: condition not met`);
        return result;
      }
    }

    try {
      // Find starting step
      let startStepIndex = 0;
      if (startStep) {
        const index = phase.steps.findIndex(s => s.name === startStep);
        if (index >= 0) {
          startStepIndex = index;
        }
      }

      // Execute steps
      for (let i = startStepIndex; i < phase.steps.length; i++) {
        if (this.abortController?.signal.aborted) {
          result.status = 'failed';
          break;
        }

        const step = phase.steps[i];
        if (!step) {
          continue;
        }

        const stepResult = await this.executeStep(
          workflow,
          phase,
          step,
          i,
          phase.steps.length,
          options
        );

        result.stepResults.push(stepResult);

        // Stop if step failed and not continuing on error
        if (stepResult.status === 'failed' && !step.continueOnError) {
          result.status = 'failed';
          break;
        }
      }

      // Set final status if not already set
      if (result.status === 'running') {
        result.status = 'completed';
      }

    } catch (error) {
      result.status = 'failed';
      this.eventEmitter.emitEvent('phase:error', workflow.name, {
        phaseName: phase.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Finalize phase
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    // Log phase completion
    this.logger.info(
      `Phase ${result.status}: ${phase.name} (${result.duration}ms)`
    );

    // Emit phase completion event
    this.eventEmitter.emitEvent(
      result.status === 'completed' ? 'phase:complete' : 'phase:error',
      workflow.name,
      {
        phaseName: phase.name,
        message: `Phase ${result.status}: ${phase.name}`,
        data: result,
      }
    );

    return result;
  }

  /**
   * Execute a single step using action handlers
   */
  public async executeStep(
    workflow: ExecutableWorkflow,
    phase: PhaseDefinition,
    step: StepDefinition,
    stepIndex: number,
    totalSteps: number,
    options: ExecutionOptions
  ): Promise<StepResult> {
    const result: StepResult = {
      stepName: step.name,
      phaseName: phase.name,
      status: 'running',
      startTime: Date.now(),
    };

    // Log step start
    this.logger.info(`  Step [${stepIndex + 1}/${totalSteps}]: ${step.name}`);

    // Emit step start event
    this.eventEmitter.emitEvent('step:start', workflow.name, {
      phaseName: phase.name,
      stepName: step.name,
      message: `Starting step: ${step.name}`,
    });

    // Check step condition
    if (step.condition && options.mode !== 'dry-run') {
      const shouldRun = await this.evaluateCondition(step.condition, options);
      if (!shouldRun) {
        result.status = 'skipped';
        result.endTime = Date.now();
        result.duration = 0;
        this.logger.info(`    Step "${step.name}" skipped: condition not met`);
        return result;
      }
    }

    // For dry-run mode, don't actually execute
    if (options.mode === 'dry-run') {
      result.status = 'completed';
      result.output = `[DRY-RUN] Would execute step: ${step.name}`;
      result.endTime = Date.now();
      result.duration = result.endTime - result.startTime;
      this.logger.info(`    [DRY-RUN] Would execute: ${step.name}`);
      return result;
    }

    try {
      // Interpolate step configuration
      const interpolatedStep = this.interpolateStep(step);

      // Get action handler for this step
      const handler = getActionHandler(interpolatedStep);

      if (handler) {
        // Execute using action handler
        const actionResult = await this.executeWithActionHandler(
          workflow,
          phase,
          interpolatedStep,
          handler,
          options
        );

        result.output = typeof actionResult.output === 'string'
          ? actionResult.output
          : JSON.stringify(actionResult.output);
        result.exitCode = actionResult.exitCode;
        result.error = actionResult.error;
        result.status = actionResult.success ? 'completed' : 'failed';

        // Store step output for interpolation
        this.storeStepOutput(step.name, actionResult);

        // Emit output if available
        if (actionResult.stdout) {
          this.eventEmitter.emitEvent('step:output', workflow.name, {
            phaseName: phase.name,
            stepName: step.name,
            message: actionResult.stdout,
          });
        }
      } else {
        // No handler found - fail
        result.status = 'failed';
        result.error = `No action handler found for step "${step.name}"`;
        this.logger.error(`    No action handler found for step: ${step.name}`);
      }

    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }

    // Finalize step
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    // Log step completion
    this.logger.info(
      `    Step ${result.status}: ${step.name} (${result.duration}ms)`
    );

    // Emit step completion event
    this.eventEmitter.emitEvent(
      result.status === 'completed' ? 'step:complete' : 'step:error',
      workflow.name,
      {
        phaseName: phase.name,
        stepName: step.name,
        message: `Step ${result.status}: ${step.name}`,
        data: result,
      }
    );

    return result;
  }

  /**
   * Execute step using action handler with retry logic
   */
  private async executeWithActionHandler(
    workflow: ExecutableWorkflow,
    phase: PhaseDefinition,
    step: StepDefinition,
    handler: ReturnType<typeof getActionHandler>,
    options: ExecutionOptions
  ): Promise<ActionResult> {
    if (!handler) {
      return {
        success: false,
        output: null,
        error: 'No action handler found',
        duration: 0,
      };
    }

    // Create action context
    const context = this.createActionContext(workflow, phase, step, options);

    // Emit action start event
    this.eventEmitter.emitEvent('action:start', workflow.name, {
      phaseName: phase.name,
      stepName: step.name,
      message: `Starting action [${handler.type}]`,
    });

    // Create retry manager with event callback
    const retryManager = RetryManager.fromStep(step, (state: RetryState, error: Error) => {
      this.eventEmitter.emitEvent('action:retry', workflow.name, {
        phaseName: phase.name,
        stepName: step.name,
        message: `Retrying action (attempt ${state.attempt + 1}): ${error.message}`,
        data: state,
      });
    });

    // Default timeout: 5 minutes (300000ms)
    const DEFAULT_STEP_TIMEOUT = 300000;
    const stepTimeout = step.timeout ?? DEFAULT_STEP_TIMEOUT;

    // Execute with retry and timeout wrapper
    const retryResult = await withTimeout(
      retryManager.executeWithRetry(handler, step, context),
      stepTimeout,
      context.signal
    );

    // Emit action completion event
    this.eventEmitter.emitEvent(
      retryResult.result.success ? 'action:complete' : 'action:error',
      workflow.name,
      {
        phaseName: phase.name,
        stepName: step.name,
        message: retryResult.result.success
          ? `Action [${handler.type}] completed`
          : `Action [${handler.type}] failed: ${retryResult.result.error}`,
        data: {
          attempts: retryResult.attempts,
          totalDuration: retryResult.totalDuration,
        },
      }
    );

    return retryResult.result;
  }

  /**
   * Create action context for step execution
   */
  private createActionContext(
    workflow: ExecutableWorkflow,
    phase: PhaseDefinition,
    step: StepDefinition,
    options: ExecutionOptions
  ): ActionContext {
    // Create logger for actions
    const actionLogger: Logger = {
      info: (msg: string) => this.logger.info(`      ${msg}`),
      warn: (msg: string) => this.logger.warn(`      ${msg}`),
      error: (msg: string) => this.logger.error(`      ${msg}`),
      debug: (msg: string) => this.logger.debug(`      ${msg}`),
    };

    return {
      workflow,
      phase,
      step,
      inputs: this.executionContext?.getInputs() ?? {},
      stepOutputs: this.executionContext?.getAllStepOutputs() ?? new Map(),
      env: { ...workflow.env, ...options.env, ...step.env },
      workdir: options.cwd ?? process.cwd(),
      signal: this.abortController?.signal ?? new AbortController().signal,
      logger: actionLogger,
    };
  }

  /**
   * Interpolate variables in step configuration
   */
  private interpolateStep(step: StepDefinition): StepDefinition {
    if (!this.executionContext) {
      return step;
    }

    const context = this.executionContext.getInterpolationContext();

    // Deep clone and interpolate
    const interpolated = { ...step };

    if (interpolated.command) {
      interpolated.command = interpolate(interpolated.command, context);
    }

    if (interpolated.script) {
      interpolated.script = interpolate(interpolated.script, context);
    }

    if (interpolated.with) {
      interpolated.with = interpolateValue(interpolated.with, context) as Record<string, unknown>;
    }

    if (interpolated.env) {
      interpolated.env = interpolateValue(interpolated.env, context) as Record<string, string>;
    }

    return interpolated;
  }

  /**
   * Store step output in execution context
   */
  private storeStepOutput(
    stepId: string,
    result: ActionResult
  ): void {
    if (!this.executionContext) {
      return;
    }

    const raw = result.stdout ?? (typeof result.output === 'string' ? result.output : JSON.stringify(result.output));

    // Try to parse output as JSON
    let parsed: unknown = null;
    if (typeof result.output === 'object') {
      parsed = result.output;
    } else if (typeof result.output === 'string') {
      try {
        parsed = JSON.parse(result.output);
      } catch {
        parsed = null;
      }
    }

    const stepOutput: StepOutput = {
      raw,
      parsed,
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      completedAt: new Date(),
    };

    this.executionContext.setStepOutput(stepId, stepOutput);
  }

  /**
   * Cancel the current execution
   */
  public cancel(): void {
    if (this.isRunning()) {
      this.abortController?.abort();
      if (this.currentExecution) {
        this.currentExecution.status = 'cancelled';
      }
      this.eventEmitter.emitEvent('execution:cancel', this.currentExecution?.workflowName ?? 'unknown', {
        message: 'Execution cancelled by user',
      });
    }
  }

  /**
   * Validate a workflow without executing (dry-run)
   */
  public async validate(
    workflow: ExecutableWorkflow,
    env?: Record<string, string>
  ): Promise<ExecutionResult> {
    return this.execute(workflow, { mode: 'dry-run', env });
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.cancel();
    this.eventEmitter.removeAllListeners();
    this.currentExecution = undefined;
    this.executionContext = undefined;
  }

  /**
   * Evaluate a condition expression using interpolation context
   */
  private async evaluateCondition(
    condition: string,
    options: ExecutionOptions
  ): Promise<boolean> {
    try {
      let evaluated = condition;

      // Use interpolation context if available
      if (this.executionContext) {
        const context = this.executionContext.getInterpolationContext();
        evaluated = interpolate(condition, context);
      } else {
        // Fall back to simple environment variable replacement
        for (const [key, value] of Object.entries(options.env ?? {})) {
          evaluated = evaluated.replace(new RegExp(`\\$\\{?${key}\\}?`, 'g'), value);
        }
      }

      // Handle function calls
      if (evaluated.includes('success()')) {
        const result = this.executionContext?.getInterpolationContext().functions.success() ?? true;
        evaluated = evaluated.replace(/success\(\)/g, String(result));
      }
      if (evaluated.includes('failure()')) {
        const result = this.executionContext?.getInterpolationContext().functions.failure() ?? false;
        evaluated = evaluated.replace(/failure\(\)/g, String(result));
      }
      if (evaluated.includes('always()')) {
        evaluated = evaluated.replace(/always\(\)/g, 'true');
      }

      // Simple truthy evaluation
      if (evaluated === 'true' || evaluated === '1') {
        return true;
      }
      if (evaluated === 'false' || evaluated === '0' || evaluated === '') {
        return false;
      }

      // Default to true for non-empty strings
      return evaluated.trim().length > 0;
    } catch {
      return true; // Default to running on evaluation error
    }
  }
}

// Re-export events
export { ExecutionEventEmitter, createExecutionEvent } from './events.js';
