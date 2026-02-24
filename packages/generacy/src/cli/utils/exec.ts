/**
 * Shell execution utilities for CLI commands.
 * Wraps child_process.execSync and spawn with structured logging.
 */
import { execSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { getLogger } from './logger.js';

/**
 * Options for synchronous command execution.
 */
export interface ExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables merged with process.env */
  env?: Record<string, string | undefined>;
  /** Execution timeout in milliseconds */
  timeout?: number;
  /** stdout/stderr handling: 'pipe' captures output, 'inherit' streams to parent */
  stdio?: 'pipe' | 'inherit';
}

/**
 * Result of a safe (non-throwing) command execution.
 */
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a command synchronously, return stdout. Throws on non-zero exit.
 */
export function exec(cmd: string, options?: ExecOptions): string {
  const logger = getLogger();
  logger.debug({ cmd, cwd: options?.cwd }, 'exec');
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      timeout: options?.timeout,
      stdio: options?.stdio === 'inherit' ? 'inherit' : 'pipe',
    }).trim();
  } catch (error) {
    logger.error({ cmd, error: String(error) }, 'Command failed');
    throw error;
  }
}

/**
 * Run a command synchronously, return success boolean. Does not throw.
 */
export function execSafe(cmd: string, options?: ExecOptions): ExecResult {
  const logger = getLogger();
  logger.debug({ cmd, cwd: options?.cwd }, 'execSafe');
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      timeout: options?.timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (error: unknown) {
    const execError = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = typeof execError.stdout === 'string'
      ? execError.stdout.trim()
      : (execError.stdout?.toString() ?? '').trim();
    const stderr = typeof execError.stderr === 'string'
      ? execError.stderr.trim()
      : (execError.stderr?.toString() ?? '').trim();
    return { ok: false, stdout, stderr };
  }
}

/**
 * Spawn a long-running background process. Returns ChildProcess.
 */
export function spawnBackground(
  cmd: string,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  const logger = getLogger();
  logger.debug({ cmd, args, cwd: options?.cwd }, 'spawnBackground');
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    ...options,
  });
  child.unref();
  return child;
}
