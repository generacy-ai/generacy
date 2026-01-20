/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Invoker class for executing Claude Code commands.
 */

import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import type { ContainerManager } from '../container/container-manager.js';
import type { Session } from '../session/session.js';
import {
  InvocationTimeoutError,
  wrapError,
} from '../errors.js';
import type {
  InvokeOptions,
  InvocationResult,
  OutputChunk,
} from '../types.js';
import { OutputParser } from '../streaming/output-parser.js';
import type {
  InvocationData,
  CommandBuilderOptions,
  CommandResult,
  SetModeOptions,
} from './types.js';
import {
  buildClaudeCommand,
  buildModeCommand,
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_MAX_TURNS,
} from './types.js';

/**
 * Invoker class for executing Claude Code commands in containers.
 */
export class Invoker {
  private readonly containerManager: ContainerManager;
  private readonly logger: Logger;
  private readonly invocations: Map<string, InvocationData> = new Map();

  constructor(containerManager: ContainerManager, logger: Logger) {
    this.containerManager = containerManager;
    this.logger = logger.child({ component: 'Invoker' });
  }

  /**
   * Execute an invocation in a session's container.
   */
  async invoke(
    session: Session,
    prompt: string,
    options: InvokeOptions = {}
  ): Promise<InvocationResult> {
    const invocationId = randomUUID();
    const startTime = Date.now();

    this.logger.info(
      { sessionId: session.id, invocationId, prompt: prompt.slice(0, 100) },
      'Starting invocation'
    );

    // Create invocation tracking
    const invocation: InvocationData = {
      id: invocationId,
      sessionId: session.id,
      prompt,
      options,
      state: { status: 'pending' },
      outputChunks: [],
      createdAt: new Date(),
      filesModified: [],
    };

    this.invocations.set(invocationId, invocation);

    try {
      // Set mode if specified
      if (options.mode) {
        await this.setMode(session.id, options.mode);
      }

      // Update state to executing
      invocation.state = { status: 'executing', startedAt: new Date() };
      session.onInvocationStarted(invocationId);

      // Build and execute command
      const commandOptions: CommandBuilderOptions = {
        prompt,
        headless: true,
        outputFormat: 'json',
        tools: options.tools,
        context: options.context,
        workdir: session.containerConfig.workdir,
        maxTurns: DEFAULT_MAX_TURNS,
        print: 'all',
      };

      const result = await this.executeCommand(
        session.id,
        buildClaudeCommand(commandOptions),
        {
          timeout: options.timeout ?? DEFAULT_INVOCATION_TIMEOUT_MS,
          onOutput: (chunk) => {
            invocation.outputChunks.push(chunk);
            this.handleOutputChunk(session, chunk);
          },
        }
      );

      // Build invocation result
      const invocationResult = this.buildResult(
        invocationId,
        session.id,
        result,
        startTime
      );

      // Update state
      invocation.state = { status: 'completed', result: invocationResult };
      invocation.completedAt = new Date();

      // Update session state
      session.onInvocationCompleted();

      this.logger.info(
        {
          sessionId: session.id,
          invocationId,
          exitCode: result.exitCode,
          duration: invocationResult.duration,
        },
        'Invocation completed'
      );

      return invocationResult;
    } catch (error) {
      const wrappedError = wrapError(error);

      // Update invocation state
      invocation.state = { status: 'failed', error: wrappedError };
      invocation.completedAt = new Date();

      // Update session state
      session.onInvocationCompleted();

      this.logger.error(
        { sessionId: session.id, invocationId, error: wrappedError },
        'Invocation failed'
      );

      // Return failed result
      return {
        success: false,
        sessionId: session.id,
        invocationId,
        exitCode: -1,
        duration: Date.now() - startTime,
        error: wrappedError.toInvocationError(),
      };
    }
  }

  /**
   * Set the Agency mode in a container.
   */
  async setMode(sessionId: string, mode: string, options: SetModeOptions = { mode }): Promise<void> {
    this.logger.info({ sessionId, mode }, 'Setting Agency mode');

    const result = await this.containerManager.exec(
      sessionId,
      buildModeCommand(mode),
      { timeout: options.timeout ?? 30000 }
    );

    if (result.exitCode !== 0) {
      this.logger.warn(
        { sessionId, mode, exitCode: result.exitCode, stderr: result.stderr },
        'Failed to set mode'
      );
      throw new Error(`Failed to set mode ${mode}: ${result.stderr || 'Unknown error'}`);
    }

    this.logger.debug({ sessionId, mode }, 'Mode set successfully');
  }

  /**
   * Execute a command in a container.
   */
  async executeCommand(
    sessionId: string,
    cmd: string[],
    options: {
      timeout?: number;
      onOutput?: (chunk: OutputChunk) => void;
    } = {}
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? DEFAULT_INVOCATION_TIMEOUT_MS;

    this.logger.debug({ sessionId, cmd: cmd.join(' ') }, 'Executing command');

    try {
      const result = await this.containerManager.exec(sessionId, cmd, { timeout });

      // Parse output
      const parser = new OutputParser();
      const chunks: OutputChunk[] = [];

      // Parse stdout
      if (result.stdout) {
        const stdoutChunks = parser.parseChunk(result.stdout);
        for (const chunk of stdoutChunks) {
          chunks.push(chunk);
          options.onOutput?.(chunk);
        }
      }

      // Flush remaining
      const remaining = parser.flush();
      for (const chunk of remaining) {
        chunks.push(chunk);
        options.onOutput?.(chunk);
      }

      // Add stderr as error chunk if present
      if (result.stderr && result.exitCode !== 0) {
        const errorChunk = parser.createErrorChunk(result.stderr);
        chunks.push(errorChunk);
        options.onOutput?.(errorChunk);
      }

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        chunks,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const wrappedError = wrapError(error);

      if (wrappedError.message.includes('timed out')) {
        throw new InvocationTimeoutError(
          sessionId,
          'exec',
          timeout
        );
      }

      throw wrappedError;
    }
  }

  /**
   * Get invocation data by ID.
   */
  getInvocation(invocationId: string): InvocationData | undefined {
    return this.invocations.get(invocationId);
  }

  /**
   * Get all invocations for a session.
   */
  getSessionInvocations(sessionId: string): InvocationData[] {
    return Array.from(this.invocations.values()).filter(
      (inv) => inv.sessionId === sessionId
    );
  }

  /**
   * Clean up invocations for a session.
   */
  cleanupSession(sessionId: string): void {
    for (const [id, invocation] of this.invocations) {
      if (invocation.sessionId === sessionId) {
        this.invocations.delete(id);
      }
    }
  }

  /**
   * Handle an output chunk during execution.
   */
  private handleOutputChunk(session: Session, chunk: OutputChunk): void {
    // Check for question
    if (chunk.type === 'question') {
      const question = chunk.data as {
        question: string;
        urgency: string;
        choices?: string[];
        askedAt: Date;
      };

      this.logger.info(
        { sessionId: session.id, question: question.question },
        'Question received during invocation'
      );

      // Transition session to awaiting_input
      session.onQuestionReceived({
        question: question.question,
        urgency: question.urgency as 'blocking_now' | 'blocking_soon' | 'when_available',
        choices: question.choices,
        askedAt: question.askedAt,
      });
    }

    // Track file modifications
    if (chunk.type === 'tool_result' && chunk.metadata?.filePath) {
      const invocation = this.getCurrentInvocation(session.id);
      if (invocation && !invocation.filesModified.includes(chunk.metadata.filePath)) {
        invocation.filesModified.push(chunk.metadata.filePath);
      }
    }
  }

  /**
   * Get the current executing invocation for a session.
   */
  private getCurrentInvocation(sessionId: string): InvocationData | undefined {
    for (const invocation of this.invocations.values()) {
      if (
        invocation.sessionId === sessionId &&
        invocation.state.status === 'executing'
      ) {
        return invocation;
      }
    }
    return undefined;
  }

  /**
   * Build an InvocationResult from command result.
   */
  private buildResult(
    invocationId: string,
    sessionId: string,
    result: CommandResult,
    startTime: number
  ): InvocationResult {
    const success = result.exitCode === 0;

    // Extract summary from completion chunk
    let summary: string | undefined;
    const completeChunk = result.chunks.find((c) => c.type === 'complete');
    if (completeChunk) {
      const data = completeChunk.data as { summary?: string };
      summary = data.summary;
    }

    // Collect modified files from tool results
    const filesModified: string[] = [];
    for (const chunk of result.chunks) {
      if (chunk.type === 'tool_result' && chunk.metadata?.filePath) {
        if (!filesModified.includes(chunk.metadata.filePath)) {
          filesModified.push(chunk.metadata.filePath);
        }
      }
    }

    // Build error if failed
    let error = undefined;
    if (!success) {
      const errorChunk = result.chunks.find((c) => c.type === 'error');
      if (errorChunk) {
        const data = errorChunk.data as { message?: string; code?: string; isTransient?: boolean };
        error = {
          code: (data.code ?? 'UNKNOWN') as 'UNKNOWN',
          isTransient: data.isTransient ?? false,
          message: data.message ?? result.stderr ?? 'Unknown error',
        };
      } else if (result.stderr) {
        error = {
          code: 'UNKNOWN' as const,
          isTransient: false,
          message: result.stderr,
        };
      }
    }

    return {
      success,
      sessionId,
      invocationId,
      exitCode: result.exitCode,
      summary,
      filesModified: filesModified.length > 0 ? filesModified : undefined,
      duration: Date.now() - startTime,
      error,
    };
  }
}
