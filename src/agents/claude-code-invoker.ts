/**
 * Claude Code agent invoker implementation.
 *
 * Provides the built-in implementation for invoking Claude Code CLI.
 */

import { spawn, type ChildProcess } from 'child_process';
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
 * Implements the AgentInvoker interface for the Claude Code CLI.
 * This is the built-in implementation for invoking Claude Code.
 */
export class ClaudeCodeInvoker implements AgentInvoker {
  /** Agent name */
  readonly name = 'claude-code';

  /** Supported features */
  private readonly supportedFeatures = new Set<AgentFeature>([
    AgentFeature.Streaming,
    AgentFeature.McpTools,
  ]);

  /**
   * Check if this agent supports a specific feature.
   */
  supports(feature: AgentFeature): boolean {
    return this.supportedFeatures.has(feature);
  }

  /**
   * Check if the Claude CLI is available.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('claude', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('error', () => {
        resolve(false);
      });

      child.on('close', (code) => {
        resolve(code === 0);
      });
    });
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
   */
  async invoke(config: InvocationConfig): Promise<InvocationResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      // Build command arguments
      const args = this.buildArgs(config);

      // Build environment
      const env = this.buildEnvironment(config);

      // Spawn the process
      const child = spawn('claude', args, {
        cwd: config.context.workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      // Set up timeout if configured
      if (config.timeout) {
        timeoutId = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
        }, config.timeout);
      }

      // Capture stdout
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      // Capture stderr
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Handle process error
      child.on('error', (error: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        resolve({
          success: false,
          output: error.message,
          duration,
          error: {
            code: InvocationErrorCodes.AGENT_ERROR,
            message: error.message,
            details: error,
          },
          toolCalls: [],
        });
      });

      // Handle process close
      child.on('close', (code: number | null, signal: string | null) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        const output = this.combineOutput(stdout, stderr);
        const toolCalls = this.parseToolCalls(output);

        // Check for timeout
        if (killed || signal === 'SIGTERM') {
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
   * Build command line arguments for the Claude CLI.
   */
  private buildArgs(config: InvocationConfig): string[] {
    const args: string[] = [];

    // Add the command as prompt
    args.push('--print');
    args.push('--dangerously-skip-permissions');
    args.push(config.command);

    return args;
  }

  /**
   * Build environment variables for the process.
   */
  private buildEnvironment(config: InvocationConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...config.context.environment,
    };

    // Pass mode via environment variable
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
