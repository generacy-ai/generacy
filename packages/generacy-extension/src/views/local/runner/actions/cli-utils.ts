/**
 * CLI utility functions for action handlers.
 * Provides command execution and CLI availability checks.
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

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

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      signal,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
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

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        proc.kill('SIGTERM');
      });
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

  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      signal,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
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

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        proc.kill('SIGTERM');
      });
    }
  });
}

/**
 * Result from a Claude CLI session
 */
export interface ClaudeSessionResult extends CommandResult {
  /** Captured session ID for resumption */
  sessionId?: string;
  /** Detected phases during execution */
  detectedPhases: string[];
}

/**
 * Options for Claude CLI session execution
 */
export interface ClaudeSessionOptions extends CommandOptions {
  /** Session ID to resume (for multi-step workflows) */
  resumeSessionId?: string;
  /** Callback when a phase change is detected */
  phaseCallback?: (phase: string) => void;
  /** Callback for streaming stdout progress */
  progressCallback?: (text: string) => void;
}

/**
 * Execute a Claude Code CLI session using the correct invocation pattern.
 * Uses --dangerously-skip-permissions with skill as positional argument.
 * Captures session ID from stdout and detects phase changes.
 *
 * @param skillCommand The skill to invoke (e.g., "/speckit:specify")
 * @param options Session execution options
 * @returns Claude session result with session ID and phases
 */
export async function executeClaudeSession(
  skillCommand: string,
  options: ClaudeSessionOptions = {}
): Promise<ClaudeSessionResult> {
  const { cwd, env, timeout, signal, resumeSessionId, phaseCallback, progressCallback } = options;

  const args = ['--dangerously-skip-permissions'];

  // Add session resumption if available
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  // Skill command is the positional argument
  args.push(skillCommand);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let capturedSessionId: string | undefined;
    const detectedPhases: string[] = [];

    // Session ID regex - matches UUID format from Claude output
    const sessionIdRegex = /(?:"sessionId"|Session)[":\s]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

    // Phase detection regex - matches <command-message>speckit:plan is running…</command-message>
    const phaseRegex = /<command-message>(speckit):(\w+) is running/;

    // Handle timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
      }, timeout);
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;

      // Try to capture session ID
      if (!capturedSessionId) {
        const sessionMatch = text.match(sessionIdRegex);
        if (sessionMatch) {
          capturedSessionId = sessionMatch[1];
        }
      }

      // Detect phase changes
      const phaseMatch = text.match(phaseRegex);
      if (phaseMatch && phaseCallback) {
        const phase = `${phaseMatch[1]}:${phaseMatch[2]}`;
        detectedPhases.push(phase);
        try {
          phaseCallback(phase);
        } catch {
          // Non-blocking - phase update failures should not affect execution
        }
      }

      // Stream progress
      if (progressCallback) {
        try {
          progressCallback(text);
        } catch {
          // Non-blocking
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
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
          sessionId: capturedSessionId,
          detectedPhases,
        });
        return;
      }

      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
        sessionId: capturedSessionId,
        detectedPhases,
      });
    });
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
