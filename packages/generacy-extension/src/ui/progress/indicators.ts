/**
 * Progress indication utilities for VS Code extension
 */
import * as vscode from 'vscode';

/**
 * Progress location preference
 */
export enum ProgressLocation {
  /** Show in notification area */
  Notification = 'notification',

  /** Show in status bar */
  StatusBar = 'statusBar',

  /** Show in window (blocking) */
  Window = 'window',
}

/**
 * Progress configuration
 */
export interface ProgressConfig {
  /** Operation title */
  title: string;

  /** Initial message */
  message?: string;

  /** Whether operation can be cancelled */
  cancellable?: boolean;

  /** Progress location */
  location?: ProgressLocation;

  /** Timeout to show progress (ms). Operations shorter than this won't show progress. */
  showThreshold?: number;
}

/**
 * Progress reporter interface
 */
export interface ProgressReporter {
  /** Report progress update */
  report(options: { message?: string; increment?: number }): void;

  /** Check if cancellation was requested */
  isCancellationRequested: boolean;
}

/**
 * Time-based threshold rules for progress display
 */
const PROGRESS_THRESHOLDS = {
  /** No indicator for instant operations */
  INSTANT: 100, // ms

  /** Status bar only for quick operations */
  QUICK: 2000, // ms

  /** Notification for medium operations */
  MEDIUM: 10000, // ms

  /** Notification with percentage for long operations */
  LONG: 10000, // ms
} as const;

/**
 * Execute operation with progress reporting
 */
export async function withProgress<T>(
  config: ProgressConfig,
  task: (
    progress: ProgressReporter,
    token: vscode.CancellationToken
  ) => Promise<T>
): Promise<T> {
  const location = mapLocationToVSCode(config.location ?? ProgressLocation.Notification);

  return vscode.window.withProgress(
    {
      location,
      title: config.title,
      cancellable: config.cancellable ?? false,
    },
    async (progress, token) => {
      // Report initial message
      if (config.message) {
        progress.report({ message: config.message });
      }

      // Create progress reporter wrapper
      const reporter: ProgressReporter = {
        report: (options) => progress.report(options),
        isCancellationRequested: token.isCancellationRequested,
      };

      return task(reporter, token);
    }
  );
}

/**
 * Show quick progress in status bar
 */
export function showStatusBarProgress(
  message: string,
  durationMs: number = 2000
): vscode.Disposable {
  return vscode.window.setStatusBarMessage(`$(sync~spin) ${message}`, durationMs);
}

/**
 * Show progress notification with cancellation support
 */
export async function showNotificationProgress<T>(
  title: string,
  task: (
    progress: ProgressReporter,
    token: vscode.CancellationToken
  ) => Promise<T>,
  cancellable: boolean = false
): Promise<T> {
  return withProgress(
    {
      title,
      cancellable,
      location: ProgressLocation.Notification,
    },
    task
  );
}

/**
 * Execute task with automatic progress threshold detection
 */
export async function withAutomaticProgress<T>(
  title: string,
  task: (
    progress: ProgressReporter,
    token: vscode.CancellationToken
  ) => Promise<T>,
  options?: {
    cancellable?: boolean;
    forceShow?: boolean;
  }
): Promise<T> {
  const startTime = Date.now();
  let progressDisposable: vscode.Disposable | undefined;
  let progressShown = false;

  // Create a delayed progress show
  const showProgressAfterDelay = () => {
    if (!progressShown && !options?.forceShow) {
      setTimeout(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed > PROGRESS_THRESHOLDS.INSTANT && !progressShown) {
          progressDisposable = showStatusBarProgress(title);
          progressShown = true;
        }
      }, PROGRESS_THRESHOLDS.INSTANT);
    }
  };

  try {
    // For very quick operations, don't show progress at all
    if (!options?.forceShow) {
      showProgressAfterDelay();
    }

    // Use notification progress for operations we know will be long
    if (options?.forceShow) {
      return await withProgress(
        {
          title,
          cancellable: options?.cancellable ?? false,
          location: ProgressLocation.Notification,
        },
        task
      );
    }

    // Execute without progress UI for potentially quick operations
    const result = await task(
      {
        report: () => {}, // No-op progress reporting
        isCancellationRequested: false,
      },
      new vscode.CancellationTokenSource().token
    );

    return result;
  } finally {
    progressDisposable?.dispose();
  }
}

/**
 * Create a progress reporter for multi-step operations
 */
export class MultiStepProgress {
  private currentStep = 0;

  constructor(
    private readonly reporter: ProgressReporter,
    private readonly totalSteps: number
  ) {}

  /**
   * Report progress for next step
   */
  public nextStep(message: string): void {
    this.currentStep++;
    const increment = (1 / this.totalSteps) * 100;
    this.reporter.report({
      message: `(${this.currentStep}/${this.totalSteps}) ${message}`,
      increment,
    });
  }

  /**
   * Report progress for current step
   */
  public updateStep(message: string): void {
    this.reporter.report({
      message: `(${this.currentStep}/${this.totalSteps}) ${message}`,
    });
  }

  /**
   * Check if cancelled
   */
  public get isCancelled(): boolean {
    return this.reporter.isCancellationRequested;
  }

  /**
   * Get current step number
   */
  public get step(): number {
    return this.currentStep;
  }

  /**
   * Get progress percentage
   */
  public get percentage(): number {
    return (this.currentStep / this.totalSteps) * 100;
  }
}

/**
 * Create multi-step progress wrapper
 */
export function createMultiStepProgress(
  reporter: ProgressReporter,
  totalSteps: number
): MultiStepProgress {
  return new MultiStepProgress(reporter, totalSteps);
}

/**
 * Map progress location to VS Code location
 */
function mapLocationToVSCode(
  location: ProgressLocation
): vscode.ProgressLocation {
  switch (location) {
    case ProgressLocation.Notification:
      return vscode.ProgressLocation.Notification;
    case ProgressLocation.StatusBar:
      return vscode.ProgressLocation.Window;
    case ProgressLocation.Window:
      return vscode.ProgressLocation.Window;
  }
}
