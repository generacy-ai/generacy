import type { ProcessFactory, ChildProcessHandle } from '../worker/types.js';
import { PTY_WRAPPER } from '@generacy-ai/generacy-plugin-claude-code';

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
