import { execFile } from 'node:child_process';

export interface CommandRunnerOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: CommandRunnerOptions,
) => Promise<CommandResult>;

/**
 * Default runner using `node:child_process.execFile` with a 30s timeout.
 * Does not throw on non-zero exit code — the wrapper inspects `exitCode`.
 */
export const nodeChildProcessRunner: CommandRunner = (cmd, args, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  return new Promise<CommandResult>((resolve) => {
    execFile(
      cmd,
      args,
      {
        env: opts?.env != null ? { ...process.env, ...opts.env } : process.env,
        cwd: opts?.cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout: string | Buffer, stderr: string | Buffer) => {
        const stdoutStr =
          typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf-8');
        const stderrStr =
          typeof stderr === 'string' ? stderr : Buffer.from(stderr).toString('utf-8');
        let exitCode = 0;
        if (error) {
          const errWithCode = error as NodeJS.ErrnoException & { code?: number | string };
          if (typeof errWithCode.code === 'number') {
            exitCode = errWithCode.code;
          } else {
            exitCode = 1;
          }
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode });
      },
    );
  });
};
