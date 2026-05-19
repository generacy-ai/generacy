/**
 * CLI utility functions for action handlers.
 * Provides command execution and CLI availability checks.
 */
import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { getProcessLauncher } from './process-launcher.js';

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
  /** Callback for stdout chunks (for real-time streaming) */
  onStdout?: (chunk: string) => void;
  /** Callback for stderr chunks */
  onStderr?: (chunk: string) => void;
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
  const { cwd, env, timeout, signal, onStdout, onStderr } = options;

  // If already aborted before we start, resolve immediately
  if (signal?.aborted) {
    return { exitCode: 130, stdout: '', stderr: 'Aborted before start' };
  }

  // Spawn via registered launcher or direct child_process.spawn
  const launcher = getProcessLauncher();
  let procStdout: NodeJS.ReadableStream | null;
  let procStderr: NodeJS.ReadableStream | null;
  let procPid: number | undefined;
  let procKill: (sig?: NodeJS.Signals) => boolean;
  let procExitPromise: Promise<number | null>;
  let procOnError: ((handler: (err: Error) => void) => void) | undefined;

  if (launcher) {
    const handle = await launcher({
      kind: 'generic-subprocess',
      command,
      args,
      cwd: cwd ?? process.cwd(),
      env,
      signal,
      detached: true,
    });
    procStdout = handle.stdout;
    procStderr = handle.stderr;
    procPid = handle.pid;
    procKill = (sig) => handle.kill(sig);
    procExitPromise = handle.exitPromise;
  } else {
    // Wave 5 lint allow-list: direct spawn fallback for external consumers
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // create process group so we can kill the entire tree
    });
    procStdout = proc.stdout;
    procStderr = proc.stderr;
    procPid = proc.pid;
    procKill = (sig) => proc.kill(sig);
    procExitPromise = new Promise<number | null>((resolve) => {
      proc.on('close', (code) => resolve(code));
    });
    procOnError = (handler) => proc.on('error', handler);
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    // Use StringDecoder to handle multi-byte UTF-8 characters across chunk boundaries
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    /** Kill the entire process group (negative PID) */
    const killProcessGroup = () => {
      if (killed) return;
      killed = true;
      if (procPid) {
        try {
          process.kill(-procPid, 'SIGTERM');
        } catch {
          // Process may already be dead
          procKill('SIGTERM');
        }
      } else {
        procKill('SIGTERM');
      }
    };

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killProcessGroup();
      }, timeout);
    }

    procStdout?.on('data', (data: Buffer) => {
      const decoded = stdoutDecoder.write(data);
      stdout += decoded;
      onStdout?.(decoded);
    });

    procStderr?.on('data', (data: Buffer) => {
      const decoded = stderrDecoder.write(data);
      stderr += decoded;
      onStderr?.(decoded);
    });

    procOnError?.((error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    procExitPromise.then((code) => {
      if (timeoutId) clearTimeout(timeoutId);

      // Flush remaining bytes from decoders
      const stdoutRemaining = stdoutDecoder.end();
      const stderrRemaining = stderrDecoder.end();
      if (stdoutRemaining) {
        stdout += stdoutRemaining;
        onStdout?.(stdoutRemaining);
      }
      if (stderrRemaining) {
        stderr += stderrRemaining;
        onStderr?.(stderrRemaining);
      }

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

  // Spawn via registered launcher or direct child_process.spawn
  const launcher = getProcessLauncher();
  let procStdout: NodeJS.ReadableStream | null;
  let procStderr: NodeJS.ReadableStream | null;
  let procPid: number | undefined;
  let procKill: (sig?: NodeJS.Signals) => boolean;
  let procExitPromise: Promise<number | null>;
  let procOnError: ((handler: (err: Error) => void) => void) | undefined;

  if (launcher) {
    const handle = await launcher({
      kind: 'shell',
      command,
      args: [],
      cwd: cwd ?? process.cwd(),
      env,
      signal,
      detached: true,
    });
    procStdout = handle.stdout;
    procStderr = handle.stderr;
    procPid = handle.pid;
    procKill = (sig) => handle.kill(sig);
    procExitPromise = handle.exitPromise;
  } else {
    // Wave 5 lint allow-list: direct spawn fallback for external consumers
    const proc = spawn(command, [], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: true, // create process group so we can kill the entire tree
    });
    procStdout = proc.stdout;
    procStderr = proc.stderr;
    procPid = proc.pid;
    procKill = (sig) => proc.kill(sig);
    procExitPromise = new Promise<number | null>((resolve) => {
      proc.on('close', (code) => resolve(code));
    });
    procOnError = (handler) => proc.on('error', handler);
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    /** Kill the entire process group (negative PID) */
    const killProcessGroup = () => {
      if (killed) return;
      killed = true;
      if (procPid) {
        try {
          process.kill(-procPid, 'SIGTERM');
        } catch {
          procKill('SIGTERM');
        }
      } else {
        procKill('SIGTERM');
      }
    };

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killProcessGroup();
      }, timeout);
    }

    procStdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    procStderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    procOnError?.((error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    procExitPromise.then((code) => {
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
