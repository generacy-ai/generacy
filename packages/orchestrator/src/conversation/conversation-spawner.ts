import type { ProcessFactory, ChildProcessHandle } from '../worker/types.js';

/**
 * Options for spawning an interactive conversation process.
 */
export interface ConversationSpawnOptions {
  /** Working directory for the CLI process */
  cwd: string;
  /** Model to use (omit for CLI default) */
  model?: string;
  /** Skip permission prompts */
  skipPermissions: boolean;
}

/**
 * Handle returned by ConversationSpawner.spawn().
 * Wraps a ChildProcessHandle and adds stdin access.
 */
export interface ConversationProcessHandle extends ChildProcessHandle {
  /** Writable stream for sending messages to stdin */
  stdin: NodeJS.WritableStream;
}

/**
 * Python wrapper script that creates a PTY for stdout only.
 *
 * Claude Code is a native binary that uses full stdout buffering when
 * writing to a pipe. This prevents streaming events from reaching the
 * output parser until the process exits.
 *
 * A full PTY (via `script -qec`) would fix the buffering but makes
 * Claude show interactive prompts (bypass-permissions dialog) since
 * it detects a terminal on stdin.
 *
 * This wrapper allocates a PTY for stdout/stderr only (via Python's
 * pty.openpty), keeping stdin as a regular pipe. Claude sees a TTY
 * on stdout (line-buffered output) but a pipe on stdin (no interactive
 * prompts).
 */
const PTY_WRAPPER = `
import pty, os, sys, signal

master_fd, slave_fd = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master_fd)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    os.close(slave_fd)
    os.execvp(sys.argv[1], sys.argv[1:])
else:
    os.close(slave_fd)
    signal.signal(signal.SIGTERM, lambda *a: os.kill(pid, signal.SIGTERM))
    while True:
        try:
            data = os.read(master_fd, 65536)
            if not data:
                break
            os.write(1, data)
        except OSError:
            break
    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`.trim();

/**
 * Spawns Claude CLI in interactive mode with stream-json output.
 *
 * Unlike CliSpawner (which uses `-p` for single-prompt execution),
 * ConversationSpawner creates long-lived interactive processes that
 * accept messages on stdin and stream structured JSON on stdout.
 */
export class ConversationSpawner {
  constructor(
    private readonly processFactory: ProcessFactory,
    private readonly shutdownGracePeriodMs: number = 5000,
  ) {}

  /**
   * Spawn an interactive Claude CLI process.
   *
   * Uses a Python PTY wrapper to give Claude unbuffered stdout
   * (via a pseudo-TTY) while keeping stdin as a regular pipe
   * to avoid interactive prompt dialogs.
   */
  spawn(options: ConversationSpawnOptions): ConversationProcessHandle {
    const claudeArgs = [
      'claude',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (options.skipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    if (options.model) {
      claudeArgs.push('--model', options.model);
    }

    const child = this.processFactory.spawn('python3', ['-c', PTY_WRAPPER, ...claudeArgs], {
      cwd: options.cwd,
      env: {},
    });

    if (!child.stdin) {
      throw new Error('Failed to open stdin for conversation process');
    }

    return child as ConversationProcessHandle;
  }

  /**
   * Send SIGTERM, wait the grace period, then SIGKILL if still alive.
   */
  gracefulKill(handle: ChildProcessHandle): void {
    handle.kill('SIGTERM');

    const killTimer = setTimeout(() => {
      handle.kill('SIGKILL');
    }, this.shutdownGracePeriodMs);

    void handle.exitPromise.then(() => {
      clearTimeout(killTimer);
    });
  }
}
