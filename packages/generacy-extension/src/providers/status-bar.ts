/**
 * Status bar provider for workflow execution status.
 * Displays current execution state and progress in the VS Code status bar.
 */
import * as vscode from 'vscode';
import {
  getWorkflowExecutor,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutionStatus,
} from '../views/local/runner';
import { getLogger } from '../utils';

/**
 * Icons for different execution states
 */
const STATUS_ICONS: Record<ExecutionStatus, string> = {
  idle: '$(play)',
  running: '$(sync~spin)',
  paused: '$(debug-pause)',
  completed: '$(check)',
  failed: '$(error)',
  cancelled: '$(stop)',
};

/**
 * Colors for different execution states
 */
const STATUS_COLORS: Record<ExecutionStatus, vscode.ThemeColor | undefined> = {
  idle: undefined,
  running: new vscode.ThemeColor('statusBarItem.warningBackground'),
  paused: new vscode.ThemeColor('statusBarItem.warningBackground'),
  completed: undefined,
  failed: new vscode.ThemeColor('statusBarItem.errorBackground'),
  cancelled: undefined,
};

/**
 * Execution progress state for tracking
 */
interface ExecutionProgress {
  workflowName: string;
  status: ExecutionStatus;
  currentPhase?: string;
  currentStep?: string;
  totalPhases: number;
  completedPhases: number;
  totalSteps: number;
  completedSteps: number;
  startTime: number;
}

/**
 * Status bar provider for workflow execution
 */
export class ExecutionStatusBarProvider implements vscode.Disposable {
  private static instance: ExecutionStatusBarProvider | undefined;

  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private currentProgress: ExecutionProgress | undefined;
  private progressNotification: vscode.Disposable | undefined;

  private constructor() {
    // Create status bar item with high priority (right side)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.name = 'Generacy Workflow';
    this.statusBarItem.command = 'generacy.showExecutionOutput';
    this.updateStatusBar('idle');

    // Subscribe to executor events
    const executor = getWorkflowExecutor();
    const eventDisposable = executor.addEventListener((event) => {
      this.handleExecutionEvent(event);
    });
    this.disposables.push(eventDisposable);

    // Show status bar when not idle
    this.statusBarItem.hide();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ExecutionStatusBarProvider {
    if (!ExecutionStatusBarProvider.instance) {
      ExecutionStatusBarProvider.instance = new ExecutionStatusBarProvider();
    }
    return ExecutionStatusBarProvider.instance;
  }

  /**
   * Initialize the provider with extension context
   */
  public initialize(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.statusBarItem);

    // Register command to show output channel
    const showOutputCommand = vscode.commands.registerCommand(
      'generacy.showExecutionOutput',
      () => {
        vscode.commands.executeCommand('generacy.runWorkflow');
      }
    );
    context.subscriptions.push(showOutputCommand);

    const logger = getLogger();
    logger.info('Execution status bar initialized');
  }

  /**
   * Handle execution events from the executor
   */
  private handleExecutionEvent(event: ExecutionEvent): void {
    switch (event.type) {
      case 'execution:start':
        this.onExecutionStart(event);
        break;
      case 'execution:complete':
        this.onExecutionComplete(event);
        break;
      case 'execution:error':
        this.onExecutionError(event);
        break;
      case 'execution:cancel':
        this.onExecutionCancelled(event);
        break;
      case 'phase:start':
        this.onPhaseStart(event);
        break;
      case 'phase:complete':
        this.onPhaseComplete(event);
        break;
      case 'step:start':
        this.onStepStart(event);
        break;
      case 'step:complete':
        this.onStepComplete(event);
        break;
    }
  }

  /**
   * Handle execution start event
   */
  private onExecutionStart(event: ExecutionEvent): void {
    const executor = getWorkflowExecutor();
    const execution = executor.getCurrentExecution();

    this.currentProgress = {
      workflowName: event.workflowName,
      status: 'running',
      totalPhases: 0,
      completedPhases: 0,
      totalSteps: 0,
      completedSteps: 0,
      startTime: event.timestamp,
    };

    this.updateStatusBar('running', event.workflowName);
    this.statusBarItem.show();

    // Show progress notification
    this.showProgressNotification(event.workflowName, execution?.mode === 'dry-run');
  }

  /**
   * Handle execution complete event
   */
  private onExecutionComplete(event: ExecutionEvent): void {
    this.updateStatusBar('completed', event.workflowName);
    this.dismissProgressNotification();

    // Show completion summary
    const result = event.data as ExecutionResult | undefined;
    this.showCompletionSummary(event.workflowName, result, true);

    // Hide status bar after delay
    setTimeout(() => {
      if (this.currentProgress?.status === 'completed') {
        this.statusBarItem.hide();
        this.currentProgress = undefined;
      }
    }, 5000);
  }

  /**
   * Handle execution error event
   */
  private onExecutionError(event: ExecutionEvent): void {
    this.updateStatusBar('failed', event.workflowName);
    this.dismissProgressNotification();

    // Show failure summary
    const result = event.data as ExecutionResult | undefined;
    this.showCompletionSummary(event.workflowName, result, false);

    // Keep status bar visible longer for errors
    setTimeout(() => {
      if (this.currentProgress?.status === 'failed') {
        this.statusBarItem.hide();
        this.currentProgress = undefined;
      }
    }, 10000);
  }

  /**
   * Handle execution cancelled event
   */
  private onExecutionCancelled(event: ExecutionEvent): void {
    this.updateStatusBar('cancelled', event.workflowName);
    this.dismissProgressNotification();

    // Show cancellation notice
    vscode.window.showWarningMessage(
      `Workflow "${event.workflowName}" was cancelled`,
      'View Output'
    ).then(action => {
      if (action === 'View Output') {
        vscode.commands.executeCommand('workbench.action.output.show', 'Generacy Workflow');
      }
    });

    // Hide status bar after delay
    setTimeout(() => {
      if (this.currentProgress?.status === 'cancelled') {
        this.statusBarItem.hide();
        this.currentProgress = undefined;
      }
    }, 3000);
  }

  /**
   * Handle phase start event
   */
  private onPhaseStart(event: ExecutionEvent): void {
    if (this.currentProgress) {
      this.currentProgress.currentPhase = event.phaseName;
      this.currentProgress.currentStep = undefined;
      this.updateStatusBar(
        'running',
        `${event.workflowName}: ${event.phaseName}`
      );
    }
  }

  /**
   * Handle phase complete event
   */
  private onPhaseComplete(_event: ExecutionEvent): void {
    if (this.currentProgress) {
      this.currentProgress.completedPhases++;
    }
  }

  /**
   * Handle step start event
   */
  private onStepStart(event: ExecutionEvent): void {
    if (this.currentProgress) {
      this.currentProgress.currentStep = event.stepName;
      this.updateStatusBar(
        'running',
        `${event.workflowName}: ${event.phaseName} > ${event.stepName}`
      );
    }
  }

  /**
   * Handle step complete event
   */
  private onStepComplete(_event: ExecutionEvent): void {
    if (this.currentProgress) {
      this.currentProgress.completedSteps++;
    }
  }

  /**
   * Update status bar item appearance
   */
  private updateStatusBar(status: ExecutionStatus, text?: string): void {
    const icon = STATUS_ICONS[status];
    const color = STATUS_COLORS[status];

    if (this.currentProgress) {
      this.currentProgress.status = status;
    }

    this.statusBarItem.text = text ? `${icon} ${text}` : `${icon} Generacy`;
    this.statusBarItem.backgroundColor = color;

    // Update tooltip with detailed info
    if (this.currentProgress && status === 'running') {
      const elapsed = this.formatDuration(Date.now() - this.currentProgress.startTime);
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `**Generacy Workflow**\n\n` +
        `Workflow: ${this.currentProgress.workflowName}\n\n` +
        `Phase: ${this.currentProgress.currentPhase || 'Starting...'}\n\n` +
        `Step: ${this.currentProgress.currentStep || 'N/A'}\n\n` +
        `Elapsed: ${elapsed}\n\n` +
        `Click to view output`
      );
    } else {
      this.statusBarItem.tooltip = 'Generacy Workflow Execution';
    }
  }

  /**
   * Show progress notification during execution
   */
  private showProgressNotification(workflowName: string, isDryRun: boolean): void {
    // Cancel existing notification
    this.dismissProgressNotification();

    const title = isDryRun
      ? `Validating workflow: ${workflowName}`
      : `Running workflow: ${workflowName}`;

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, token) => {
        // Set up cancellation
        token.onCancellationRequested(() => {
          getWorkflowExecutor().cancel();
        });

        // Wait for execution to complete
        return new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            const executor = getWorkflowExecutor();
            const status = executor.getStatus();

            if (status !== 'running') {
              clearInterval(checkInterval);
              resolve();
            } else if (this.currentProgress) {
              // Update progress message
              const phase = this.currentProgress.currentPhase;
              const step = this.currentProgress.currentStep;
              const elapsed = this.formatDuration(Date.now() - this.currentProgress.startTime);

              progress.report({
                message: phase
                  ? `${phase}${step ? ` > ${step}` : ''} (${elapsed})`
                  : `Starting... (${elapsed})`,
              });
            }
          }, 500);
        });
      }
    );
  }

  /**
   * Dismiss progress notification
   */
  private dismissProgressNotification(): void {
    if (this.progressNotification) {
      this.progressNotification.dispose();
      this.progressNotification = undefined;
    }
  }

  /**
   * Show execution summary on completion
   */
  private showCompletionSummary(
    workflowName: string,
    result: ExecutionResult | undefined,
    success: boolean
  ): void {
    const duration = result?.duration
      ? this.formatDuration(result.duration)
      : 'unknown';

    const phaseCount = result?.phaseResults.length ?? 0;
    const stepCount = result?.phaseResults.reduce(
      (acc, phase) => acc + phase.stepResults.length,
      0
    ) ?? 0;

    const failedSteps = result?.phaseResults.reduce(
      (acc, phase) => acc + phase.stepResults.filter(s => s.status === 'failed').length,
      0
    ) ?? 0;

    if (success) {
      vscode.window.showInformationMessage(
        `✓ Workflow "${workflowName}" completed in ${duration} (${phaseCount} phases, ${stepCount} steps)`,
        'View Output'
      ).then(action => {
        if (action === 'View Output') {
          vscode.commands.executeCommand('workbench.action.output.show', 'Generacy Workflow');
        }
      });
    } else {
      const failureInfo = failedSteps > 0
        ? ` - ${failedSteps} step${failedSteps !== 1 ? 's' : ''} failed`
        : '';

      vscode.window.showErrorMessage(
        `✗ Workflow "${workflowName}" failed after ${duration}${failureInfo}`,
        'View Output',
        'Retry'
      ).then(action => {
        if (action === 'View Output') {
          vscode.commands.executeCommand('workbench.action.output.show', 'Generacy Workflow');
        } else if (action === 'Retry') {
          vscode.commands.executeCommand('generacy.runWorkflow');
        }
      });
    }
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }

    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes < 60) {
      return remainingSeconds > 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.dismissProgressNotification();
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    ExecutionStatusBarProvider.instance = undefined;
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    ExecutionStatusBarProvider.instance?.dispose();
    ExecutionStatusBarProvider.instance = undefined;
  }
}

/**
 * Get the singleton status bar provider
 */
export function getExecutionStatusBarProvider(): ExecutionStatusBarProvider {
  return ExecutionStatusBarProvider.getInstance();
}

/**
 * Initialize the execution status bar provider
 */
export function initializeExecutionStatusBar(context: vscode.ExtensionContext): void {
  const provider = getExecutionStatusBarProvider();
  provider.initialize(context);
}

/**
 * Status bar provider for cloud job count.
 * Shows the number of currently running cloud jobs.
 */
export class CloudJobStatusBarProvider implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.statusBarItem.name = 'Generacy Cloud Jobs';
    this.statusBarItem.command = 'generacy.queue.focus';
    this.statusBarItem.tooltip = 'Running cloud jobs';
    this.statusBarItem.hide();
  }

  /**
   * Update the displayed count of running cloud jobs.
   * Hides the status bar item when count is 0.
   */
  public updateCount(count: number): void {
    if (count === 0) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = `$(cloud) ${count} job${count !== 1 ? 's' : ''}`;
    this.statusBarItem.show();
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
