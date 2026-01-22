/**
 * Workflow runtime with step-by-step execution for debugging.
 * Provides controlled execution with breakpoint support.
 */
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { getDebugExecutionState, type DebugExecutionState } from './state';
import { getWorkflowTerminal } from '../views/local/runner/terminal';
import type { WorkflowStep, WorkflowPhase, ExecutableWorkflow } from '../views/local/runner/types';

/**
 * Breakpoint types
 */
export interface DebugBreakpoint {
  id: number;
  verified: boolean;
  line: number;
  source: string;
  phaseName?: string;
  stepName?: string;
}

/**
 * Runtime execution mode
 */
export type RuntimeMode = 'run' | 'step' | 'pause';

/**
 * Runtime event types
 */
export type RuntimeEventType =
  | 'started'
  | 'stopped'
  | 'continued'
  | 'breakpoint'
  | 'step'
  | 'output'
  | 'ended';

/**
 * Runtime event data
 */
export interface RuntimeEvent {
  type: RuntimeEventType;
  reason?: string;
  phaseName?: string;
  stepName?: string;
  line?: number;
  output?: string;
  success?: boolean;
}

/**
 * Runtime event listener
 */
export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * Workflow debug runtime
 */
export class WorkflowDebugRuntime {
  private workflow: ExecutableWorkflow | undefined;
  private filePath: string = '';
  private mode: RuntimeMode = 'pause';
  private breakpoints: Map<number, DebugBreakpoint> = new Map();
  private breakpointIdCounter = 0;
  private listeners: Set<RuntimeEventListener> = new Set();
  private executionPromise: Promise<void> | undefined;
  private pauseResolve: (() => void) | undefined;
  private state: DebugExecutionState;
  private environment: Record<string, string> = {};
  private sourceMap: Map<number, { phase?: string; step?: string }> = new Map();

  constructor() {
    this.state = getDebugExecutionState();
  }

  /**
   * Add event listener
   */
  public addEventListener(listener: RuntimeEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Load a workflow from file
   */
  public async loadWorkflow(filePath: string): Promise<void> {
    this.filePath = filePath;

    // Read and parse workflow file
    const uri = vscode.Uri.file(filePath);
    const content = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(content);

    const parsed = yaml.parse(text);
    this.workflow = this.parseWorkflow(parsed, filePath);

    // Build source map for line-to-phase/step mapping
    this.buildSourceMap(text);

    // Initialize state
    this.state.initialize(
      this.workflow.name,
      filePath,
      this.workflow.phases.map(p => ({
        name: p.name,
        steps: p.steps.map(s => ({ name: s.name })),
      })),
      this.workflow.env
    );
  }

  /**
   * Set environment variables
   */
  public setEnvironment(env: Record<string, string>): void {
    this.environment = { ...env };
    if (this.workflow) {
      for (const [key, value] of Object.entries(env)) {
        this.state.setVariable('environment', key, value);
      }
    }
  }

  /**
   * Start execution
   */
  public async start(stopOnEntry: boolean = false): Promise<void> {
    if (!this.workflow) {
      throw new Error('No workflow loaded');
    }

    this.emitEvent({ type: 'started' });

    if (stopOnEntry) {
      this.mode = 'pause';
      this.state.startWorkflow();
      this.state.pause();
      this.emitEvent({
        type: 'stopped',
        reason: 'entry',
        phaseName: this.workflow.phases[0]?.name,
        stepName: this.workflow.phases[0]?.steps[0]?.name,
      });
      return;
    }

    this.mode = 'run';
    this.state.startWorkflow();
    this.executionPromise = this.runExecution();
    await this.executionPromise;
  }

  /**
   * Continue execution
   */
  public continue(): void {
    this.mode = 'run';
    this.state.resume();
    this.emitEvent({ type: 'continued' });

    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = undefined;
    }
  }

  /**
   * Step to next step
   */
  public stepNext(): void {
    this.mode = 'step';
    this.state.resume();

    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = undefined;
    }
  }

  /**
   * Step into (same as step next for workflow debugging)
   */
  public stepIn(): void {
    this.stepNext();
  }

  /**
   * Step out (complete current phase)
   */
  public stepOut(): void {
    // Mark to skip remaining steps in current phase
    this.mode = 'run';
    this.state.resume();

    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = undefined;
    }
  }

  /**
   * Pause execution
   */
  public pause(): void {
    this.mode = 'pause';
    this.state.pause();
    const currentStep = this.state.getCurrentStep();
    this.emitEvent({
      type: 'stopped',
      reason: 'pause',
      phaseName: currentStep?.phaseName,
      stepName: currentStep?.name,
    });
  }

  /**
   * Stop execution
   */
  public stop(): void {
    this.state.cancel();
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = undefined;
    }
    this.emitEvent({ type: 'ended', success: false, reason: 'cancelled' });
  }

  /**
   * Set breakpoints
   */
  public setBreakpoints(lines: number[]): DebugBreakpoint[] {
    // Clear existing breakpoints
    this.breakpoints.clear();

    const result: DebugBreakpoint[] = [];

    for (const line of lines) {
      const location = this.sourceMap.get(line);
      const bp: DebugBreakpoint = {
        id: ++this.breakpointIdCounter,
        verified: location !== undefined,
        line,
        source: this.filePath,
        phaseName: location?.phase,
        stepName: location?.step,
      };

      if (bp.verified) {
        this.breakpoints.set(line, bp);
      }
      result.push(bp);
    }

    return result;
  }

  /**
   * Get current stack frames
   */
  public getStackFrames(): Array<{
    id: number;
    name: string;
    source: string;
    line: number;
    column: number;
  }> {
    const frames: Array<{
      id: number;
      name: string;
      source: string;
      line: number;
      column: number;
    }> = [];

    const workflowState = this.state.getWorkflowState();
    if (!workflowState) return frames;

    const currentPhase = this.state.getCurrentPhase();
    const currentStep = this.state.getCurrentStep();

    // Add step frame
    if (currentStep) {
      const line = this.getLineForStep(currentPhase?.name, currentStep.name);
      frames.push({
        id: 1,
        name: `${currentStep.name} (step)`,
        source: this.filePath,
        line: line ?? 1,
        column: 1,
      });
    }

    // Add phase frame
    if (currentPhase) {
      const line = this.getLineForPhase(currentPhase.name);
      frames.push({
        id: 2,
        name: `${currentPhase.name} (phase)`,
        source: this.filePath,
        line: line ?? 1,
        column: 1,
      });
    }

    // Add workflow frame
    frames.push({
      id: 3,
      name: `${workflowState.name} (workflow)`,
      source: this.filePath,
      line: 1,
      column: 1,
    });

    return frames;
  }

  /**
   * Evaluate an expression
   */
  public evaluate(expression: string, _frameId?: number): { result: string; variablesReference: number } {
    const workflowState = this.state.getWorkflowState();
    if (!workflowState) {
      return { result: 'No workflow running', variablesReference: 0 };
    }

    // Try to find variable in different scopes
    const step = this.state.getCurrentStep();
    const phase = this.state.getCurrentPhase();

    // Check step variables
    if (step?.variables.has(expression)) {
      const value = step.variables.get(expression);
      return { result: this.formatValue(value), variablesReference: 0 };
    }

    // Check phase variables
    if (phase?.variables.has(expression)) {
      const value = phase.variables.get(expression);
      return { result: this.formatValue(value), variablesReference: 0 };
    }

    // Check workflow variables
    if (workflowState.variables.has(expression)) {
      const value = workflowState.variables.get(expression);
      return { result: this.formatValue(value), variablesReference: 0 };
    }

    // Check environment
    if (workflowState.environment.has(expression)) {
      const value = workflowState.environment.get(expression);
      return { result: value ?? '', variablesReference: 0 };
    }

    // Check outputs
    if (workflowState.outputs.has(expression)) {
      const value = workflowState.outputs.get(expression);
      return { result: this.formatValue(value), variablesReference: 0 };
    }

    return { result: `Variable '${expression}' not found`, variablesReference: 0 };
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.listeners.clear();
    this.breakpoints.clear();
    this.sourceMap.clear();
    this.state.reset();
  }

  /**
   * Run the execution loop
   */
  private async runExecution(): Promise<void> {
    if (!this.workflow) return;

    const terminal = getWorkflowTerminal();

    for (let phaseIndex = 0; phaseIndex < this.workflow.phases.length; phaseIndex++) {
      const phase = this.workflow.phases[phaseIndex];
      if (!phase) continue;

      const workflowState = this.state.getWorkflowState();
      if (workflowState?.status === 'cancelled') {
        break;
      }

      this.state.startPhase(phase.name);

      for (let stepIndex = 0; stepIndex < phase.steps.length; stepIndex++) {
        const step = phase.steps[stepIndex];
        if (!step) continue;

        const currentState = this.state.getWorkflowState();
        if (currentState?.status === 'cancelled') {
          break;
        }

        // Check for breakpoint
        const line = this.getLineForStep(phase.name, step.name);
        if (line && this.breakpoints.has(line)) {
          this.mode = 'pause';
          this.state.pause();
          this.emitEvent({
            type: 'stopped',
            reason: 'breakpoint',
            phaseName: phase.name,
            stepName: step.name,
            line,
          });

          // Wait for continue
          await this.waitForContinue();

          const afterWaitState = this.state.getWorkflowState();
          if (afterWaitState?.status === 'cancelled') {
            break;
          }
        }

        // Execute step
        this.state.startStep(phase.name, step.name);
        this.emitEvent({
          type: 'step',
          phaseName: phase.name,
          stepName: step.name,
        });

        try {
          const result = await terminal.executeStepWithCapture(step, {
            mode: 'normal',
            env: { ...this.workflow.env, ...this.environment, ...step.env },
          });

          // Emit output
          if (result.output) {
            this.emitEvent({
              type: 'output',
              output: result.output,
              phaseName: phase.name,
              stepName: step.name,
            });
          }

          const success = !result.error && (result.exitCode === undefined || result.exitCode === 0);
          this.state.completeStep(phase.name, step.name, success, result.output, result.error, result.exitCode);

          if (!success && !step.continueOnError) {
            this.state.fail(result.error);
            this.emitEvent({
              type: 'ended',
              success: false,
              reason: result.error,
            });
            return;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.state.completeStep(phase.name, step.name, false, undefined, errorMessage);

          if (!step.continueOnError) {
            this.state.fail(errorMessage);
            this.emitEvent({
              type: 'ended',
              success: false,
              reason: errorMessage,
            });
            return;
          }
        }

        // Check if should pause after step (step mode)
        if (this.mode === 'step') {
          this.mode = 'pause';
          this.state.pause();

          const nextStep = phase.steps[stepIndex + 1];
          const nextPhase = this.workflow.phases[phaseIndex + 1];

          this.emitEvent({
            type: 'stopped',
            reason: 'step',
            phaseName: nextStep ? phase.name : nextPhase?.name,
            stepName: nextStep?.name ?? nextPhase?.steps[0]?.name,
          });

          await this.waitForContinue();
        }

        this.state.advanceStep();
      }

      this.state.completePhase(phase.name, true);
    }

    this.state.complete();
    this.emitEvent({ type: 'ended', success: true });
  }

  /**
   * Wait for continue signal
   */
  private waitForContinue(): Promise<void> {
    return new Promise(resolve => {
      this.pauseResolve = resolve;
    });
  }

  /**
   * Parse workflow from YAML object
   */
  private parseWorkflow(parsed: unknown, filePath: string): ExecutableWorkflow {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid workflow file');
    }

    const obj = parsed as Record<string, unknown>;

    return {
      name: (obj.name as string) || filePath.split('/').pop()?.replace(/\.(ya?ml)$/, '') || 'workflow',
      description: obj.description as string | undefined,
      phases: this.parsePhases(obj.phases),
      env: (obj.env as Record<string, string>) || {},
      timeout: obj.timeout as number | undefined,
    };
  }

  /**
   * Parse phases from YAML array
   */
  private parsePhases(phases: unknown): WorkflowPhase[] {
    if (!Array.isArray(phases)) {
      return [];
    }

    return phases
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map(phase => ({
        name: (phase.name as string) || 'unnamed',
        condition: phase.condition as string | undefined,
        steps: this.parseSteps(phase.steps, (phase.name as string) || 'unnamed'),
      }));
  }

  /**
   * Parse steps from YAML array
   */
  private parseSteps(steps: unknown, _phaseName: string): WorkflowStep[] {
    if (!Array.isArray(steps)) {
      return [];
    }

    return steps
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
      .map(step => ({
        name: (step.name as string) || 'unnamed',
        action: (step.action as string) || 'shell',
        command: step.command as string | undefined,
        script: step.script as string | undefined,
        timeout: step.timeout as number | undefined,
        continueOnError: Boolean(step.continueOnError ?? step['continue-on-error']),
        condition: step.condition as string | undefined,
        env: (step.env as Record<string, string>) || {},
      }));
  }

  /**
   * Build source map from YAML content
   */
  private buildSourceMap(content: string): void {
    this.sourceMap.clear();

    const lines = content.split('\n');
    let currentPhase: string | undefined;
    let inPhases = false;
    let inSteps = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line?.trimStart() ?? '';
      const lineNumber = i + 1;

      // Detect phases section
      if (trimmed.startsWith('phases:')) {
        inPhases = true;
        continue;
      }

      if (inPhases) {
        // Detect phase name
        const phaseMatch = trimmed.match(/^-?\s*name:\s*['"]?([^'"]+)['"]?/);
        if (phaseMatch) {
          currentPhase = phaseMatch[1];
          this.sourceMap.set(lineNumber, { phase: currentPhase });
          continue;
        }

        // Detect steps section
        if (trimmed.startsWith('steps:')) {
          inSteps = true;
          continue;
        }

        // Detect step name
        if (inSteps && currentPhase) {
          const stepMatch = trimmed.match(/^-?\s*name:\s*['"]?([^'"]+)['"]?/);
          if (stepMatch) {
            this.sourceMap.set(lineNumber, { phase: currentPhase, step: stepMatch[1] });
          }
        }
      }
    }
  }

  /**
   * Get line number for a phase
   */
  private getLineForPhase(phaseName: string): number | undefined {
    for (const [line, location] of this.sourceMap) {
      if (location.phase === phaseName && !location.step) {
        return line;
      }
    }
    return undefined;
  }

  /**
   * Get line number for a step
   */
  private getLineForStep(phaseName: string | undefined, stepName: string): number | undefined {
    for (const [line, location] of this.sourceMap) {
      if (location.phase === phaseName && location.step === stepName) {
        return line;
      }
    }
    return undefined;
  }

  /**
   * Format a value for display
   */
  private formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  }

  /**
   * Emit an event
   */
  private emitEvent(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Runtime event listener error:', error);
      }
    }
  }
}

/**
 * Singleton runtime instance
 */
let debugRuntime: WorkflowDebugRuntime | undefined;

export function getDebugRuntime(): WorkflowDebugRuntime {
  if (!debugRuntime) {
    debugRuntime = new WorkflowDebugRuntime();
  }
  return debugRuntime;
}

export function resetDebugRuntime(): void {
  debugRuntime?.dispose();
  debugRuntime = undefined;
}
