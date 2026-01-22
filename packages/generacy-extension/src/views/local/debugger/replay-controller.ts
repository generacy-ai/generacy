/**
 * Replay controller for workflow debugging.
 * Provides "replay from step" functionality to re-execute from a specific point.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';
import { getDebugSession, type DebugSessionConfig, type ExecutionPosition } from './session';
import { getDebugExecutionState, type HistoryEntry, type WorkflowState } from '../../../debug';
import type { ExecutableWorkflow, WorkflowPhase, WorkflowStep } from '../runner/types';

/**
 * Replay options
 */
export interface ReplayOptions {
  /** Phase name to start from */
  phaseName: string;
  /** Step name to start from (optional, defaults to first step in phase) */
  stepName?: string;
  /** Whether to stop at the replay point */
  stopOnEntry?: boolean;
  /** Preserved state from previous execution */
  preservedState?: ReplayState;
}

/**
 * State to preserve when replaying
 */
export interface ReplayState {
  /** Environment variables */
  env: Record<string, string>;
  /** Workflow-level variables */
  variables: Record<string, unknown>;
  /** Outputs from steps executed before the replay point */
  outputs: Record<string, unknown>;
}

/**
 * Replay point info
 */
export interface ReplayPoint {
  phaseIndex: number;
  stepIndex: number;
  phaseName: string;
  stepName?: string;
  timestamp?: number;
}

/**
 * Replay controller
 */
export class ReplayController {
  private static instance: ReplayController | undefined;
  private currentReplayPoint: ReplayPoint | undefined;
  private savedStates: Map<string, ReplayState> = new Map();

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): ReplayController {
    if (!ReplayController.instance) {
      ReplayController.instance = new ReplayController();
    }
    return ReplayController.instance;
  }

  /**
   * Get available replay points from execution history
   */
  public getAvailableReplayPoints(): ReplayPoint[] {
    const state = getDebugExecutionState();
    const workflowState = state.getWorkflowState();
    const history = state.getHistory();

    if (!workflowState) {
      return [];
    }

    const replayPoints: ReplayPoint[] = [];
    const seenSteps = new Set<string>();

    // Build replay points from execution history
    for (const entry of history) {
      if (entry.type === 'step' && entry.action === 'start' && entry.phaseName && entry.stepName) {
        const key = `${entry.phaseName}:${entry.stepName}`;
        if (!seenSteps.has(key)) {
          seenSteps.add(key);

          // Find phase and step indices
          const phaseIndex = workflowState.phases.findIndex(p => p.name === entry.phaseName);
          if (phaseIndex >= 0) {
            const phase = workflowState.phases[phaseIndex];
            const stepIndex = phase?.steps.findIndex(s => s.name === entry.stepName) ?? -1;

            if (stepIndex >= 0) {
              replayPoints.push({
                phaseIndex,
                stepIndex,
                phaseName: entry.phaseName,
                stepName: entry.stepName,
                timestamp: entry.timestamp,
              });
            }
          }
        }
      }
    }

    return replayPoints;
  }

  /**
   * Get all possible replay points from workflow structure
   */
  public getAllReplayPointsFromWorkflow(workflow: ExecutableWorkflow): ReplayPoint[] {
    const replayPoints: ReplayPoint[] = [];

    for (let phaseIndex = 0; phaseIndex < workflow.phases.length; phaseIndex++) {
      const phase = workflow.phases[phaseIndex];
      if (!phase) continue;

      for (let stepIndex = 0; stepIndex < phase.steps.length; stepIndex++) {
        const step = phase.steps[stepIndex];
        if (!step) continue;

        replayPoints.push({
          phaseIndex,
          stepIndex,
          phaseName: phase.name,
          stepName: step.name,
        });
      }
    }

    return replayPoints;
  }

  /**
   * Save state at a specific point for replay
   */
  public saveStateAtPoint(point: ReplayPoint): void {
    const state = getDebugExecutionState();
    const workflowState = state.getWorkflowState();

    if (!workflowState) {
      return;
    }

    const key = `${point.phaseName}:${point.stepName ?? 'start'}`;

    // Capture state at this point
    const replayState: ReplayState = {
      env: Object.fromEntries(workflowState.environment),
      variables: Object.fromEntries(workflowState.variables),
      outputs: this.collectOutputsBeforePoint(workflowState, point),
    };

    this.savedStates.set(key, replayState);
  }

  /**
   * Collect outputs from steps executed before the replay point
   */
  private collectOutputsBeforePoint(workflowState: WorkflowState, point: ReplayPoint): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};

    for (let phaseIndex = 0; phaseIndex <= point.phaseIndex; phaseIndex++) {
      const phase = workflowState.phases[phaseIndex];
      if (!phase) continue;

      const maxStepIndex = phaseIndex < point.phaseIndex
        ? phase.steps.length
        : point.stepIndex;

      for (let stepIndex = 0; stepIndex < maxStepIndex; stepIndex++) {
        const step = phase.steps[stepIndex];
        if (step && (step.status === 'completed' || step.status === 'failed')) {
          const key = `${phase.name}.${step.name}`;
          outputs[key] = {
            status: step.status,
            output: step.output,
            error: step.error,
            exitCode: step.exitCode,
            variables: Object.fromEntries(step.variables),
          };
        }
      }
    }

    return outputs;
  }

  /**
   * Replay from a specific point
   */
  public async replayFromPoint(point: ReplayPoint, workflow: ExecutableWorkflow, uri: vscode.Uri): Promise<void> {
    const logger = getLogger();
    const session = getDebugSession();

    logger.info(`Replay from ${point.phaseName}:${point.stepName ?? 'start'}`);

    // Get saved state if available
    const key = `${point.phaseName}:${point.stepName ?? 'start'}`;
    const savedState = this.savedStates.get(key);

    // Terminate current session if active
    if (session.isActive()) {
      session.terminate();
    }

    // Create modified workflow starting from the replay point
    const modifiedWorkflow = this.createWorkflowFromPoint(workflow, point);

    // Configure new debug session
    const config: DebugSessionConfig = {
      workflow: modifiedWorkflow,
      uri,
      options: {
        mode: 'normal',
        env: savedState?.env,
      },
      stopOnEntry: true,
    };

    // Store replay info
    this.currentReplayPoint = point;

    // Start the session
    await session.start(config);

    // Restore state if available
    if (savedState) {
      await this.restoreState(savedState);
    }
  }

  /**
   * Create a workflow that starts from a specific point
   */
  private createWorkflowFromPoint(workflow: ExecutableWorkflow, point: ReplayPoint): ExecutableWorkflow {
    const modifiedPhases: WorkflowPhase[] = [];

    for (let phaseIndex = point.phaseIndex; phaseIndex < workflow.phases.length; phaseIndex++) {
      const phase = workflow.phases[phaseIndex];
      if (!phase) continue;

      if (phaseIndex === point.phaseIndex && point.stepName) {
        // For the starting phase, skip steps before the replay point
        const startStepIndex = phase.steps.findIndex(s => s.name === point.stepName);
        if (startStepIndex > 0) {
          const modifiedPhase: WorkflowPhase = {
            name: phase.name,
            condition: phase.condition,
            steps: phase.steps.slice(startStepIndex),
          };
          modifiedPhases.push(modifiedPhase);
          continue;
        }
      }

      modifiedPhases.push(phase);
    }

    return {
      ...workflow,
      phases: modifiedPhases,
    };
  }

  /**
   * Restore state from a previous execution
   */
  private async restoreState(state: ReplayState): Promise<void> {
    const debugState = getDebugExecutionState();

    // Restore environment
    for (const [key, value] of Object.entries(state.env)) {
      debugState.setVariable('environment', key, value);
    }

    // Restore workflow variables
    for (const [key, value] of Object.entries(state.variables)) {
      debugState.setVariable('workflow', key, value);
    }

    // Restore outputs
    for (const [key, value] of Object.entries(state.outputs)) {
      debugState.setOutput(key, value);
    }
  }

  /**
   * Check if currently replaying
   */
  public isReplaying(): boolean {
    return this.currentReplayPoint !== undefined;
  }

  /**
   * Get current replay point
   */
  public getCurrentReplayPoint(): ReplayPoint | undefined {
    return this.currentReplayPoint;
  }

  /**
   * Clear replay state
   */
  public clearReplayState(): void {
    this.currentReplayPoint = undefined;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.savedStates.clear();
    this.currentReplayPoint = undefined;
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    ReplayController.instance?.dispose();
    ReplayController.instance = undefined;
  }
}

/**
 * Quick pick item for replay point selection
 */
class ReplayPointQuickPickItem implements vscode.QuickPickItem {
  public label: string;
  public description: string;
  public detail?: string;

  constructor(public readonly point: ReplayPoint) {
    this.label = `$(debug-restart) ${point.stepName ?? 'Phase Start'}`;
    this.description = point.phaseName;
    this.detail = point.timestamp
      ? `Executed at ${new Date(point.timestamp).toLocaleTimeString()}`
      : undefined;
  }
}

/**
 * Register replay commands
 */
export function registerReplayCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const controller = ReplayController.getInstance();

  // Replay from step command
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.replayFromStep', async () => {
      const logger = getLogger();
      const session = getDebugSession();

      // Get available replay points
      const points = controller.getAvailableReplayPoints();

      if (points.length === 0) {
        vscode.window.showInformationMessage('No replay points available. Execute some steps first.');
        return;
      }

      // Show quick pick
      const items = points.map(p => new ReplayPointQuickPickItem(p));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a step to replay from',
        title: 'Replay From Step',
      });

      if (!selected) {
        return;
      }

      // Need workflow and URI from current session
      // This would need to be stored or retrieved from the session
      logger.info(`Replay requested from: ${selected.point.phaseName}:${selected.point.stepName}`);

      vscode.window.showInformationMessage(
        `Replay from "${selected.point.stepName}" in phase "${selected.point.phaseName}" - Use the debug configuration to start a new session.`
      );
    })
  );

  // Save state at current position
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.saveReplayPoint', () => {
      const session = getDebugSession();
      const position = session.getPosition();

      if (!position) {
        vscode.window.showWarningMessage('No active debug position to save');
        return;
      }

      const point: ReplayPoint = {
        phaseIndex: position.phaseIndex,
        stepIndex: position.stepIndex,
        phaseName: position.phaseName,
        stepName: position.stepName,
        timestamp: Date.now(),
      };

      controller.saveStateAtPoint(point);
      vscode.window.showInformationMessage(
        `Saved replay point: ${position.phaseName}:${position.stepName ?? 'start'}`
      );
    })
  );

  return disposables;
}

/**
 * Get the replay controller
 */
export function getReplayController(): ReplayController {
  return ReplayController.getInstance();
}
