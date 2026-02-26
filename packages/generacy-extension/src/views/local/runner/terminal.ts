/**
 * Terminal integration for interactive workflow commands.
 * Provides terminal management for command execution.
 */
import * as vscode from 'vscode';
import type { WorkflowStep, ExecutionOptions } from './types';

/**
 * Terminal execution result
 */
export interface TerminalResult {
  exitCode: number | undefined;
  output: string;
  error?: string;
}

/**
 * Terminal manager for workflow execution
 */
export class WorkflowTerminal {
  private static instance: WorkflowTerminal | undefined;
  private terminals: Map<string, vscode.Terminal> = new Map();
  private terminalOutputs: Map<string, string[]> = new Map();
  private readonly terminalPrefix = 'Generacy';

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WorkflowTerminal {
    if (!WorkflowTerminal.instance) {
      WorkflowTerminal.instance = new WorkflowTerminal();
    }
    return WorkflowTerminal.instance;
  }

  /**
   * Initialize terminal manager
   */
  public initialize(context: vscode.ExtensionContext): void {
    // Listen for terminal close events
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        // Find and remove the closed terminal from our map
        for (const [key, term] of this.terminals) {
          if (term === terminal) {
            this.terminals.delete(key);
            this.terminalOutputs.delete(key);
            break;
          }
        }
      })
    );
  }

  /**
   * Get or create a terminal for a workflow
   */
  public getOrCreateTerminal(
    workflowName: string,
    cwd?: string,
    env?: Record<string, string>
  ): vscode.Terminal {
    const terminalKey = `${this.terminalPrefix}: ${workflowName}`;

    // Check if terminal already exists and is still valid
    const existing = this.terminals.get(terminalKey);
    if (existing) {
      return existing;
    }

    // Create new terminal with options
    const terminalOptions: vscode.TerminalOptions = {
      name: terminalKey,
      cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: env,
    };

    const terminal = vscode.window.createTerminal(terminalOptions);
    this.terminals.set(terminalKey, terminal);
    this.terminalOutputs.set(terminalKey, []);

    return terminal;
  }

  /**
   * Execute a command in the terminal
   */
  public executeCommand(
    terminal: vscode.Terminal,
    command: string,
    show = true
  ): void {
    if (show) {
      terminal.show(true); // preserveFocus = true
    }
    terminal.sendText(command);
  }

  /**
   * Execute a step in the terminal
   */
  public async executeStep(
    step: WorkflowStep,
    options: ExecutionOptions,
    workflowName: string
  ): Promise<TerminalResult> {
    const terminal = this.getOrCreateTerminal(
      workflowName,
      options.cwd,
      { ...options.env, ...step.env }
    );

    // Get the command to execute
    const command = this.getStepCommand(step);

    if (!command) {
      return {
        exitCode: 0,
        output: 'No command to execute',
      };
    }

    // For dry-run, just return what would be executed
    if (options.mode === 'dry-run') {
      return {
        exitCode: 0,
        output: `[DRY-RUN] Would execute: ${command}`,
      };
    }

    // Execute the command
    this.executeCommand(terminal, command, options.verbose);

    // Note: VS Code terminals don't provide exit codes directly
    // For real execution results, we'd need to use child_process
    return {
      exitCode: undefined,
      output: `Executed: ${command}`,
    };
  }

  /**
   * Execute a step using child_process for capture
   */
  public async executeStepWithCapture(
    step: WorkflowStep,
    options: ExecutionOptions
  ): Promise<TerminalResult> {
    const command = this.getStepCommand(step);

    if (!command) {
      return {
        exitCode: 0,
        output: 'No command to execute',
      };
    }

    if (options.mode === 'dry-run') {
      return {
        exitCode: 0,
        output: `[DRY-RUN] Would execute: ${command}`,
      };
    }

    // Use VS Code's built-in task execution for better integration
    return this.executeWithTask(command, step.name, options);
  }

  /**
   * Execute a command using VS Code task API
   */
  private async executeWithTask(
    command: string,
    name: string,
    options: ExecutionOptions
  ): Promise<TerminalResult> {
    const shell = new vscode.ShellExecution(command, {
      cwd: options.cwd,
      env: options.env,
    });

    const task = new vscode.Task(
      { type: 'generacy', task: name },
      vscode.TaskScope.Workspace,
      name,
      'Generacy',
      shell
    );

    task.presentationOptions = {
      reveal: options.verbose ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Silent,
      echo: true,
      focus: false,
      panel: vscode.TaskPanelKind.Shared,
    };

    return new Promise((resolve) => {
      const disposables: vscode.Disposable[] = [];
      const output = '';

      // Listen for task end
      disposables.push(
        vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution.task === task) {
            disposables.forEach(d => d.dispose());
            resolve({
              exitCode: e.exitCode,
              output: output || `Command executed: ${command}`,
              error: e.exitCode !== 0 ? `Exit code: ${e.exitCode}` : undefined,
            });
          }
        })
      );

      // Start the task
      vscode.tasks.executeTask(task).then(
        () => {
          // Task started
        },
        (error) => {
          disposables.forEach(d => d.dispose());
          resolve({
            exitCode: 1,
            output: '',
            error: `Failed to execute task: ${error}`,
          });
        }
      );

      // Timeout handling
      if (options.env?.GENERACY_TIMEOUT) {
        const timeout = parseInt(options.env.GENERACY_TIMEOUT, 10);
        if (!isNaN(timeout) && timeout > 0) {
          setTimeout(() => {
            disposables.forEach(d => d.dispose());
            resolve({
              exitCode: 124, // Timeout exit code
              output,
              error: `Command timed out after ${timeout}ms`,
            });
          }, timeout);
        }
      }
    });
  }

  /**
   * Get the command string from a step
   */
  private getStepCommand(step: WorkflowStep): string | undefined {
    if (step.command) {
      return step.command;
    }
    if (step.script) {
      // For multi-line scripts, join with semicolons or newlines
      return step.script;
    }
    if (step.action === 'shell' || step.action === 'script') {
      return step.command || step.script;
    }
    return undefined;
  }

  /**
   * Show the terminal for a workflow
   */
  public showTerminal(workflowName: string): void {
    const terminalKey = `${this.terminalPrefix}: ${workflowName}`;
    const terminal = this.terminals.get(terminalKey);
    if (terminal) {
      terminal.show();
    }
  }

  /**
   * Dispose a specific terminal
   */
  public disposeTerminal(workflowName: string): void {
    const terminalKey = `${this.terminalPrefix}: ${workflowName}`;
    const terminal = this.terminals.get(terminalKey);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(terminalKey);
      this.terminalOutputs.delete(terminalKey);
    }
  }

  /**
   * Dispose all terminals
   */
  public disposeAll(): void {
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
    this.terminalOutputs.clear();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.disposeAll();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    WorkflowTerminal.instance?.dispose();
    WorkflowTerminal.instance = undefined;
  }
}

/**
 * Get the singleton terminal instance
 */
export function getWorkflowTerminal(): WorkflowTerminal {
  return WorkflowTerminal.getInstance();
}
