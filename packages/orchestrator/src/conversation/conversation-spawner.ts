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
 * Python PTY wrapper using pty.spawn for proper session/terminal setup.
 *
 * Claude Code is a native binary that uses full stdout buffering when
 * writing to a pipe. pty.spawn creates a proper PTY with correct
 * session and controlling terminal setup, forcing line-buffered output.
 *
 * The `read` callback forwards Claude's output to Python's stdout
 * (pipe to Node.js). The `stdin_read` callback forwards Node.js stdin
 * through the PTY to Claude.
 */
const PTY_WRAPPER = [
  'import pty, os, sys',
  'def read(fd):',
  '    data = os.read(fd, 65536)',
  '    sys.stdout.buffer.write(data)',
  '    sys.stdout.buffer.flush()',
  '    return data',
  'pty.spawn(sys.argv[1:], read)',
].join('\n');

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
   * Uses a Python pty.spawn wrapper to give Claude a proper PTY
   * (required for unbuffered streaming output from the native binary).
   *
   * When skipPermissions is true, Claude shows a bypass-permissions
   * confirmation dialog in the PTY. The caller must handle this by
   * watching stdout for the prompt and sending acceptance keystrokes.
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

    const child = this.processFactory.spawn('python3', ['-u', '-c', PTY_WRAPPER, ...claudeArgs], {
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
