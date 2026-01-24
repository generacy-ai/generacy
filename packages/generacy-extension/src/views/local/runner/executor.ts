/**
 * Workflow executor with phase/step iteration.
 * Handles local workflow execution with event emission and result tracking.
 * Integrates action handlers, variable interpolation, and retry logic.
 */
import * as vscode from 'vscode';
import type {
  ExecutableWorkflow,
  ExecutionOptions,
  ExecutionResult,
  ExecutionStatus,
  ExecutionEvent,
  ExecutionEventListener,
  PhaseResult,
  StepResult,
  WorkflowPhase,
  WorkflowStep,
} from './types';
import { getRunnerOutputChannel } from './output-channel';
import { getWorkflowTerminal } from './terminal';
import {
  getActionHandler,
  registerBuiltinActions,
  type ActionContext,
  type ActionLogger,
  type ActionResult,
  type StepOutput,
} from './actions';
import { ExecutionContext, interpolate, interpolateValue } from './interpolation';
import { RetryManager, withTimeout, type RetryState } from './retry';
import { getDebugHooks, DebugHooks, type StepState } from './debug-integration';

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
 * Workflow executor class
 */
export class WorkflowExecutor {
  private static instance: WorkflowExecutor | undefined;
  private currentExecution: ExecutionResult | undefined;
  private listeners: Set<ExecutionEventListener> = new Set();
  private cancellationToken: vscode.CancellationTokenSource | undefined;
  private executionContext: ExecutionContext | undefined;
  private abortController: AbortController | undefined;

  private constructor() {
    ensureActionsRegistered();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WorkflowExecutor {
    if (!WorkflowExecutor.instance) {
      WorkflowExecutor.instance = new WorkflowExecutor();
    }
    return WorkflowExecutor.instance;
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
  public addEventListener(listener: ExecutionEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
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

    const outputChannel = getRunnerOutputChannel();

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

    // Create cancellation token and abort controller
    this.cancellationToken = new vscode.CancellationTokenSource();
    this.abortController = new AbortController();

    // Link VS Code cancellation to AbortController
    this.cancellationToken.token.onCancellationRequested(() => {
      this.abortController?.abort();
    });

    // Emit start event
    this.emitEvent({
      type: 'execution:start',
      timestamp: Date.now(),
      workflowName: workflow.name,
      message: `Starting workflow: ${workflow.name}`,
    });

    // Write to output channel
    outputChannel.writeExecutionStart(workflow.name, options.mode);

    if (options.mode === 'dry-run') {
      outputChannel.writeDryRunNotice();
    }

    // Write environment variables
    outputChannel.writeEnvironment(this.currentExecution.env);

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
        if (this.cancellationToken.token.isCancellationRequested) {
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
        if (phaseResult.status === 'failed' && !this.shouldContinueAfterFailure(phase)) {
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
      this.emitEvent({
        type: 'execution:error',
        timestamp: Date.now(),
        workflowName: workflow.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Finalize execution
    this.currentExecution.endTime = Date.now();
    this.currentExecution.duration = this.currentExecution.endTime - this.currentExecution.startTime;

    // Write completion to output channel
    outputChannel.writeExecutionComplete(
      workflow.name,
      this.currentExecution.duration,
      this.currentExecution.status === 'completed'
    );

    // Emit completion event
    this.emitEvent({
      type: this.currentExecution.status === 'completed' ? 'execution:complete' : 'execution:error',
      timestamp: Date.now(),
      workflowName: workflow.name,
      message: `Workflow ${this.currentExecution.status}: ${workflow.name}`,
      data: this.currentExecution,
    });

    // Cleanup
    this.cancellationToken.dispose();
    this.cancellationToken = undefined;
    this.abortController = undefined;

    return this.currentExecution;
  }

  /**
   * Execute a single phase
   */
  public async executePhase(
    workflow: ExecutableWorkflow,
    phase: WorkflowPhase,
    phaseIndex: number,
    totalPhases: number,
    options: ExecutionOptions,
    startStep?: string
  ): Promise<PhaseResult> {
    const outputChannel = getRunnerOutputChannel();
    const result: PhaseResult = {
      phaseName: phase.name,
      status: 'running',
      startTime: Date.now(),
      stepResults: [],
    };

    // Write phase start
    outputChannel.writePhaseStart(phase.name, phaseIndex, totalPhases);

    // Emit phase start event
    this.emitEvent({
      type: 'phase:start',
      timestamp: Date.now(),
      workflowName: workflow.name,
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
        outputChannel.info(`Phase "${phase.name}" skipped: condition not met`);
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
        if (this.cancellationToken?.token.isCancellationRequested) {
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
      this.emitEvent({
        type: 'phase:error',
        timestamp: Date.now(),
        workflowName: workflow.name,
        phaseName: phase.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Finalize phase
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    // Write phase completion
    outputChannel.writePhaseComplete(
      phase.name,
      result.duration,
      result.status === 'completed'
    );

    // Emit phase completion event
    this.emitEvent({
      type: result.status === 'completed' ? 'phase:complete' : 'phase:error',
      timestamp: Date.now(),
      workflowName: workflow.name,
      phaseName: phase.name,
      message: `Phase ${result.status}: ${phase.name}`,
      data: result,
    });

    return result;
  }

  /**
   * Execute a single step using action handlers
   */
  public async executeStep(
    workflow: ExecutableWorkflow,
    phase: WorkflowPhase,
    step: WorkflowStep,
    stepIndex: number,
    totalSteps: number,
    options: ExecutionOptions
  ): Promise<StepResult> {
    const outputChannel = getRunnerOutputChannel();

    const result: StepResult = {
      stepName: step.name,
      phaseName: phase.name,
      status: 'running',
      startTime: Date.now(),
    };

    // Write step start
    outputChannel.writeStepStart(step.name, stepIndex, totalSteps);

    // Emit step start event
    this.emitEvent({
      type: 'step:start',
      timestamp: Date.now(),
      workflowName: workflow.name,
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
        outputChannel.writeStepSkipped(step.name, 'condition not met');
        return result;
      }
    }

    // For dry-run mode, don't actually execute
    if (options.mode === 'dry-run') {
      result.status = 'completed';
      result.output = `[DRY-RUN] Would execute step: ${step.name}`;
      result.endTime = Date.now();
      result.duration = result.endTime - result.startTime;
      outputChannel.writeStepComplete(step.name, result.duration, true);
      return result;
    }

    // Create step state for debug hooks
    const stepState: StepState = DebugHooks.createStepState(step, phase.name, stepIndex);
    stepState.startTime = result.startTime;

    // Call debug hook before step execution (may pause at breakpoint)
    const debugHooks = getDebugHooks();
    await debugHooks.beforeStep(stepState);

    // Track action result for debug hooks
    let actionResultForHooks: ActionResult | undefined;

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

        // Store for debug hooks
        actionResultForHooks = actionResult;

        result.output = typeof actionResult.output === 'string'
          ? actionResult.output
          : JSON.stringify(actionResult.output);
        result.exitCode = actionResult.exitCode;
        result.error = actionResult.error;
        result.status = actionResult.success ? 'completed' : 'failed';

        // Store step output for interpolation
        this.storeStepOutput(step.name, actionResult);

        // Write output
        if (actionResult.stdout) {
          outputChannel.writeStepOutput(actionResult.stdout);
          this.emitEvent({
            type: 'step:output',
            timestamp: Date.now(),
            workflowName: workflow.name,
            phaseName: phase.name,
            stepName: step.name,
            message: actionResult.stdout,
          });
        }
      } else {
        // Fall back to terminal execution for unrecognized actions
        const terminal = getWorkflowTerminal();
        const terminalResult = await terminal.executeStepWithCapture(interpolatedStep, {
          ...options,
          env: { ...options.env, ...step.env },
        });

        result.output = terminalResult.output;
        result.exitCode = terminalResult.exitCode;
        result.error = terminalResult.error;

        // Create action result for debug hooks from terminal result
        actionResultForHooks = {
          success: terminalResult.exitCode === 0,
          output: terminalResult.output,
          stdout: terminalResult.output,
          exitCode: terminalResult.exitCode,
          duration: 0,
        };

        // Store step output
        this.storeStepOutput(step.name, actionResultForHooks);

        // Write output
        if (terminalResult.output) {
          outputChannel.writeStepOutput(terminalResult.output);
          this.emitEvent({
            type: 'step:output',
            timestamp: Date.now(),
            workflowName: workflow.name,
            phaseName: phase.name,
            stepName: step.name,
            message: terminalResult.output,
          });
        }

        // Determine status
        if (terminalResult.error || (terminalResult.exitCode !== undefined && terminalResult.exitCode !== 0)) {
          result.status = 'failed';
        } else {
          result.status = 'completed';
        }
      }

    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);

      // Call debug hook on error
      debugHooks.onError(stepState, error instanceof Error ? error : new Error(String(error)));
    }

    // Finalize step
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    // Call debug hook after step execution
    debugHooks.afterStep(stepState, result, actionResultForHooks);

    // Write step completion
    outputChannel.writeStepComplete(
      step.name,
      result.duration,
      result.status === 'completed'
    );

    // Emit step completion event
    this.emitEvent({
      type: result.status === 'completed' ? 'step:complete' : 'step:error',
      timestamp: Date.now(),
      workflowName: workflow.name,
      phaseName: phase.name,
      stepName: step.name,
      message: `Step ${result.status}: ${step.name}`,
      data: result,
    });

    return result;
  }

  /**
   * Execute step using action handler with retry logic
   */
  private async executeWithActionHandler(
    workflow: ExecutableWorkflow,
    phase: WorkflowPhase,
    step: WorkflowStep,
    handler: ReturnType<typeof getActionHandler>,
    options: ExecutionOptions
  ): Promise<{
    success: boolean;
    output: unknown;
    stdout?: string;
    stderr?: string;
    error?: string;
    exitCode?: number;
    duration: number;
  }> {
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
    this.emitEvent({
      type: 'action:start',
      timestamp: Date.now(),
      workflowName: workflow.name,
      phaseName: phase.name,
      stepName: step.name,
      message: `Starting action [${handler.type}]`,
    });

    // Create retry manager with event callback
    const retryManager = RetryManager.fromStep(step, (state: RetryState, error: Error) => {
      this.emitEvent({
        type: 'action:retry',
        timestamp: Date.now(),
        workflowName: workflow.name,
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
    this.emitEvent({
      type: retryResult.result.success ? 'action:complete' : 'action:error',
      timestamp: Date.now(),
      workflowName: workflow.name,
      phaseName: phase.name,
      stepName: step.name,
      message: retryResult.result.success
        ? `Action [${handler.type}] completed`
        : `Action [${handler.type}] failed: ${retryResult.result.error}`,
      data: {
        attempts: retryResult.attempts,
        totalDuration: retryResult.totalDuration,
      },
    });

    return retryResult.result;
  }

  /**
   * Create action context for step execution
   */
  private createActionContext(
    workflow: ExecutableWorkflow,
    phase: WorkflowPhase,
    step: WorkflowStep,
    options: ExecutionOptions
  ): ActionContext {
    const outputChannel = getRunnerOutputChannel();

    // Create logger that writes to output channel
    const logger: ActionLogger = {
      info: (msg: string) => outputChannel.info(msg),
      warn: (msg: string) => outputChannel.warn(msg),
      error: (msg: string) => outputChannel.error(msg),
      debug: (msg: string) => outputChannel.debug(msg),
    };

    return {
      workflow,
      phase,
      step,
      inputs: this.executionContext?.getInputs() ?? {},
      stepOutputs: this.executionContext?.getAllStepOutputs() ?? new Map(),
      env: { ...workflow.env, ...options.env, ...step.env },
      workdir: options.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
      signal: this.abortController?.signal ?? new AbortController().signal,
      logger,
    };
  }

  /**
   * Interpolate variables in step configuration
   */
  private interpolateStep(step: WorkflowStep): WorkflowStep {
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
    result: {
      success: boolean;
      output: unknown;
      stdout?: string;
      exitCode?: number;
    }
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
      this.cancellationToken?.cancel();
      if (this.currentExecution) {
        this.currentExecution.status = 'cancelled';
      }
      this.emitEvent({
        type: 'execution:cancel',
        timestamp: Date.now(),
        workflowName: this.currentExecution?.workflowName ?? 'unknown',
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
    this.listeners.clear();
    this.currentExecution = undefined;
    this.executionContext = undefined;
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    WorkflowExecutor.instance?.dispose();
    WorkflowExecutor.instance = undefined;
  }

  /**
   * Emit an event to all listeners
   */
  private emitEvent(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Execution event listener error:', error);
      }
    }
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
        for (const [key, value] of Object.entries(options.env || {})) {
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

  /**
   * Check if execution should continue after a failure
   */
  private shouldContinueAfterFailure(_phase: WorkflowPhase): boolean {
    return false;
  }
}

/**
 * Get the singleton executor instance
 */
export function getWorkflowExecutor(): WorkflowExecutor {
  return WorkflowExecutor.getInstance();
}
