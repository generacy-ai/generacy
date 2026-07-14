import { execFile, spawn } from 'node:child_process';

export interface CommandRunnerOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Optional UTF-8 payload piped to the child's stdin. When set the runner
   * uses `spawn` (execFile's callback API does not expose stdin ergonomically);
   * otherwise the child inherits/ignores stdin as before.
   */
  stdin?: string;
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

function runWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  opts: CommandRunnerOptions | undefined,
): Promise<CommandResult> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, args, {
      env: opts?.env != null ? { ...process.env, ...opts.env } : process.env,
      cwd: opts?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = typeof code === 'number' ? code : killed ? 124 : 1;
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin.on('error', () => {
      // Ignore EPIPE: child may exit before we finish writing.
    });
    child.stdin.end(stdin);
  });
}

/**
 * Default runner using `node:child_process.execFile` with a 30s timeout.
 * Does not throw on non-zero exit code — the wrapper inspects `exitCode`.
 * Switches to `spawn` when the caller supplies `stdin`.
 */
export const nodeChildProcessRunner: CommandRunner = (cmd, args, opts) => {
  if (opts?.stdin != null) {
    return runWithStdin(cmd, args, opts.stdin, opts);
  }
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
