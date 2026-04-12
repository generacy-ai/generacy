/**
 * Claude Code agent invoker implementation.
 *
 * Thin adapter over AgentLauncher — delegates all spawning through
 * the launcher and its registered plugins. No direct child_process usage.
 */

import type { AgentLauncher, LaunchHandle } from '@generacy-ai/orchestrator';
import {
  AgentFeature,
  type AgentInvoker,
  type InvocationConfig,
  type InvocationResult,
  type ToolCallRecord,
} from './types.js';
import { AgentInitializationError, InvocationErrorCodes } from './errors.js';

/**
 * Claude Code CLI invoker.
 *
 * Implements the AgentInvoker interface by delegating to AgentLauncher.
 * The launcher's ClaudeCodeLaunchPlugin handles argv construction for the
 * 'invoke' intent kind; this adapter owns stream collection, timeout
 * handling, and InvocationResult construction.
 */
export class ClaudeCodeInvoker implements AgentInvoker {
  /** Agent name */
  readonly name = 'claude-code';

  /** Supported features */
  private readonly supportedFeatures = new Set<AgentFeature>([
    AgentFeature.Streaming,
    AgentFeature.McpTools,
  ]);

  constructor(private readonly agentLauncher: AgentLauncher) {}

  /**
   * Check if this agent supports a specific feature.
   */
  supports(feature: AgentFeature): boolean {
    return this.supportedFeatures.has(feature);
  }

  /**
   * Check if the Claude CLI is available.
   * Routes through AgentLauncher with a generic-subprocess intent.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const handle = this.agentLauncher.launch({
        intent: { kind: 'generic-subprocess', command: 'claude', args: ['--version'] },
        cwd: process.cwd(),
      });
      const code = await handle.process.exitPromise;
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Initialize the invoker by verifying CLI availability.
   */
  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      throw new AgentInitializationError(
        this.name,
        'Claude CLI is not available. Make sure it is installed and in PATH.'
      );
    }
  }

  /**
   * Invoke Claude Code with the given configuration.
   * Builds a LaunchRequest with 'invoke' intent and delegates to AgentLauncher.
   */
  async invoke(config: InvocationConfig): Promise<InvocationResult> {
    const startTime = Date.now();

    // Build caller env overrides
    const env: Record<string, string> = {
      ...config.context.environment,
      ...(config.context.mode ? { CLAUDE_MODE: config.context.mode } : {}),
    };

    let handle: LaunchHandle;
    try {
      handle = this.agentLauncher.launch({
        intent: { kind: 'invoke', command: config.command },
        cwd: config.context.workingDirectory,
        env,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
        duration,
        error: {
          code: InvocationErrorCodes.AGENT_ERROR,
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
        toolCalls: [],
      };
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      // Set up timeout if configured
      if (config.timeout) {
        timeoutId = setTimeout(() => {
          killed = true;
          handle.process.kill('SIGTERM');
        }, config.timeout);
      }

      // Collect stdout
      if (handle.process.stdout) {
        handle.process.stdout.on('data', (data: Buffer | string) => {
          stdout += String(data);
        });
      }

      // Collect stderr
      if (handle.process.stderr) {
        handle.process.stderr.on('data', (data: Buffer | string) => {
          stderr += String(data);
        });
      }

      // Wait for process exit
      handle.process.exitPromise.then((code: number | null) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        const output = this.combineOutput(stdout, stderr);
        const toolCalls = this.parseToolCalls(output);

        // Check for timeout
        if (killed) {
          resolve({
            success: false,
            output,
            exitCode: code ?? undefined,
            duration,
            error: {
              code: InvocationErrorCodes.TIMEOUT,
              message: `Invocation timed out after ${config.timeout}ms`,
            },
            toolCalls,
          });
          return;
        }

        // Check exit code
        if (code !== 0) {
          resolve({
            success: false,
            output,
            exitCode: code ?? undefined,
            duration,
            error: {
              code: InvocationErrorCodes.COMMAND_FAILED,
              message: `Command exited with code ${code}`,
              details: { stderr },
            },
            toolCalls,
          });
          return;
        }

        // Success
        resolve({
          success: true,
          output,
          exitCode: code,
          duration,
          toolCalls,
        });
      });
    });
  }

  /**
   * Shutdown the invoker (no-op for CLI-based invoker).
   */
  async shutdown(): Promise<void> {
    // No resources to clean up for CLI-based invoker
  }

  /**
   * Build environment variables for the LaunchRequest.
   */
  private buildEnvironment(config: InvocationConfig): Record<string, string> {
    const env: Record<string, string> = {
      ...config.context.environment,
    };

    if (config.context.mode) {
      env.CLAUDE_MODE = config.context.mode;
    }

    return env;
  }

  /**
   * Combine stdout and stderr output.
   */
  private combineOutput(stdout: string, stderr: string): string {
    if (stderr) {
      return stdout + stderr;
    }
    return stdout;
  }

  /**
   * Parse tool calls from structured output.
   *
   * Looks for tool call records in the output using a special marker format:
   * ---TOOL_CALLS---
   * { JSON array of tool calls }
   * ---END_TOOL_CALLS---
   *
   * Returns empty array if parsing fails (graceful degradation).
   */
  private parseToolCalls(output: string): ToolCallRecord[] {
    const startMarker = '---TOOL_CALLS---';
    const endMarker = '---END_TOOL_CALLS---';

    const startIndex = output.indexOf(startMarker);
    const endIndex = output.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      return [];
    }

    try {
      const jsonStart = startIndex + startMarker.length;
      const jsonContent = output.substring(jsonStart, endIndex).trim();
      const parsed = JSON.parse(jsonContent);

      if (parsed.toolCalls && Array.isArray(parsed.toolCalls)) {
        return parsed.toolCalls.map((tc: Record<string, unknown>) => ({
          toolName: String(tc.toolName || ''),
          success: Boolean(tc.success),
          duration: Number(tc.duration || 0),
          timestamp: tc.timestamp ? new Date(String(tc.timestamp)) : new Date(),
          inputSummary: tc.inputSummary ? String(tc.inputSummary) : undefined,
          outputSummary: tc.outputSummary ? String(tc.outputSummary) : undefined,
          errorMessage: tc.errorMessage ? String(tc.errorMessage) : undefined,
        }));
      }
    } catch {
      // Graceful degradation - return empty array on parse failure
    }

    return [];
  }
}
