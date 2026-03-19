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
 * Handles lifecycle (start/sendMessage/end/list), concurrency limiting,
 * workspace resolution, output streaming, and process cleanup.
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

    // Spawn the CLI process
    const processHandle = this.spawner.spawn({
      cwd: workingDirectory,
      model,
      skipPermissions,
    });

    const handle: ConversationHandle = {
      conversationId: options.conversationId,
      workingDirectory,
      workspaceId: options.workingDirectory,
      skipPermissions,
      process: processHandle,
      startedAt: new Date().toISOString(),
      model,
      initialCommand: options.initialCommand,
      state: 'starting',
      stdin: processHandle.stdin,
    };

    this.conversations.set(options.conversationId, handle);

    // Set up output parsing
    const parser = new ConversationOutputParser({
      onEvent: (event: ConversationOutputEvent) => {
        this.handleOutputEvent(options.conversationId, event);
      },
      onSessionId: (sessionId: string) => {
        handle.sessionId = sessionId;
        handle.state = 'active';
        this.logger.info(
          { conversationId: options.conversationId, sessionId },
          'Conversation session initialized',
        );
      },
      onError: (error: string) => {
        this.logger.warn(
          { conversationId: options.conversationId, error },
          'Conversation output parse error',
        );
      },
    });

    // Attach stdout parser with bypass-prompt auto-acceptance.
    // When using a PTY, Claude shows a bypass-permissions confirmation dialog.
    // We detect it and send keystrokes to accept (down-arrow → Enter).
    let bypassAccepted = false;
    if (processHandle.stdout) {
      let rawBuffer = '';
      processHandle.stdout.on('data', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8');

        // Before the init JSON arrives, watch for the bypass prompt
        if (!bypassAccepted) {
          rawBuffer += text;
          if (rawBuffer.includes('Yes') && rawBuffer.includes('accept')) {
            // Send down-arrow (select "Yes, I accept") then Enter
            this.writeToStdin(handle, '\x1b[B\r');
            bypassAccepted = true;
            rawBuffer = '';
            return; // Don't parse the prompt text
          }
          // If we get JSON, the prompt was skipped (no PTY or already accepted)
          if (text.includes('{"type":')) {
            bypassAccepted = true;
            rawBuffer = '';
            parser.processChunk(text);
          }
          return;
        }

        parser.processChunk(text);
      });
    }

    // Attach stderr logging
    if (processHandle.stderr) {
      processHandle.stderr.on('data', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        this.logger.debug(
          { conversationId: options.conversationId, stderr: text.trim() },
          'Conversation stderr',
        );
      });
    }

    // Handle unexpected process exit
    this.attachExitHandler(options.conversationId, parser);

    // Transition to active (even without init event, after setup)
    if (handle.state === 'starting') {
      handle.state = 'active';
    }

    // Send initial command if provided
    if (options.initialCommand) {
      this.writeToStdin(handle, options.initialCommand);
    }

    this.logger.info(
      {
        conversationId: options.conversationId,
        workspaceId: options.workingDirectory,
        model,
      },
      'Conversation started',
    );

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

    this.writeToStdin(handle, message);
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

    // Close stdin to signal EOF
    if (handle.stdin) {
      try {
        (handle.stdin as NodeJS.WritableStream & { end: () => void }).end();
      } catch {
        // stdin may already be closed
      }
    }

    // Graceful kill
    this.spawner.gracefulKill(handle.process);

    // Wait for process to exit
    try {
      await handle.process.exitPromise;
    } catch {
      // Process may have already exited
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

  private writeToStdin(handle: ConversationHandle, message: string): void {
    if (!handle.stdin) {
      throw new Error(`Conversation ${handle.conversationId} stdin is not available`);
    }

    const data = message.endsWith('\n') ? message : message + '\n';
    (handle.stdin as NodeJS.WritableStream & { write: (data: string) => boolean }).write(data);
  }

  private handleOutputEvent(conversationId: string, event: ConversationOutputEvent): void {
    this.emitOutputEvent(conversationId, event);
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

  private attachExitHandler(conversationId: string, parser: ConversationOutputParser): void {
    const handle = this.conversations.get(conversationId);
    if (!handle) return;

    void handle.process.exitPromise.then((exitCode) => {
      // Flush any remaining parser buffer
      parser.flush();

      // Only handle unexpected exits (not our own end() call)
      const currentHandle = this.conversations.get(conversationId);
      if (!currentHandle || currentHandle.state === 'ending' || currentHandle.state === 'ended') {
        return;
      }

      this.logger.warn(
        { conversationId, exitCode },
        'Conversation process exited unexpectedly',
      );

      currentHandle.state = 'ended';
      this.conversations.delete(conversationId);

      this.emitOutputEvent(conversationId, {
        event: 'error',
        payload: { message: 'Process exited', exitCode },
        timestamp: new Date().toISOString(),
      });
    });
  }

  private toInfo(handle: ConversationHandle): ConversationInfo {
    return {
      conversationId: handle.conversationId,
      workspaceId: handle.workspaceId,
      model: handle.model,
      skipPermissions: handle.skipPermissions,
      startedAt: handle.startedAt,
      state: handle.state,
    };
  }
}
