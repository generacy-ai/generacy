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
 * Options for running a single conversation turn.
 */
export interface ConversationTurnOptions {
  /** Working directory for the CLI process */
  cwd: string;
  /** The user message to send */
  message: string;
  /** Session ID to resume (omit for first turn) */
  sessionId?: string;
  /** Model to use */
  model?: string;
  /** Skip permission prompts */
  skipPermissions: boolean;
}

/**
 * Handle returned by ConversationSpawner.spawnTurn().
 * Wraps a ChildProcessHandle with stdout/stderr access.
 */
export interface ConversationProcessHandle extends ChildProcessHandle {
  /** Writable stream for stdin (not used in -p mode but required by interface) */
  stdin: NodeJS.WritableStream | null;
}

/**
 * Python PTY wrapper using pty.spawn for proper session/terminal setup.
 *
 * Claude Code is a native binary that uses full stdout buffering when
 * writing to a pipe. pty.spawn creates a proper PTY with correct
 * session and controlling terminal setup, forcing line-buffered output.
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
 * Spawns Claude CLI for conversation turns using -p (print) mode.
 *
 * Instead of a long-lived interactive process, each message spawns a
 * new Claude CLI process with `-p` and `--resume` for session continuity.
 * This avoids the PTY stdin issues that cause the bypass-permissions
 * dialog and ensures reliable streaming output.
 */
export class ConversationSpawner {
  constructor(
    private readonly processFactory: ProcessFactory,
    private readonly shutdownGracePeriodMs: number = 5000,
  ) {}

  /**
   * Spawn a single conversation turn using -p mode.
   *
   * Uses Python pty.spawn wrapper for unbuffered stdout streaming,
   * with `-p` for the message and `--resume` for session continuity.
   */
  spawnTurn(options: ConversationTurnOptions): ConversationProcessHandle {
    const claudeArgs = [
      'claude',
      '-p', options.message,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (options.sessionId) {
      claudeArgs.push('--resume', options.sessionId);
    }

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

    return child as ConversationProcessHandle;
  }

  /**
   * Legacy spawn for interface compatibility. Use spawnTurn instead.
   * @deprecated Use spawnTurn for per-message execution.
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
