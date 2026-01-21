/**
 * Output channel for workflow execution logs.
 * Provides structured output with timestamps, colors, and log levels.
 */
import * as vscode from 'vscode';
import type { ExecutionEvent } from './types';

/**
 * Log level for output channel
 */
export type OutputLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

/**
 * Workflow output channel manager
 */
export class WorkflowOutputChannel {
  private static instance: WorkflowOutputChannel | undefined;
  private outputChannel: vscode.OutputChannel | undefined;
  private readonly channelName = 'Generacy Runner';

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WorkflowOutputChannel {
    if (!WorkflowOutputChannel.instance) {
      WorkflowOutputChannel.instance = new WorkflowOutputChannel();
    }
    return WorkflowOutputChannel.instance;
  }

  /**
   * Initialize the output channel
   */
  public initialize(context: vscode.ExtensionContext): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel(this.channelName);
      context.subscriptions.push(this.outputChannel);
    }
  }

  /**
   * Show the output channel
   */
  public show(preserveFocus = true): void {
    this.outputChannel?.show(preserveFocus);
  }

  /**
   * Hide the output channel
   */
  public hide(): void {
    this.outputChannel?.hide();
  }

  /**
   * Clear the output channel
   */
  public clear(): void {
    this.outputChannel?.clear();
  }

  /**
   * Write a line to the output channel
   */
  public writeLine(message: string): void {
    this.outputChannel?.appendLine(message);
  }

  /**
   * Write a log message with timestamp and level
   */
  public log(level: OutputLogLevel, message: string): void {
    const timestamp = this.formatTimestamp(new Date());
    const levelTag = this.getLevelTag(level);
    this.writeLine(`[${timestamp}] ${levelTag} ${message}`);
  }

  /**
   * Log debug message
   */
  public debug(message: string): void {
    this.log('debug', message);
  }

  /**
   * Log info message
   */
  public info(message: string): void {
    this.log('info', message);
  }

  /**
   * Log warning message
   */
  public warn(message: string): void {
    this.log('warn', message);
  }

  /**
   * Log error message
   */
  public error(message: string): void {
    this.log('error', message);
  }

  /**
   * Log success message
   */
  public success(message: string): void {
    this.log('success', message);
  }

  /**
   * Write a section header
   */
  public writeHeader(title: string): void {
    const line = '='.repeat(60);
    this.writeLine('');
    this.writeLine(line);
    this.writeLine(`  ${title}`);
    this.writeLine(line);
    this.writeLine('');
  }

  /**
   * Write a section separator
   */
  public writeSeparator(char = '-'): void {
    this.writeLine(char.repeat(60));
  }

  /**
   * Write workflow execution start
   */
  public writeExecutionStart(workflowName: string, mode: string): void {
    this.clear();
    this.writeHeader(`Workflow: ${workflowName}`);
    this.info(`Mode: ${mode}`);
    this.info(`Started at: ${new Date().toISOString()}`);
    this.writeLine('');
  }

  /**
   * Write workflow execution complete
   */
  public writeExecutionComplete(workflowName: string, duration: number, success: boolean): void {
    this.writeLine('');
    this.writeSeparator('=');
    if (success) {
      this.success(`Workflow "${workflowName}" completed successfully`);
    } else {
      this.error(`Workflow "${workflowName}" failed`);
    }
    this.info(`Duration: ${this.formatDuration(duration)}`);
    this.writeSeparator('=');
  }

  /**
   * Write phase start
   */
  public writePhaseStart(phaseName: string, phaseIndex: number, totalPhases: number): void {
    this.writeLine('');
    this.writeSeparator();
    this.info(`Phase [${phaseIndex + 1}/${totalPhases}]: ${phaseName}`);
    this.writeSeparator();
  }

  /**
   * Write phase complete
   */
  public writePhaseComplete(phaseName: string, duration: number, success: boolean): void {
    if (success) {
      this.success(`Phase "${phaseName}" completed (${this.formatDuration(duration)})`);
    } else {
      this.error(`Phase "${phaseName}" failed (${this.formatDuration(duration)})`);
    }
  }

  /**
   * Write step start
   */
  public writeStepStart(stepName: string, stepIndex: number, totalSteps: number): void {
    this.info(`Step [${stepIndex + 1}/${totalSteps}]: ${stepName}`);
  }

  /**
   * Write step output
   */
  public writeStepOutput(output: string): void {
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.writeLine(`    ${line}`);
      }
    }
  }

  /**
   * Write step complete
   */
  public writeStepComplete(stepName: string, duration: number, success: boolean): void {
    if (success) {
      this.success(`  Step "${stepName}" completed (${this.formatDuration(duration)})`);
    } else {
      this.error(`  Step "${stepName}" failed (${this.formatDuration(duration)})`);
    }
  }

  /**
   * Write step skipped
   */
  public writeStepSkipped(stepName: string, reason?: string): void {
    this.warn(`  Step "${stepName}" skipped${reason ? `: ${reason}` : ''}`);
  }

  /**
   * Write dry-run notice
   */
  public writeDryRunNotice(): void {
    this.writeLine('');
    this.warn('DRY-RUN MODE: Commands will not be executed');
    this.writeLine('');
  }

  /**
   * Write environment variables
   */
  public writeEnvironment(env: Record<string, string>): void {
    const entries = Object.entries(env);
    if (entries.length === 0) {
      return;
    }

    this.info('Environment Variables:');
    for (const [key, value] of entries) {
      // Mask sensitive values
      const maskedValue = this.isSensitiveKey(key) ? '********' : value;
      this.writeLine(`    ${key}=${maskedValue}`);
    }
  }

  /**
   * Handle execution event
   */
  public handleEvent(event: ExecutionEvent): void {
    switch (event.type) {
      case 'execution:start':
        this.info(event.message || `Starting workflow: ${event.workflowName}`);
        break;
      case 'execution:complete':
        this.success(event.message || `Workflow completed: ${event.workflowName}`);
        break;
      case 'execution:error':
        this.error(event.message || `Workflow error: ${event.workflowName}`);
        break;
      case 'execution:cancel':
        this.warn(event.message || `Workflow cancelled: ${event.workflowName}`);
        break;
      case 'phase:start':
        this.info(event.message || `Starting phase: ${event.phaseName}`);
        break;
      case 'phase:complete':
        this.success(event.message || `Phase completed: ${event.phaseName}`);
        break;
      case 'phase:error':
        this.error(event.message || `Phase error: ${event.phaseName}`);
        break;
      case 'step:start':
        this.info(event.message || `Starting step: ${event.stepName}`);
        break;
      case 'step:complete':
        this.success(event.message || `Step completed: ${event.stepName}`);
        break;
      case 'step:error':
        this.error(event.message || `Step error: ${event.stepName}`);
        break;
      case 'step:output':
        if (event.message) {
          this.writeStepOutput(event.message);
        }
        break;
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.outputChannel?.dispose();
    this.outputChannel = undefined;
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    WorkflowOutputChannel.instance?.dispose();
    WorkflowOutputChannel.instance = undefined;
  }

  /**
   * Format timestamp
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

  /**
   * Format duration in milliseconds to human-readable
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Get level tag for log output
   */
  private getLevelTag(level: OutputLogLevel): string {
    switch (level) {
      case 'debug':
        return '[DEBUG]';
      case 'info':
        return '[INFO] ';
      case 'warn':
        return '[WARN] ';
      case 'error':
        return '[ERROR]';
      case 'success':
        return '[OK]   ';
      default:
        return '[LOG]  ';
    }
  }

  /**
   * Check if a key is sensitive
   */
  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = [
      'password',
      'secret',
      'token',
      'key',
      'api_key',
      'apikey',
      'auth',
      'credential',
    ];
    const lowerKey = key.toLowerCase();
    return sensitivePatterns.some(pattern => lowerKey.includes(pattern));
  }
}

/**
 * Get the singleton output channel instance
 */
export function getRunnerOutputChannel(): WorkflowOutputChannel {
  return WorkflowOutputChannel.getInstance();
}
