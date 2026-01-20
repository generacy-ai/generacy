/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Main plugin class that wires all components together.
 */

import Docker from 'dockerode';
import pino from 'pino';
import type { Logger } from 'pino';

import {
  SessionInvalidStateError,
  wrapError,
} from '../errors.js';
import type {
  Session as SessionInterface,
  ClaudeCodePluginInterface,
  ContainerConfig,
  InvokeParams,
  InvokeOptions,
  InvocationResult,
  OutputChunk,
} from '../types.js';
import { ContainerConfigSchema, InvokeParamsSchema } from '../schemas.js';
import { ContainerManager } from '../container/container-manager.js';
import { SessionManager } from '../session/session-manager.js';
import { Session } from '../session/session.js';
import { Invoker } from '../invocation/invoker.js';
import { createOutputStream } from '../streaming/output-stream.js';

/**
 * Configuration options for ClaudeCodePlugin.
 */
export interface ClaudeCodePluginOptions {
  /** Docker client options or instance */
  docker?: Docker | Docker.DockerOptions;

  /** Logger instance or pino options */
  logger?: Logger | pino.LoggerOptions;

  /** Session timeout in milliseconds */
  sessionTimeoutMs?: number;

  /** Maximum concurrent sessions */
  maxSessions?: number;

  /** Default container configuration */
  defaultContainerConfig?: Partial<ContainerConfig>;

  /** Default invocation options */
  defaultInvokeOptions?: InvokeOptions;
}

/**
 * ClaudeCodePlugin - Main plugin class for Claude Code agent invocation.
 *
 * Provides a thin interface for invoking Claude Code agents in isolated
 * Docker containers, with session management, output streaming, and
 * integration with the Humancy decision framework.
 */
export class ClaudeCodePlugin implements ClaudeCodePluginInterface {
  private readonly docker: Docker;
  private readonly logger: Logger;
  private readonly containerManager: ContainerManager;
  private readonly sessionManager: SessionManager;
  private readonly invoker: Invoker;
  private readonly defaultContainerConfig: Partial<ContainerConfig>;
  private readonly defaultInvokeOptions: InvokeOptions;
  private disposed = false;

  constructor(options: ClaudeCodePluginOptions = {}) {
    // Initialize Docker client
    this.docker = options.docker instanceof Docker
      ? options.docker
      : new Docker(options.docker);

    // Initialize logger
    if (options.logger && 'info' in options.logger) {
      this.logger = options.logger as Logger;
    } else {
      this.logger = pino({
        name: 'claude-code-plugin',
        level: process.env.LOG_LEVEL ?? 'info',
        ...options.logger,
      });
    }

    // Initialize container manager
    this.containerManager = new ContainerManager(this.docker, this.logger);

    // Initialize session manager
    this.sessionManager = new SessionManager(this.logger, {
      sessionTimeoutMs: options.sessionTimeoutMs,
      maxSessions: options.maxSessions,
    });

    // Initialize invoker
    this.invoker = new Invoker(this.containerManager, this.logger);

    // Store defaults
    this.defaultContainerConfig = options.defaultContainerConfig ?? {};
    this.defaultInvokeOptions = options.defaultInvokeOptions ?? {};

    this.logger.info('ClaudeCodePlugin initialized');
  }

  /**
   * Invoke Claude Code with parameters.
   * Creates an ephemeral session if no sessionId provided.
   */
  async invoke(params: InvokeParams): Promise<InvocationResult> {
    this.ensureNotDisposed();

    // Validate params
    const validated = InvokeParamsSchema.parse(params);

    this.logger.info(
      { sessionId: validated.sessionId, prompt: validated.prompt.slice(0, 100) },
      'Invoking Claude Code'
    );

    // Get or create session
    let session: Session;
    let isEphemeral = false;

    if (validated.sessionId) {
      session = this.sessionManager.get(validated.sessionId);
    } else {
      // Create ephemeral session
      const config = await this.createEphemeralContainerConfig();
      session = await this.startSessionInternal(config);
      isEphemeral = true;
    }

    try {
      // Merge options
      const options: InvokeOptions = {
        ...this.defaultInvokeOptions,
        ...session.defaultOptions,
        ...validated.options,
      };

      // Execute invocation
      const result = await this.invoker.invoke(session, validated.prompt, options);

      return result;
    } finally {
      // Cleanup ephemeral session
      if (isEphemeral) {
        await this.endSession(session.id);
      }
    }
  }

  /**
   * Convenience method for simple prompt invocation.
   */
  async invokeWithPrompt(
    prompt: string,
    options?: InvokeOptions
  ): Promise<InvocationResult> {
    return this.invoke({ prompt, options });
  }

  /**
   * Start a new session with the given container configuration.
   */
  async startSession(container: ContainerConfig): Promise<SessionInterface> {
    this.ensureNotDisposed();

    // Validate config
    const validated = ContainerConfigSchema.parse(container);

    this.logger.info({ image: validated.image }, 'Starting new session');

    return this.startSessionInternal(validated);
  }

  /**
   * Continue an existing session with a new prompt.
   * Used to provide answers to questions.
   */
  async continueSession(
    sessionId: string,
    prompt: string
  ): Promise<InvocationResult> {
    this.ensureNotDisposed();

    const session = this.sessionManager.get(sessionId);

    this.logger.info({ sessionId }, 'Continuing session');

    // If awaiting input, mark as answered
    if (session.isAwaitingInput()) {
      session.onAnswerProvided();
    }

    // Execute invocation
    const options: InvokeOptions = {
      ...this.defaultInvokeOptions,
      ...session.defaultOptions,
    };

    return this.invoker.invoke(session, prompt, options);
  }

  /**
   * End a session and clean up resources.
   */
  async endSession(sessionId: string): Promise<void> {
    this.ensureNotDisposed();

    this.logger.info({ sessionId }, 'Ending session');

    try {
      // Terminate session
      this.sessionManager.terminate(sessionId, 'user_requested');

      // Cleanup container
      if (this.containerManager.hasContainer(sessionId)) {
        await this.containerManager.stop(sessionId, { remove: true });
      }

      // Cleanup invoker
      this.invoker.cleanupSession(sessionId);

      // Remove from session manager
      this.sessionManager.remove(sessionId);

      this.logger.info({ sessionId }, 'Session ended');
    } catch (error) {
      const wrappedError = wrapError(error);
      this.logger.warn({ sessionId, error: wrappedError }, 'Error ending session');
      // Don't throw - best effort cleanup
    }
  }

  /**
   * Stream output from an active session.
   * Yields OutputChunks as they are received from the agent.
   */
  async *streamOutput(sessionId: string): AsyncIterable<OutputChunk> {
    this.ensureNotDisposed();

    const session = this.sessionManager.get(sessionId);

    if (!session.hasRunningContainer()) {
      throw new SessionInvalidStateError(
        sessionId,
        session.status,
        ['running', 'executing'],
        'stream output'
      );
    }

    this.logger.debug({ sessionId }, 'Streaming output');

    // Get container streams
    const streams = await this.containerManager.attach(sessionId);

    // Create output stream
    const outputStream = createOutputStream(
      streams.stdout as any,
      streams.stderr as any
    );

    // Yield chunks
    for await (const chunk of outputStream) {
      yield chunk;

      // Handle question detection
      if (chunk.type === 'question') {
        const question = chunk.data as {
          question: string;
          urgency: 'blocking_now' | 'blocking_soon' | 'when_available';
          choices?: string[];
          askedAt: Date;
        };
        session.onQuestionReceived(question);
      }
    }
  }

  /**
   * Set the Agency mode for a session.
   * Must be called before invoke for mode to take effect.
   */
  async setMode(sessionId: string, mode: string): Promise<void> {
    this.ensureNotDisposed();

    const session = this.sessionManager.get(sessionId);

    if (!session.hasRunningContainer()) {
      throw new SessionInvalidStateError(
        sessionId,
        session.status,
        ['running'],
        'set mode'
      );
    }

    this.logger.info({ sessionId, mode }, 'Setting mode');

    await this.invoker.setMode(sessionId, mode);

    // Update session default options
    session.update({
      defaultOptions: { ...session.defaultOptions, mode },
    });
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): SessionInterface {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessionManager.has(sessionId);
  }

  /**
   * List all active sessions.
   */
  listSessions(): SessionInterface[] {
    return this.sessionManager.listActive().map((summary) => ({
      id: summary.id,
      status: summary.status,
      createdAt: summary.createdAt,
      lastActiveAt: summary.lastActiveAt,
    }));
  }

  /**
   * Get session count.
   */
  getSessionCount(): { active: number; total: number } {
    return {
      active: this.sessionManager.getActiveCount(),
      total: this.sessionManager.getTotalCount(),
    };
  }

  /**
   * Dispose of the plugin and cleanup all resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.logger.info('Disposing ClaudeCodePlugin');

    this.disposed = true;

    // Cleanup all containers
    await this.containerManager.cleanup();

    // Dispose session manager
    this.sessionManager.dispose();

    this.logger.info('ClaudeCodePlugin disposed');
  }

  /**
   * Check if the plugin is disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Internal method to start a session.
   */
  private async startSessionInternal(config: ContainerConfig): Promise<Session> {
    // Create session
    const session = this.sessionManager.create({
      containerConfig: config,
      defaultOptions: { ...this.defaultInvokeOptions },
    });

    try {
      // Create and start container
      await this.containerManager.create({
        sessionId: session.id,
        config,
      });

      await this.containerManager.start(session.id);

      // Update session state
      const container = this.containerManager.getContainer(session.id);
      session.onContainerStarted(container.containerId);

      this.logger.info(
        { sessionId: session.id, containerId: container.containerId },
        'Session started'
      );

      return session;
    } catch (error) {
      // Cleanup on failure
      await this.containerManager.remove(session.id).catch(() => {});
      this.sessionManager.remove(session.id);
      throw error;
    }
  }

  /**
   * Create an ephemeral container configuration.
   */
  private async createEphemeralContainerConfig(): Promise<ContainerConfig> {
    // Use defaults with sensible ephemeral settings
    const config: ContainerConfig = {
      image: this.defaultContainerConfig.image ?? 'generacy/claude-code:latest',
      workdir: this.defaultContainerConfig.workdir ?? '/workspace',
      env: { ...this.defaultContainerConfig.env },
      mounts: [...(this.defaultContainerConfig.mounts ?? [])],
      network: this.defaultContainerConfig.network ?? 'bridge',
      resources: this.defaultContainerConfig.resources,
    };

    return ContainerConfigSchema.parse(config);
  }

  /**
   * Ensure the plugin is not disposed.
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Plugin has been disposed');
    }
  }
}
