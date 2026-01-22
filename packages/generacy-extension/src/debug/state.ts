/**
 * Execution state tracking for workflow debugging.
 * Tracks variables, context, outputs, and execution history.
 */
import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Variable scope types
 */
export type VariableScope = 'local' | 'phase' | 'workflow' | 'environment';

/**
 * Variable reference for DAP
 */
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  evaluateName?: string;
}

/**
 * Scope information for DAP
 */
export interface DebugScope {
  name: string;
  presentationHint?: 'arguments' | 'locals' | 'registers';
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
  source?: DebugProtocol.Source;
}

/**
 * Step execution state
 */
export interface StepState {
  name: string;
  phaseName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startTime?: number;
  endTime?: number;
  output?: string;
  error?: string;
  exitCode?: number;
  variables: Map<string, unknown>;
}

/**
 * Phase execution state
 */
export interface PhaseState {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  currentStepIndex: number;
  steps: StepState[];
  variables: Map<string, unknown>;
}

/**
 * Workflow execution state
 */
export interface WorkflowState {
  name: string;
  filePath: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentPhaseIndex: number;
  phases: PhaseState[];
  variables: Map<string, unknown>;
  environment: Map<string, string>;
  outputs: Map<string, unknown>;
  startTime?: number;
  endTime?: number;
}

/**
 * Execution history entry
 */
export interface HistoryEntry {
  timestamp: number;
  type: 'phase' | 'step' | 'variable' | 'output';
  phaseName?: string;
  stepName?: string;
  action: 'start' | 'complete' | 'fail' | 'skip' | 'set';
  details?: string;
}

/**
 * Debug execution state manager
 */
export class DebugExecutionState {
  private static variableReferenceCounter = 1000;

  private workflow: WorkflowState | undefined;
  private variableReferences: Map<number, { scope: VariableScope; path: string[] }> = new Map();
  private history: HistoryEntry[] = [];
  private readonly onStateChangeEmitter = new vscode.EventEmitter<WorkflowState | undefined>();

  /**
   * Event fired when state changes
   */
  public readonly onStateChange = this.onStateChangeEmitter.event;

  /**
   * Initialize workflow state
   */
  public initialize(
    name: string,
    filePath: string,
    phases: Array<{ name: string; steps: Array<{ name: string }> }>,
    environment: Record<string, string> = {}
  ): void {
    this.workflow = {
      name,
      filePath,
      status: 'idle',
      currentPhaseIndex: 0,
      phases: phases.map(phase => ({
        name: phase.name,
        status: 'pending',
        currentStepIndex: 0,
        steps: phase.steps.map(step => ({
          name: step.name,
          phaseName: phase.name,
          status: 'pending',
          variables: new Map(),
        })),
        variables: new Map(),
      })),
      variables: new Map(),
      environment: new Map(Object.entries(environment)),
      outputs: new Map(),
    };

    this.variableReferences.clear();
    this.history = [];
    this.emitChange();
  }

  /**
   * Get current workflow state
   */
  public getWorkflowState(): WorkflowState | undefined {
    return this.workflow;
  }

  /**
   * Get current phase
   */
  public getCurrentPhase(): PhaseState | undefined {
    if (!this.workflow || this.workflow.currentPhaseIndex >= this.workflow.phases.length) {
      return undefined;
    }
    return this.workflow.phases[this.workflow.currentPhaseIndex];
  }

  /**
   * Get current step
   */
  public getCurrentStep(): StepState | undefined {
    const phase = this.getCurrentPhase();
    if (!phase || phase.currentStepIndex >= phase.steps.length) {
      return undefined;
    }
    return phase.steps[phase.currentStepIndex];
  }

  /**
   * Start workflow execution
   */
  public startWorkflow(): void {
    if (!this.workflow) return;

    this.workflow.status = 'running';
    this.workflow.startTime = Date.now();
    this.addHistory('phase', this.workflow.phases[0]?.name, undefined, 'start');
    this.emitChange();
  }

  /**
   * Start a phase
   */
  public startPhase(phaseName: string): void {
    if (!this.workflow) return;

    const phase = this.workflow.phases.find(p => p.name === phaseName);
    if (phase) {
      phase.status = 'running';
      this.addHistory('phase', phaseName, undefined, 'start');
      this.emitChange();
    }
  }

  /**
   * Complete a phase
   */
  public completePhase(phaseName: string, success: boolean): void {
    if (!this.workflow) return;

    const phase = this.workflow.phases.find(p => p.name === phaseName);
    if (phase) {
      phase.status = success ? 'completed' : 'failed';
      this.addHistory('phase', phaseName, undefined, success ? 'complete' : 'fail');
      this.emitChange();
    }
  }

  /**
   * Start a step
   */
  public startStep(phaseName: string, stepName: string): void {
    if (!this.workflow) return;

    const phase = this.workflow.phases.find(p => p.name === phaseName);
    const step = phase?.steps.find(s => s.name === stepName);
    if (step) {
      step.status = 'running';
      step.startTime = Date.now();
      this.addHistory('step', phaseName, stepName, 'start');
      this.emitChange();
    }
  }

  /**
   * Complete a step
   */
  public completeStep(
    phaseName: string,
    stepName: string,
    success: boolean,
    output?: string,
    error?: string,
    exitCode?: number
  ): void {
    if (!this.workflow) return;

    const phase = this.workflow.phases.find(p => p.name === phaseName);
    const step = phase?.steps.find(s => s.name === stepName);
    if (step) {
      step.status = success ? 'completed' : 'failed';
      step.endTime = Date.now();
      step.output = output;
      step.error = error;
      step.exitCode = exitCode;
      this.addHistory('step', phaseName, stepName, success ? 'complete' : 'fail', error);
      this.emitChange();
    }
  }

  /**
   * Skip a step
   */
  public skipStep(phaseName: string, stepName: string, reason?: string): void {
    if (!this.workflow) return;

    const phase = this.workflow.phases.find(p => p.name === phaseName);
    const step = phase?.steps.find(s => s.name === stepName);
    if (step) {
      step.status = 'skipped';
      this.addHistory('step', phaseName, stepName, 'skip', reason);
      this.emitChange();
    }
  }

  /**
   * Set a variable in a specific scope
   */
  public setVariable(scope: VariableScope, name: string, value: unknown, phaseName?: string, stepName?: string): void {
    if (!this.workflow) return;

    switch (scope) {
      case 'environment':
        this.workflow.environment.set(name, String(value));
        break;
      case 'workflow':
        this.workflow.variables.set(name, value);
        break;
      case 'phase': {
        const phase = phaseName
          ? this.workflow.phases.find(p => p.name === phaseName)
          : this.getCurrentPhase();
        if (phase) {
          phase.variables.set(name, value);
        } else {
          return;
        }
        break;
      }
      case 'local': {
        const currentPhase = phaseName
          ? this.workflow.phases.find(p => p.name === phaseName)
          : this.getCurrentPhase();
        const step = stepName
          ? currentPhase?.steps.find(s => s.name === stepName)
          : this.getCurrentStep();
        if (step) {
          step.variables.set(name, value);
        } else {
          return;
        }
        break;
      }
    }

    this.addHistory('variable', phaseName, stepName, 'set', `${name} = ${JSON.stringify(value)}`);
    this.emitChange();
  }

  /**
   * Set an output value
   */
  public setOutput(name: string, value: unknown): void {
    if (!this.workflow) return;

    this.workflow.outputs.set(name, value);
    this.addHistory('output', undefined, undefined, 'set', `${name} = ${JSON.stringify(value)}`);
    this.emitChange();
  }

  /**
   * Advance to next step
   */
  public advanceStep(): boolean {
    if (!this.workflow) return false;

    const phase = this.getCurrentPhase();
    if (!phase) return false;

    phase.currentStepIndex++;

    // Check if phase is complete
    if (phase.currentStepIndex >= phase.steps.length) {
      phase.status = 'completed';
      this.workflow.currentPhaseIndex++;

      // Check if workflow is complete
      if (this.workflow.currentPhaseIndex >= this.workflow.phases.length) {
        this.workflow.status = 'completed';
        this.workflow.endTime = Date.now();
        this.emitChange();
        return false;
      }

      // Start next phase
      const nextPhase = this.workflow.phases[this.workflow.currentPhaseIndex];
      if (nextPhase) {
        nextPhase.status = 'running';
      }
    }

    this.emitChange();
    return true;
  }

  /**
   * Pause execution
   */
  public pause(): void {
    if (this.workflow && this.workflow.status === 'running') {
      this.workflow.status = 'paused';
      this.emitChange();
    }
  }

  /**
   * Resume execution
   */
  public resume(): void {
    if (this.workflow && this.workflow.status === 'paused') {
      this.workflow.status = 'running';
      this.emitChange();
    }
  }

  /**
   * Cancel execution
   */
  public cancel(): void {
    if (this.workflow) {
      this.workflow.status = 'cancelled';
      this.workflow.endTime = Date.now();
      this.emitChange();
    }
  }

  /**
   * Fail workflow
   */
  public fail(error?: string): void {
    if (this.workflow) {
      this.workflow.status = 'failed';
      this.workflow.endTime = Date.now();
      this.addHistory('phase', undefined, undefined, 'fail', error);
      this.emitChange();
    }
  }

  /**
   * Complete workflow
   */
  public complete(): void {
    if (this.workflow) {
      this.workflow.status = 'completed';
      this.workflow.endTime = Date.now();
      this.emitChange();
    }
  }

  /**
   * Get scopes for DAP variables request
   */
  public getScopes(_frameId: number): DebugScope[] {
    const scopes: DebugScope[] = [];

    // Local scope (current step variables)
    const localRef = this.createVariableReference('local', []);
    scopes.push({
      name: 'Local',
      presentationHint: 'locals',
      variablesReference: localRef,
      expensive: false,
    });

    // Phase scope
    const phaseRef = this.createVariableReference('phase', []);
    scopes.push({
      name: 'Phase',
      variablesReference: phaseRef,
      expensive: false,
    });

    // Workflow scope
    const workflowRef = this.createVariableReference('workflow', []);
    scopes.push({
      name: 'Workflow',
      variablesReference: workflowRef,
      expensive: false,
    });

    // Environment scope
    const envRef = this.createVariableReference('environment', []);
    scopes.push({
      name: 'Environment',
      variablesReference: envRef,
      expensive: false,
    });

    // Outputs scope
    if (this.workflow && this.workflow.outputs.size > 0) {
      const outputsRef = this.createVariableReference('workflow', ['outputs']);
      scopes.push({
        name: 'Outputs',
        variablesReference: outputsRef,
        expensive: false,
      });
    }

    return scopes;
  }

  /**
   * Get variables for a variable reference
   */
  public getVariables(variablesReference: number): DebugVariable[] {
    const refInfo = this.variableReferences.get(variablesReference);
    if (!refInfo || !this.workflow) {
      return [];
    }

    let variables: Map<string, unknown>;

    switch (refInfo.scope) {
      case 'local': {
        const step = this.getCurrentStep();
        variables = step?.variables ?? new Map();
        break;
      }
      case 'phase': {
        const phase = this.getCurrentPhase();
        variables = phase?.variables ?? new Map();
        break;
      }
      case 'workflow':
        if (refInfo.path.includes('outputs')) {
          variables = this.workflow.outputs;
        } else {
          variables = this.workflow.variables;
        }
        break;
      case 'environment':
        variables = this.workflow.environment as unknown as Map<string, unknown>;
        break;
      default:
        variables = new Map();
    }

    return this.mapToDebugVariables(variables);
  }

  /**
   * Get execution history
   */
  public getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  /**
   * Reset state
   */
  public reset(): void {
    this.workflow = undefined;
    this.variableReferences.clear();
    this.history = [];
    this.emitChange();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.reset();
    this.onStateChangeEmitter.dispose();
  }

  /**
   * Create a variable reference
   */
  private createVariableReference(scope: VariableScope, path: string[]): number {
    const ref = DebugExecutionState.variableReferenceCounter++;
    this.variableReferences.set(ref, { scope, path });
    return ref;
  }

  /**
   * Convert a Map to debug variables
   */
  private mapToDebugVariables(map: Map<string, unknown>): DebugVariable[] {
    const variables: DebugVariable[] = [];

    for (const [name, value] of map) {
      const isComplex = typeof value === 'object' && value !== null;

      variables.push({
        name,
        value: this.formatValue(value),
        type: this.getValueType(value),
        variablesReference: isComplex ? this.createChildReference(value) : 0,
        namedVariables: isComplex && !Array.isArray(value) ? Object.keys(value).length : undefined,
        indexedVariables: Array.isArray(value) ? value.length : undefined,
        evaluateName: name,
      });
    }

    return variables;
  }

  /**
   * Create a reference for nested objects
   */
  private createChildReference(_value: unknown): number {
    // For now, return 0 (no expansion)
    // Full implementation would track nested objects
    return 0;
  }

  /**
   * Format a value for display
   */
  private formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (typeof value === 'object') return `Object`;
    return String(value);
  }

  /**
   * Get the type of a value
   */
  private getValueType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * Add a history entry
   */
  private addHistory(
    type: HistoryEntry['type'],
    phaseName?: string,
    stepName?: string,
    action?: HistoryEntry['action'],
    details?: string
  ): void {
    this.history.push({
      timestamp: Date.now(),
      type,
      phaseName,
      stepName,
      action: action ?? 'start',
      details,
    });
  }

  /**
   * Emit state change event
   */
  private emitChange(): void {
    this.onStateChangeEmitter.fire(this.workflow);
  }
}

/**
 * Get singleton debug execution state
 */
let debugExecutionState: DebugExecutionState | undefined;

export function getDebugExecutionState(): DebugExecutionState {
  if (!debugExecutionState) {
    debugExecutionState = new DebugExecutionState();
  }
  return debugExecutionState;
}

/**
 * Reset singleton (for testing)
 */
export function resetDebugExecutionState(): void {
  debugExecutionState?.dispose();
  debugExecutionState = undefined;
}
