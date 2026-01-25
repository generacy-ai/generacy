/**
 * Event bridge between WorkflowExecutor events and DebugExecutionState.
 * Subscribes to executor ExecutionEvent emissions and translates them
 * to DebugExecutionState updates for the variables view, history panel,
 * and error analysis.
 */
import * as vscode from 'vscode';
import { WorkflowExecutor } from '../runner/executor';
import {
  getDebugExecutionState,
  type DebugExecutionState,
} from '../../../debug';
import type {
  ExecutionEvent,
  ExecutionEventListener,
  StepResult,
} from '../runner/types';

/**
 * Bridge between executor events and debug execution state.
 * Translates real-time executor events into debug state updates
 * so that variables view, history panel, and error analysis
 * show real data from the executor.
 */
export class ExecutorEventBridge {
  private executor: WorkflowExecutor;
  private state: DebugExecutionState;
  private eventSubscription: vscode.Disposable | undefined;
  private _connected = false;

  constructor(executor: WorkflowExecutor, state: DebugExecutionState) {
    this.executor = executor;
    this.state = state;
  }

  /**
   * Whether the bridge is currently connected
   */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Start listening to executor events and translating them to state updates
   */
  connect(): void {
    if (this._connected) {
      return;
    }

    const listener: ExecutionEventListener = (event: ExecutionEvent) => {
      this.handleEvent(event);
    };

    this.eventSubscription = this.executor.addEventListener(listener);
    this._connected = true;
  }

  /**
   * Stop listening to executor events
   */
  disconnect(): void {
    if (!this._connected) {
      return;
    }

    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
    this._connected = false;
  }

  /**
   * Handle an executor event and translate it to debug state updates
   */
  handleEvent(event: ExecutionEvent): void {
    switch (event.type) {
      case 'execution:start':
        this.handleExecutionStart(event);
        break;
      case 'phase:start':
        this.handlePhaseStart(event);
        break;
      case 'step:start':
        this.handleStepStart(event);
        break;
      case 'step:complete':
        this.handleStepComplete(event);
        break;
      case 'step:error':
        this.handleStepError(event);
        break;
      case 'phase:complete':
        this.handlePhaseComplete(event);
        break;
      case 'execution:complete':
        this.handleExecutionComplete(event);
        break;
      case 'execution:error':
        this.handleExecutionError(event);
        break;
      // step:output, action:start, action:complete, action:error, action:retry
      // are fine-grained events we don't need to map to state
    }
  }

  private handleExecutionStart(event: ExecutionEvent): void {
    this.state.startWorkflow(event.workflowName);
  }

  private handlePhaseStart(event: ExecutionEvent): void {
    if (event.phaseName) {
      this.state.startPhase(event.phaseName);
    }
  }

  private handleStepStart(event: ExecutionEvent): void {
    if (event.stepName) {
      this.state.startStep(event.stepName);

      // Populate input variables from the executor context
      const executionContext = this.executor.getExecutionContext();
      if (executionContext) {
        const inputs = executionContext.getInputs();
        for (const [key, value] of Object.entries(inputs)) {
          this.state.setVariable('local', key, value);
        }
      }
    }
  }

  private handleStepComplete(event: ExecutionEvent): void {
    if (event.stepName) {
      const stepResult = event.data as StepResult | undefined;

      // Update step output variables from the executor context
      const executionContext = this.executor.getExecutionContext();
      if (executionContext) {
        const stepOutput = executionContext.getStepOutput(event.stepName);
        if (stepOutput) {
          this.state.setOutput(`${event.phaseName ?? ''}.${event.stepName}`, {
            raw: stepOutput.raw,
            parsed: stepOutput.parsed,
            exitCode: stepOutput.exitCode,
          });
        }
      }

      this.state.completeStep(
        stepResult?.output,
        stepResult?.exitCode
      );
    }
  }

  private handleStepError(event: ExecutionEvent): void {
    const stepResult = event.data as StepResult | undefined;
    // Fail with the error message
    this.state.fail(
      stepResult?.error ?? event.message ?? 'Unknown step error'
    );
  }

  private handlePhaseComplete(event: ExecutionEvent): void {
    if (event.phaseName) {
      this.state.completePhase();
    }
  }

  private handleExecutionComplete(_event: ExecutionEvent): void {
    this.state.complete();
  }

  private handleExecutionError(event: ExecutionEvent): void {
    this.state.fail(event.message ?? 'Execution failed');
  }

  /**
   * Dispose of the bridge and clean up subscriptions
   */
  dispose(): void {
    this.disconnect();
  }
}
