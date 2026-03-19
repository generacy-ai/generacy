import type { ConversationConfig } from '../config/schema.js';
import type { Logger } from '../worker/types.js';
import { ConversationSpawner } from './conversation-spawner.js';
import { ConversationOutputParser } from './output-parser.js';
import type {
  ConversationHandle,
  ConversationInfo,
  ConversationStartOptions,
  ConversationOutputCallback,
  ConversationOutputEvent,
} from './types.js';

/**
 * Manages interactive Claude Code conversation processes.
 *
 * Uses a per-turn spawning model: each message spawns a new Claude CLI
 * process with `-p` and `--resume` for session continuity. This avoids
 * PTY/buffering issues with long-lived interactive processes while
 * maintaining conversation context across turns.
 */
export class ConversationManager {
  private readonly conversations = new Map<string, ConversationHandle>();
  private readonly spawner: ConversationSpawner;
  private readonly config: ConversationConfig;
  private readonly logger: Logger;
  private onOutput: ConversationOutputCallback | null = null;

  constructor(
    config: ConversationConfig,
    spawner: ConversationSpawner,
    logger: Logger,
  ) {
    this.config = config;
    this.spawner = spawner;
    this.logger = logger;
  }

  /**
   * Register a callback for conversation output events.
   */
  setOutputCallback(callback: ConversationOutputCallback): void {
    this.onOutput = callback;
  }

  /**
   * Start a new conversation.
   */
  async start(options: ConversationStartOptions): Promise<ConversationInfo> {
    // Check for duplicate conversation ID
    if (this.conversations.has(options.conversationId)) {
      const error = new Error(`Conversation ${options.conversationId} already exists`);
      (error as any).statusCode = 409;
      throw error;
    }

    // Check concurrency limit
    if (this.config.maxConcurrent > 0 && this.conversations.size >= this.config.maxConcurrent) {
      const error = new Error(
        `Max concurrent conversations (${this.config.maxConcurrent}) reached`,
      );
      (error as any).statusCode = 429;
      throw error;
    }

    // Resolve workspace identifier to filesystem path
    const workingDirectory = this.resolveWorkspace(options.workingDirectory);

    const skipPermissions = options.skipPermissions ?? true;
    const model = options.model ?? this.config.defaultModel;

    const handle: ConversationHandle = {
      conversationId: options.conversationId,
      workingDirectory,
      workspaceId: options.workingDirectory,
      skipPermissions,
      process: null as any, // No long-lived process; per-turn spawning
      startedAt: new Date().toISOString(),
      model,
      initialCommand: options.initialCommand,
      state: 'active',
      stdin: null,
    };

    this.conversations.set(options.conversationId, handle);

    this.logger.info(
      {
        conversationId: options.conversationId,
        workspaceId: options.workingDirectory,
        model,
      },
      'Conversation started',
    );

    // Run initial command as the first turn
    if (options.initialCommand) {
      this.runTurn(options.conversationId, options.initialCommand);
    }

    return this.toInfo(handle);
  }

  /**
   * Send a message to an active conversation.
   */
  async sendMessage(conversationId: string, message: string): Promise<void> {
    const handle = this.conversations.get(conversationId);
    if (!handle) {
      const error = new Error(`Conversation ${conversationId} not found`);
      (error as any).statusCode = 404;
      throw error;
    }

    if (handle.state !== 'active') {
      const error = new Error(
        `Conversation ${conversationId} is not active (state: ${handle.state})`,
      );
      (error as any).statusCode = 409;
      throw error;
    }

    this.runTurn(conversationId, message);
  }

  /**
   * Run a single conversation turn by spawning Claude CLI with -p and --resume.
   */
  private runTurn(conversationId: string, message: string): void {
    const handle = this.conversations.get(conversationId);
    if (!handle) return;

    const processHandle = this.spawner.spawnTurn({
      cwd: handle.workingDirectory,
      message,
      sessionId: handle.sessionId,
      model: handle.model,
      skipPermissions: handle.skipPermissions,
    });

    // Track current process for cleanup
    handle.process = processHandle;

    // Set up output parsing
    const parser = new ConversationOutputParser({
      onEvent: (event: ConversationOutputEvent) => {
        this.emitOutputEvent(conversationId, event);
      },
      onSessionId: (sessionId: string) => {
        // Capture session ID from first turn for --resume on subsequent turns
        if (!handle.sessionId) {
          handle.sessionId = sessionId;
          this.logger.info(
            { conversationId, sessionId },
            'Conversation session initialized',
          );
        }
      },
      onError: (error: string) => {
        this.logger.warn(
          { conversationId, error },
          'Conversation output parse error',
        );
      },
    });

    // Attach stdout parser
    if (processHandle.stdout) {
      processHandle.stdout.on('data', (data: Buffer | string) => {
        parser.processChunk(typeof data === 'string' ? data : data.toString('utf-8'));
      });
    }

    // Attach stderr logging
    if (processHandle.stderr) {
      processHandle.stderr.on('data', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        this.logger.debug(
          { conversationId, stderr: text.trim() },
          'Conversation stderr',
        );
      });
    }

    // Handle process exit
    void processHandle.exitPromise.then((exitCode) => {
      parser.flush();

      const currentHandle = this.conversations.get(conversationId);
      if (!currentHandle) return;

      // Clear process reference — ready for next turn
      if (currentHandle.process === processHandle) {
        currentHandle.process = null as any;
      }

      if (exitCode !== 0 && exitCode !== null) {
        this.logger.warn(
          { conversationId, exitCode },
          'Conversation turn exited with non-zero code',
        );
      }
    });
  }

  /**
   * End a conversation gracefully.
   */
  async end(conversationId: string): Promise<ConversationInfo> {
    const handle = this.conversations.get(conversationId);
    if (!handle) {
      const error = new Error(`Conversation ${conversationId} not found`);
      (error as any).statusCode = 404;
      throw error;
    }

    if (handle.state === 'ended') {
      return this.toInfo(handle);
    }

    handle.state = 'ending';

    // Kill any running turn process
    if (handle.process) {
      this.spawner.gracefulKill(handle.process);
      try {
        await handle.process.exitPromise;
      } catch {
        // Process may have already exited
      }
    }

    handle.state = 'ended';
    this.conversations.delete(conversationId);

    this.logger.info({ conversationId }, 'Conversation ended');

    // Emit complete event
    this.emitOutputEvent(conversationId, {
      event: 'complete',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    return this.toInfo(handle);
  }

  /**
   * Check if a session is currently active by matching sessionId
   * across all conversation handles.
   */
  isSessionActive(sessionId: string): boolean {
    for (const handle of this.conversations.values()) {
      if (handle.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  /**
   * List all active conversations.
   */
  list(): ConversationInfo[] {
    return Array.from(this.conversations.values()).map((h) => this.toInfo(h));
  }

  /**
   * Stop all active conversations (called during graceful shutdown).
   */
  async stop(): Promise<void> {
    const conversationIds = Array.from(this.conversations.keys());
    this.logger.info(
      { count: conversationIds.length },
      'Stopping all conversations',
    );

    await Promise.all(conversationIds.map((id) => this.end(id)));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private resolveWorkspace(workspaceId: string): string {
    const path = this.config.workspaces[workspaceId];
    if (!path) {
      const error = new Error(
        `Unknown workspace "${workspaceId}". Available: ${Object.keys(this.config.workspaces).join(', ') || 'none'}`,
      );
      (error as any).statusCode = 400;
      throw error;
    }
    return path;
  }

  private emitOutputEvent(conversationId: string, event: ConversationOutputEvent): void {
    if (this.onOutput) {
      try {
        this.onOutput(conversationId, event);
      } catch (error) {
        this.logger.error(
          { conversationId, err: error instanceof Error ? error.message : String(error) },
          'Error in conversation output callback',
        );
      }
    }
  }

  private toInfo(handle: ConversationHandle): ConversationInfo {
    return {
      conversationId: handle.conversationId,
      workspaceId: handle.workspaceId,
      model: handle.model,
      sessionId: handle.sessionId,
      skipPermissions: handle.skipPermissions,
      startedAt: handle.startedAt,
      state: handle.state,
    };
  }
}
