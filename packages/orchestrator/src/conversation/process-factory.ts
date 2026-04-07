import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ProcessFactory, ChildProcessHandle } from '../worker/types.js';

/**
 * ProcessFactory that pipes stdin (required for interactive conversations).
 * The default worker factory uses stdio: ['ignore', 'pipe', 'pipe'],
 * but conversations need ['pipe', 'pipe', 'pipe'] for stdin access.
 */
export const conversationProcessFactory: ProcessFactory = {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): ChildProcessHandle {
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
      child.on('error', () => {
        resolve(1);
      });
    });

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
      exitPromise,
    };
  },
};
