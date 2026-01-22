/**
 * Workflow executor with phase/step iteration.
 * Handles local workflow execution with event emission and result tracking.
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

/**
 * Workflow executor class
 */
export class WorkflowExecutor {
  private static instance: WorkflowExecutor | undefined;
  private currentExecution: ExecutionResult | undefined;
  private listeners: Set<ExecutionEventListener> = new Set();
  private cancellationToken: vscode.CancellationTokenSource | undefined;

  private constructor() {
    // Private constructor for singleton
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
    options: ExecutionOptions = { mode: 'normal' }
  ): Promise<ExecutionResult> {
    // Check if already running
    if (this.isRunning()) {
      throw new Error('A workflow is already running. Cancel it first.');
    }

    const outputChannel = getRunnerOutputChannel();
    // Terminal is accessed via getWorkflowTerminal() when needed in executeStep

    // Initialize execution result
    this.currentExecution = {
      workflowName: workflow.name,
      status: 'running',
      mode: options.mode,
      startTime: Date.now(),
      phaseResults: [],
      env: { ...workflow.env, ...options.env },
    };

    // Create cancellation token
    this.cancellationToken = new vscode.CancellationTokenSource();

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
          continue; // Should never happen but satisfy TypeScript
        }

        const phaseResult = await this.executePhase(
          phase,
          i,
          workflow.phases.length,
          options,
          workflow.name,
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

    return this.currentExecution;
  }

  /**
   * Execute a single phase
   */
  public async executePhase(
    phase: WorkflowPhase,
    phaseIndex: number,
    totalPhases: number,
    options: ExecutionOptions,
    workflowName: string,
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
      workflowName,
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
          continue; // Should never happen but satisfy TypeScript
        }

        const stepResult = await this.executeStep(
          step,
          i,
          phase.steps.length,
          options,
          workflowName,
          phase.name
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
        workflowName,
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
      workflowName,
      phaseName: phase.name,
      message: `Phase ${result.status}: ${phase.name}`,
      data: result,
    });

    return result;
  }

  /**
   * Execute a single step
   */
  public async executeStep(
    step: WorkflowStep,
    stepIndex: number,
    totalSteps: number,
    options: ExecutionOptions,
    workflowName: string,
    phaseName: string
  ): Promise<StepResult> {
    const outputChannel = getRunnerOutputChannel();
    const terminal = getWorkflowTerminal();

    const result: StepResult = {
      stepName: step.name,
      phaseName,
      status: 'running',
      startTime: Date.now(),
    };

    // Write step start
    outputChannel.writeStepStart(step.name, stepIndex, totalSteps);

    // Emit step start event
    this.emitEvent({
      type: 'step:start',
      timestamp: Date.now(),
      workflowName,
      phaseName,
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

    try {
      // Execute the step
      const terminalResult = await terminal.executeStepWithCapture(step, {
        ...options,
        env: { ...options.env, ...step.env },
      });

      result.output = terminalResult.output;
      result.exitCode = terminalResult.exitCode;
      result.error = terminalResult.error;

      // Write output
      if (terminalResult.output) {
        outputChannel.writeStepOutput(terminalResult.output);
        this.emitEvent({
          type: 'step:output',
          timestamp: Date.now(),
          workflowName,
          phaseName,
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

    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }

    // Finalize step
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

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
      workflowName,
      phaseName,
      stepName: step.name,
      message: `Step ${result.status}: ${step.name}`,
      data: result,
    });

    return result;
  }

  /**
   * Cancel the current execution
   */
  public cancel(): void {
    if (this.isRunning() && this.cancellationToken) {
      this.cancellationToken.cancel();
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
   * Evaluate a condition expression
   */
  private async evaluateCondition(
    condition: string,
    options: ExecutionOptions
  ): Promise<boolean> {
    // Simple condition evaluation
    // In a full implementation, this would parse and evaluate expressions
    // For now, support basic environment variable checks
    try {
      // Replace environment variable references
      let evaluated = condition;
      for (const [key, value] of Object.entries(options.env || {})) {
        evaluated = evaluated.replace(new RegExp(`\\$\\{?${key}\\}?`, 'g'), value);
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
    // Could be extended to check phase-level continueOnError setting
    return false;
  }
}

/**
 * Get the singleton executor instance
 */
export function getWorkflowExecutor(): WorkflowExecutor {
  return WorkflowExecutor.getInstance();
}
