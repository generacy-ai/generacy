/**
 * CLI utility functions for action handlers.
 * Provides command execution and CLI availability checks.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Command execution options
 */
export interface CommandOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Command execution result
 */
export interface CommandResult {
  /** Exit code (0 = success) */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
}

/**
 * CLI availability status
 */
export interface CLIStatus {
  /** Whether the CLI is available */
  available: boolean;
  /** Version if available */
  version?: string;
  /** Error message if not available */
  error?: string;
}

/**
 * Check if a CLI tool is available
 * @param command The CLI command to check (e.g., 'git', 'gh', 'claude')
 * @param versionFlag The flag to get version (default: '--version')
 * @returns CLI status
 */
export async function checkCLI(
  command: string,
  versionFlag = '--version'
): Promise<CLIStatus> {
  try {
    const { stdout } = await execFileAsync(command, [versionFlag], {
      timeout: 5000,
    });
    // Extract version from output (usually first line, or number pattern)
    const versionMatch = stdout.match(/\d+\.\d+(\.\d+)?/);
    return {
      available: true,
      version: versionMatch ? versionMatch[0] : stdout.trim().split('\n')[0],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT') || message.includes('not found')) {
      return {
        available: false,
        error: `${command} is not installed. Please install it and try again.`,
      };
    }
    return {
      available: false,
      error: `Failed to check ${command}: ${message}`,
    };
  }
}

/**
 * Check all required CLIs for workflow execution
 * @returns Object with status for each CLI
 */
export async function checkAllCLIs(): Promise<Record<string, CLIStatus>> {
  const [git, gh, claude] = await Promise.all([
    checkCLI('git'),
    checkCLI('gh'),
    checkCLI('claude'),
  ]);

  return { git, gh, claude };
}

/**
 * Execute a command and return the result
 * @param command The command to execute
 * @param args Command arguments
 * @param options Execution options
 * @returns Command result
 */
export async function executeCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const { cwd, env, timeout, signal } = options;

  // If already aborted before we start, resolve immediately
  if (signal?.aborted) {
    return { exitCode: 130, stdout: '', stderr: 'Aborted before start' };
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // create process group so we can kill the entire tree
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    /** Kill the entire process group (negative PID) */
    const killProcessGroup = () => {
      if (killed) return;
      killed = true;
      if (proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          // Process may already be dead
          proc.kill('SIGTERM');
        }
      } else {
        proc.kill('SIGTERM');
      }
    };

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killProcessGroup();
      }, timeout);
    }

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);

      if (killed) {
        resolve({
          exitCode: 124, // Standard timeout exit code
          stdout,
          stderr: stderr + '\nProcess killed due to timeout',
        });
        return;
      }

      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
      });
    });

    // Handle abort signal — kills the entire process group
    if (signal) {
      signal.addEventListener('abort', () => {
        killProcessGroup();
      }, { once: true });
    }
  });
}

/**
 * Execute a command using shell (for complex commands with pipes, etc.)
 * @param command The shell command to execute
 * @param options Execution options
 * @returns Command result
 */
export async function executeShellCommand(
  command: string,
  options: CommandOptions = {}
): Promise<CommandResult> {
  const { cwd, env, timeout, signal } = options;

  // If already aborted before we start, resolve immediately
  if (signal?.aborted) {
    return { exitCode: 130, stdout: '', stderr: 'Aborted before start' };
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: true, // create process group so we can kill the entire tree
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    /** Kill the entire process group (negative PID) */
    const killProcessGroup = () => {
      if (killed) return;
      killed = true;
      if (proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          proc.kill('SIGTERM');
        }
      } else {
        proc.kill('SIGTERM');
      }
    };

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killProcessGroup();
      }, timeout);
    }

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);

      if (killed) {
        resolve({
          exitCode: 124,
          stdout,
          stderr: stderr + '\nProcess killed due to timeout',
        });
        return;
      }

      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
      });
    });

    // Handle abort signal — kills the entire process group
    if (signal) {
      signal.addEventListener('abort', () => {
        killProcessGroup();
      }, { once: true });
    }
  });
}

/**
 * Parse JSON output safely, returning null if parsing fails
 */
export function parseJSONSafe(output: string): unknown | null {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * Extract JSON from output that may contain non-JSON content
 * Looks for first { or [ and tries to parse from there
 */
export function extractJSON(output: string): unknown | null {
  // Try parsing the entire output first
  const direct = parseJSONSafe(output);
  if (direct !== null) return direct;

  // Look for JSON object or array start
  const objectStart = output.indexOf('{');
  const arrayStart = output.indexOf('[');

  let start = -1;
  if (objectStart >= 0 && arrayStart >= 0) {
    start = Math.min(objectStart, arrayStart);
  } else if (objectStart >= 0) {
    start = objectStart;
  } else if (arrayStart >= 0) {
    start = arrayStart;
  }

  if (start >= 0) {
    // Try to find matching end brace/bracket
    const substr = output.substring(start);
    return parseJSONSafe(substr);
  }

  return null;
}
