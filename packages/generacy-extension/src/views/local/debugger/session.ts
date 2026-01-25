/**
 * Debug session management for Generacy workflow debugging.
 * Handles step-through execution with continue, stepIn, stepOut, stepOver support.
 * Delegates step execution to WorkflowExecutor for real execution.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';
import {
  getBreakpointManager,
  type WorkflowBreakpoint,
  type BreakpointLocation,
} from './breakpoints';
import { ExecutorEventBridge } from './event-bridge';
import type {
  ExecutableWorkflow,
  ExecutionOptions,
  WorkflowPhase,
  WorkflowStep,
  StepResult,
  SingleStepResult,
} from '../runner/types';
import { WorkflowExecutor } from '../runner/executor';
import { getDebugHooks } from '../runner/debug-integration';
import { getDebugExecutionState } from '../../../debug';
import { getRunnerOutputChannel } from '../runner/output-channel';
import { getErrorAnalysisManager } from './error-analysis';

/**
 * Debug session state
 */
export type DebugSessionState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'stepping'
  | 'completed'
  | 'failed'
  | 'terminated';

/**
 * Step type for debugging
 */
export type StepType = 'continue' | 'stepIn' | 'stepOut' | 'stepOver' | 'pause';

/**
 * Current execution position
 */
export interface ExecutionPosition {
  /** Current phase index */
  phaseIndex: number;
  /** Current step index within the phase */
  stepIndex: number;
  /** Phase name */
  phaseName: string;
  /** Step name */
  stepName?: string;
  /** Whether we're at the phase start (before any step) */
  atPhaseStart: boolean;
}

/**
 * Debug session context (variables, outputs, etc.)
 */
export interface DebugContext {
  /** Environment variables */
  env: Record<string, string>;
  /** Workflow-level variables */
  variables: Record<string, unknown>;
  /** Outputs from completed steps */
  outputs: Record<string, unknown>;
  /** Current phase outputs */
  phaseOutputs: Record<string, unknown>;
}

/**
 * Stop reason for debug events
 */
export type StopReason =
  | 'entry'
  | 'breakpoint'
  | 'step'
  | 'pause'
  | 'exception'
  | 'goto'
  | 'data breakpoint';

/**
 * Debug session event types
 */
export type DebugSessionEventType =
  | 'started'
  | 'stopped'
  | 'continued'
  | 'exited'
  | 'terminated'
  | 'output'
  | 'breakpoint';

/**
 * Debug session event
 */
export interface DebugSessionEvent {
  type: DebugSessionEventType;
  reason?: StopReason;
  position?: ExecutionPosition;
  breakpoint?: WorkflowBreakpoint;
  output?: string;
  exitCode?: number;
  context?: DebugContext;
}

/**
 * Debug session event listener
 */
export type DebugSessionEventListener = (event: DebugSessionEvent) => void;

/**
 * Debug session configuration
 */
export interface DebugSessionConfig {
  /** Workflow to debug */
  workflow: ExecutableWorkflow;
  /** Source file URI */
  uri: vscode.Uri;
  /** Execution options */
  options?: ExecutionOptions;
  /** Stop on entry (first line) */
  stopOnEntry?: boolean;
  /** Working directory */
  cwd?: string;
}

/**
 * Debug session for workflow step-through execution.
 */
export class DebugSession {
  private static instance: DebugSession | undefined;

  private config: DebugSessionConfig | undefined;
  private state: DebugSessionState = 'idle';
  private position: ExecutionPosition | undefined;
  private context: DebugContext | undefined;
  private pendingStepType: StepType | undefined;
  private stepStartPosition: ExecutionPosition | undefined;
  private listeners: Set<DebugSessionEventListener> = new Set();
  private cancellationToken: vscode.CancellationTokenSource | undefined;
  private pauseRequested = false;
  private stepResults: StepResult[] = [];
  private eventBridge: ExecutorEventBridge | undefined;
  private pauseOnError = true;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): DebugSession {
    if (!DebugSession.instance) {
      DebugSession.instance = new DebugSession();
    }
    return DebugSession.instance;
  }

  /**
   * Get current session state
   */
  public getState(): DebugSessionState {
    return this.state;
  }

  /**
   * Get current execution position
   */
  public getPosition(): ExecutionPosition | undefined {
    return this.position;
  }

  /**
   * Get current debug context
   */
  public getContext(): DebugContext | undefined {
    return this.context;
  }

  /**
   * Check if a debug session is active
   */
  public isActive(): boolean {
    return this.state !== 'idle' && this.state !== 'completed' && this.state !== 'failed' && this.state !== 'terminated';
  }

  /**
   * Check if session is paused
   */
  public isPaused(): boolean {
    return this.state === 'paused';
  }

  /**
   * Add event listener
   */
  public addEventListener(listener: DebugSessionEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Start a debug session
   */
  public async start(config: DebugSessionConfig): Promise<void> {
    const logger = getLogger();

    if (this.isActive()) {
      throw new Error('A debug session is already active. Terminate it first.');
    }

    this.config = config;
    this.state = 'running';
    this.stepResults = [];
    this.pauseOnError = (config as DebugSessionConfig & { pauseOnError?: boolean }).pauseOnError ?? true;
    this.context = {
      env: { ...config.workflow.env, ...config.options?.env },
      variables: {},
      outputs: {},
      phaseOutputs: {},
    };
    this.cancellationToken = new vscode.CancellationTokenSource();
    this.pauseRequested = false;

    // Reset breakpoint hit counts
    getBreakpointManager().resetHitCounts();

    // Initialize event bridge: connect executor events to debug state
    const executor = WorkflowExecutor.getInstance();
    const debugState = getDebugExecutionState();
    this.eventBridge = new ExecutorEventBridge(executor, debugState);
    this.eventBridge.connect();

    // Wire DebugHooks to use BreakpointManager as source of truth
    const debugHooks = getDebugHooks();
    debugHooks.enable();
    debugHooks.setBreakpointManagerDelegate(getBreakpointManager(), config.uri);

    logger.info(`Debug session started: ${config.workflow.name}`);

    // Initialize position to first phase
    this.position = {
      phaseIndex: 0,
      stepIndex: 0,
      phaseName: config.workflow.phases[0]?.name ?? 'unknown',
      stepName: undefined,
      atPhaseStart: true,
    };

    this.emitEvent({ type: 'started' });

    // Check for stop on entry
    if (config.stopOnEntry) {
      this.state = 'paused';
      this.emitEvent({
        type: 'stopped',
        reason: 'entry',
        position: this.position,
        context: this.context,
      });
    } else {
      // Start execution
      await this.runToNextBreakpoint();
    }
  }

  /**
   * Continue execution
   */
  public async continue(): Promise<void> {
    if (!this.isActive()) {
      throw new Error('No active debug session');
    }

    if (this.state !== 'paused') {
      return;
    }

    const logger = getLogger();
    logger.debug('Continue execution');

    this.state = 'running';
    this.pendingStepType = 'continue';
    this.pauseRequested = false;
    this.emitEvent({ type: 'continued' });

    await this.runToNextBreakpoint();
  }

  /**
   * Step into - execute one step, entering into substeps if available
   */
  public async stepIn(): Promise<void> {
    if (!this.isActive()) {
      throw new Error('No active debug session');
    }

    if (this.state !== 'paused') {
      return;
    }

    const logger = getLogger();
    logger.debug('Step in');

    this.state = 'stepping';
    this.pendingStepType = 'stepIn';
    this.stepStartPosition = { ...this.position! };
    this.pauseRequested = false;

    await this.executeNextStep();
  }

  /**
   * Step out - continue to end of current phase
   */
  public async stepOut(): Promise<void> {
    if (!this.isActive()) {
      throw new Error('No active debug session');
    }

    if (this.state !== 'paused') {
      return;
    }

    const logger = getLogger();
    logger.debug('Step out');

    this.state = 'stepping';
    this.pendingStepType = 'stepOut';
    this.stepStartPosition = { ...this.position! };
    this.pauseRequested = false;

    await this.runToEndOfPhase();
  }

  /**
   * Step over - execute current step without entering substeps
   */
  public async stepOver(): Promise<void> {
    if (!this.isActive()) {
      throw new Error('No active debug session');
    }

    if (this.state !== 'paused') {
      return;
    }

    const logger = getLogger();
    logger.debug('Step over');

    this.state = 'stepping';
    this.pendingStepType = 'stepOver';
    this.stepStartPosition = { ...this.position! };
    this.pauseRequested = false;

    // For workflows, stepOver is same as stepIn (no nested calls)
    await this.executeNextStep();
  }

  /**
   * Pause execution
   */
  public async pause(): Promise<void> {
    if (!this.isActive()) {
      throw new Error('No active debug session');
    }

    const logger = getLogger();
    logger.debug('Pause requested');

    this.pauseRequested = true;
  }

  /**
   * Terminate the debug session
   */
  public terminate(): void {
    const logger = getLogger();
    logger.info('Debug session terminated');

    // Disconnect event bridge to prevent memory leaks (T008)
    if (this.eventBridge) {
      this.eventBridge.disconnect();
      this.eventBridge = undefined;
    }

    // Clean up DebugHooks delegate
    const debugHooks = getDebugHooks();
    debugHooks.clearBreakpointManagerDelegate();
    debugHooks.disable();

    if (this.cancellationToken) {
      this.cancellationToken.cancel();
      this.cancellationToken.dispose();
      this.cancellationToken = undefined;
    }

    this.state = 'terminated';
    this.emitEvent({ type: 'terminated' });
    this.reset();
  }

  /**
   * Get variables for the current scope
   */
  public getVariables(scope: 'env' | 'variables' | 'outputs' | 'phaseOutputs'): Record<string, unknown> {
    if (!this.context) {
      return {};
    }
    return this.context[scope] ?? {};
  }

  /**
   * Get all scopes
   */
  public getScopes(): Array<{ name: string; variablesReference: number }> {
    return [
      { name: 'Environment', variablesReference: 1 },
      { name: 'Variables', variablesReference: 2 },
      { name: 'Outputs', variablesReference: 3 },
      { name: 'Phase Outputs', variablesReference: 4 },
    ];
  }

  /**
   * Get the call stack (phases and steps as stack frames)
   */
  public getStackTrace(): Array<{
    id: number;
    name: string;
    source?: string;
    line?: number;
    column?: number;
  }> {
    if (!this.position || !this.config) {
      return [];
    }

    const frames: Array<{
      id: number;
      name: string;
      source?: string;
      line?: number;
      column?: number;
    }> = [];

    const phase = this.config.workflow.phases[this.position.phaseIndex];
    if (phase) {
      // Add phase frame
      frames.push({
        id: this.position.phaseIndex + 1,
        name: `Phase: ${phase.name}`,
        source: this.config.uri.fsPath,
        line: 1, // Would need line mapping
      });

      // Add step frame if at a step
      if (!this.position.atPhaseStart && this.position.stepName) {
        const step = phase.steps[this.position.stepIndex];
        if (step) {
          frames.push({
            id: (this.position.phaseIndex + 1) * 100 + this.position.stepIndex + 1,
            name: `Step: ${step.name}`,
            source: this.config.uri.fsPath,
            line: 1, // Would need line mapping
          });
        }
      }
    }

    return frames.reverse(); // Most recent at top
  }

  /**
   * Run execution until next breakpoint or end
   */
  private async runToNextBreakpoint(): Promise<void> {
    if (!this.config || !this.position) {
      return;
    }

    const breakpointManager = getBreakpointManager();
    const outputChannel = getRunnerOutputChannel();

    while (this.state === 'running' && !this.cancellationToken?.token.isCancellationRequested) {
      // Check for pause request
      if (this.pauseRequested) {
        this.state = 'paused';
        this.pauseRequested = false;
        this.emitEvent({
          type: 'stopped',
          reason: 'pause',
          position: this.position,
          context: this.context,
        });
        return;
      }

      const phase = this.config.workflow.phases[this.position.phaseIndex];
      if (!phase) {
        // Completed all phases
        await this.complete();
        return;
      }

      // Check for breakpoint at current position
      const breakpoint = breakpointManager.shouldStopAt(
        this.config.uri,
        phase.name,
        this.position.atPhaseStart ? undefined : phase.steps[this.position.stepIndex]?.name,
        this.context as Record<string, unknown>
      );

      if (breakpoint) {
        this.state = 'paused';
        this.emitEvent({
          type: 'stopped',
          reason: 'breakpoint',
          position: this.position,
          breakpoint,
          context: this.context,
        });
        return;
      }

      // Execute current step
      if (this.position.atPhaseStart) {
        // At phase start, move to first step
        outputChannel.writePhaseStart(
          phase.name,
          this.position.phaseIndex,
          this.config.workflow.phases.length
        );
        this.position.atPhaseStart = false;
        if (phase.steps.length === 0) {
          // Empty phase, move to next
          await this.moveToNextPhase();
        }
      } else {
        // Execute the current step
        const step = phase.steps[this.position.stepIndex];
        if (step) {
          this.position.stepName = step.name;
          await this.executeStep(step, phase.name);
        }
        await this.moveToNextPosition();
      }
    }
  }

  /**
   * Execute the next single step
   */
  private async executeNextStep(): Promise<void> {
    if (!this.config || !this.position) {
      return;
    }

    const phase = this.config.workflow.phases[this.position.phaseIndex];
    if (!phase) {
      await this.complete();
      return;
    }

    if (this.position.atPhaseStart) {
      // Move to first step
      this.position.atPhaseStart = false;
      if (phase.steps.length === 0) {
        await this.moveToNextPhase();
      }
    } else {
      // Execute current step
      const step = phase.steps[this.position.stepIndex];
      if (step) {
        this.position.stepName = step.name;
        await this.executeStep(step, phase.name);
      }
      await this.moveToNextPosition();
    }

    // Stop after one step
    this.state = 'paused';
    this.emitEvent({
      type: 'stopped',
      reason: 'step',
      position: this.position,
      context: this.context,
    });
  }

  /**
   * Run to end of current phase
   */
  private async runToEndOfPhase(): Promise<void> {
    if (!this.config || !this.position) {
      return;
    }

    const startPhaseIndex = this.position.phaseIndex;

    while (
      this.state === 'stepping' &&
      this.position.phaseIndex === startPhaseIndex &&
      !this.cancellationToken?.token.isCancellationRequested
    ) {
      const phase = this.config.workflow.phases[this.position.phaseIndex];
      if (!phase) {
        break;
      }

      if (this.position.atPhaseStart) {
        this.position.atPhaseStart = false;
        if (phase.steps.length === 0) {
          break;
        }
      } else {
        const step = phase.steps[this.position.stepIndex];
        if (step) {
          this.position.stepName = step.name;
          await this.executeStep(step, phase.name);
        }
        await this.moveToNextPosition();
        if (this.position.phaseIndex !== startPhaseIndex) {
          break;
        }
      }
    }

    // If we moved to next phase, pause there
    this.state = 'paused';
    this.emitEvent({
      type: 'stopped',
      reason: 'step',
      position: this.position,
      context: this.context,
    });
  }

  /**
   * Execute a single step by delegating to the WorkflowExecutor.
   * This replaces the previous simulateStepExecution() placeholder.
   */
  private async executeStep(step: WorkflowStep, phaseName: string): Promise<void> {
    const outputChannel = getRunnerOutputChannel();
    const logger = getLogger();

    outputChannel.writeStepStart(
      step.name,
      this.position?.stepIndex ?? 0,
      this.config?.workflow.phases[this.position?.phaseIndex ?? 0]?.steps.length ?? 1
    );

    // Emit output event
    this.emitEvent({
      type: 'output',
      output: `Executing step: ${step.name}`,
    });

    const startTime = Date.now();

    try {
      // Delegate to WorkflowExecutor for real step execution
      const singleStepResult = await this.executeStepViaExecutor(step, phaseName);

      const duration = Date.now() - startTime;

      if (singleStepResult.skipped) {
        outputChannel.writeStepComplete(step.name, duration, true);
        const result: StepResult = {
          stepName: step.name,
          phaseName,
          status: 'skipped',
          startTime,
          endTime: Date.now(),
          duration,
        };
        this.stepResults.push(result);
        return;
      }

      if (singleStepResult.success) {
        outputChannel.writeStepComplete(step.name, duration, true);

        // Store step result
        const result: StepResult = {
          stepName: step.name,
          phaseName,
          status: 'completed',
          startTime,
          endTime: Date.now(),
          duration,
          output: typeof singleStepResult.output === 'string'
            ? singleStepResult.output
            : singleStepResult.output != null ? JSON.stringify(singleStepResult.output) : undefined,
          exitCode: singleStepResult.exitCode,
        };
        this.stepResults.push(result);

        // Update context with real data from executor
        this.updateContextFromExecutor(step.name, phaseName, singleStepResult);

      } else {
        // Step failed
        const errorMessage = singleStepResult.error?.message ?? 'Step execution failed';
        outputChannel.writeStepComplete(step.name, duration, false);
        logger.error(`Step failed: ${step.name}`, { error: errorMessage });

        this.emitEvent({
          type: 'output',
          output: `Step failed: ${errorMessage}`,
        });

        // Store failed result
        const result: StepResult = {
          stepName: step.name,
          phaseName,
          status: 'failed',
          startTime,
          endTime: Date.now(),
          duration,
          error: errorMessage,
          exitCode: singleStepResult.exitCode,
        };
        this.stepResults.push(result);

        // Error pause integration (T010): pause on errors if enabled
        if (this.pauseOnError) {
          // Feed error to ErrorAnalysisManager for categorization and suggestions
          try {
            const errorAnalysis = getErrorAnalysisManager();
            // Error analysis is handled automatically via state change subscription
          } catch {
            // Error analysis not critical, continue
          }

          // Emit DAP stopped event with 'exception' reason
          this.state = 'paused';
          this.emitEvent({
            type: 'stopped',
            reason: 'exception',
            position: this.position,
            context: this.context,
          });
          return; // Pause here — user can Continue, Step Over, or Terminate
        }

        if (!step.continueOnError) {
          await this.fail(errorMessage);
        }
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      outputChannel.writeStepComplete(step.name, duration, false);
      logger.error(`Step failed: ${step.name}`, { error: errorMessage });

      this.emitEvent({
        type: 'output',
        output: `Step failed: ${errorMessage}`,
      });

      // Store failed result
      const result: StepResult = {
        stepName: step.name,
        phaseName,
        status: 'failed',
        startTime,
        endTime: Date.now(),
        duration,
        error: errorMessage,
      };
      this.stepResults.push(result);

      // Error pause integration
      if (this.pauseOnError) {
        this.state = 'paused';
        this.emitEvent({
          type: 'stopped',
          reason: 'exception',
          position: this.position,
          context: this.context,
        });
        return;
      }

      if (!step.continueOnError) {
        await this.fail(errorMessage);
      }
    }
  }

  /**
   * Delegate step execution to WorkflowExecutor.
   * Uses the executeSingleStep() API for fine-grained debug control.
   */
  private async executeStepViaExecutor(step: WorkflowStep, phaseName: string): Promise<SingleStepResult> {
    const executor = WorkflowExecutor.getInstance();
    const phase = this.config?.workflow.phases[this.position?.phaseIndex ?? 0];

    if (!phase) {
      return {
        success: false,
        output: null,
        error: new Error(`Phase not found at index ${this.position?.phaseIndex}`),
        duration: 0,
        skipped: false,
      };
    }

    return executor.executeSingleStep({
      step,
      phase,
      context: executor.getExecutionContext(),
      phaseIndex: this.position?.phaseIndex ?? 0,
      stepIndex: this.position?.stepIndex ?? 0,
    });
  }

  /**
   * Update the debug context with real data from executor after step completion
   */
  private updateContextFromExecutor(
    stepName: string,
    phaseName: string,
    result: SingleStepResult
  ): void {
    if (!this.context) {
      return;
    }

    // Update phase outputs with real step output
    this.context.phaseOutputs[stepName] = {
      status: result.success ? 'completed' : 'failed',
      output: result.output,
      exitCode: result.exitCode,
    };

    // Update global outputs
    this.context.outputs[`${phaseName}.${stepName}`] = {
      status: result.success ? 'completed' : 'failed',
      output: result.output,
      exitCode: result.exitCode,
    };

    // Pull real variables from executor context
    const executor = WorkflowExecutor.getInstance();
    const executionContext = executor.getExecutionContext();
    if (executionContext) {
      // Update variables scope with workflow-level data
      const interpCtx = executionContext.getInterpolationContext();
      if (interpCtx.env) {
        this.context.env = { ...this.context.env, ...interpCtx.env };
      }
    }
  }

  /**
   * Move to the next position
   */
  private async moveToNextPosition(): Promise<void> {
    if (!this.config || !this.position) {
      return;
    }

    const phase = this.config.workflow.phases[this.position.phaseIndex];
    if (!phase) {
      return;
    }

    // Move to next step
    this.position.stepIndex++;

    if (this.position.stepIndex >= phase.steps.length) {
      // Phase complete
      await this.moveToNextPhase();
    } else {
      this.position.stepName = phase.steps[this.position.stepIndex]?.name;
    }
  }

  /**
   * Move to the next phase
   */
  private async moveToNextPhase(): Promise<void> {
    if (!this.config || !this.position) {
      return;
    }

    const outputChannel = getRunnerOutputChannel();
    const currentPhase = this.config.workflow.phases[this.position.phaseIndex];

    if (currentPhase) {
      outputChannel.writePhaseComplete(
        currentPhase.name,
        this.stepResults
          .filter(r => r.phaseName === currentPhase.name)
          .reduce((sum, r) => sum + (r.duration ?? 0), 0),
        true
      );
    }

    // Clear phase outputs for new phase
    if (this.context) {
      this.context.phaseOutputs = {};
    }

    // Move to next phase
    this.position.phaseIndex++;
    this.position.stepIndex = 0;
    this.position.atPhaseStart = true;
    this.position.stepName = undefined;

    const nextPhase = this.config.workflow.phases[this.position.phaseIndex];
    if (nextPhase) {
      this.position.phaseName = nextPhase.name;
    }
  }

  /**
   * Mark session as completed
   */
  private async complete(): Promise<void> {
    const logger = getLogger();
    logger.info('Debug session completed');

    this.state = 'completed';
    this.emitEvent({
      type: 'exited',
      exitCode: 0,
      context: this.context,
    });
    this.reset();
  }

  /**
   * Mark session as failed
   */
  private async fail(reason: string): Promise<void> {
    const logger = getLogger();
    logger.error(`Debug session failed: ${reason}`);

    this.state = 'failed';
    this.emitEvent({
      type: 'stopped',
      reason: 'exception',
      position: this.position,
      context: this.context,
    });
  }

  /**
   * Reset session state
   */
  private reset(): void {
    this.config = undefined;
    this.position = undefined;
    this.context = undefined;
    this.pendingStepType = undefined;
    this.stepStartPosition = undefined;
    this.stepResults = [];
    this.pauseRequested = false;
    this.pauseOnError = true;

    if (this.eventBridge) {
      this.eventBridge.disconnect();
      this.eventBridge = undefined;
    }

    if (this.cancellationToken) {
      this.cancellationToken.dispose();
      this.cancellationToken = undefined;
    }

    this.state = 'idle';
  }

  /**
   * Emit a session event
   */
  private emitEvent(event: DebugSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Debug session event listener error:', error);
      }
    }
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.terminate();
    this.listeners.clear();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    DebugSession.instance?.dispose();
    DebugSession.instance = undefined;
  }
}

/**
 * Get the singleton debug session instance
 */
export function getDebugSession(): DebugSession {
  return DebugSession.getInstance();
}
