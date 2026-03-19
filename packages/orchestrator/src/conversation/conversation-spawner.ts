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
   */
  spawn(options: ConversationSpawnOptions): ConversationProcessHandle {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    const child = this.processFactory.spawn('claude', args, {
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
