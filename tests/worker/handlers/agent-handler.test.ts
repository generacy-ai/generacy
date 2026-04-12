import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import type { Job } from '../../../src/scheduler/types.js';
import type {
  JobResult,
  AgentJobPayload,
  AgentHandlerConfig,
} from '../../../src/worker/types.js';
import type {
  AgentInvoker,
  InvocationResult,
  InvocationConfig,
} from '../../../src/agents/types.js';
import { AgentFeature } from '../../../src/agents/types.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { AgentNotFoundError } from '../../../src/agents/errors.js';
import { ClaudeCodeInvoker } from '../../../src/agents/claude-code-invoker.js';
import type { AgentLauncher, LaunchHandle } from '@generacy-ai/orchestrator';

// AgentHandler will be implemented - import when available
// import { AgentHandler } from '../../../src/worker/handlers/agent-handler.js';

/**
 * Create a mock AgentInvoker for testing.
 */
function createMockAgent(
  name: string,
  invokeResult?: Partial<InvocationResult>
): AgentInvoker & { invoke: Mock } {
  return {
    name,
    supports: (_feature: AgentFeature) => true,
    isAvailable: vi.fn().mockResolvedValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue({
      success: true,
      output: 'Agent execution completed successfully',
      exitCode: 0,
      duration: 1500,
      toolCalls: [],
      ...invokeResult,
    } as InvocationResult),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock Job for testing.
 */
function createMockJob(payload: Partial<AgentJobPayload> = {}): Job {
  const defaultPayload: AgentJobPayload = {
    command: '/speckit:specify',
    context: {
      workingDirectory: '/workspace/project',
      environment: { NODE_ENV: 'test' },
      mode: 'autonomous',
      issueNumber: 42,
      branch: 'feature/test',
    },
    ...payload,
  };

  return {
    id: 'job_test-123',
    workflowId: 'workflow_test-456',
    stepId: 'step_test-789',
    type: 'agent',
    status: 'processing',
    priority: 'normal',
    attempts: 1,
    maxAttempts: 3,
    payload: defaultPayload,
    createdAt: new Date().toISOString(),
    visibilityTimeout: 30000,
  };
}

/**
 * Create default AgentHandlerConfig for testing.
 */
function createDefaultConfig(): AgentHandlerConfig {
  return {
    defaultTimeout: 300000, // 5 minutes
    retry: {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      retryableErrors: ['TIMEOUT', 'AGENT_ERROR'],
    },
  };
}

// Placeholder for AgentHandler until it's implemented
// This allows tests to be written ahead of implementation
class AgentHandler {
  private registry: AgentRegistry;
  private config: AgentHandlerConfig;
  private static readonly DEFAULT_AGENT = 'claude-code';

  constructor(registry: AgentRegistry, config: AgentHandlerConfig) {
    this.registry = registry;
    this.config = config;
  }

  async handle(job: Job): Promise<JobResult> {
    const startTime = Date.now();
    const payload = job.payload as AgentJobPayload;

    // Get agent from registry - use specified agent or default
    const agentName = payload.agent ?? AgentHandler.DEFAULT_AGENT;
    const agent = this.registry.get(agentName);

    if (!agent) {
      throw new AgentNotFoundError(agentName);
    }

    // Build invocation config
    const invocationConfig: InvocationConfig = {
      command: payload.command,
      context: {
        workingDirectory: payload.context.workingDirectory,
        environment: payload.context.environment,
        mode: payload.context.mode,
        issueNumber: payload.context.issueNumber,
        branch: payload.context.branch,
      },
      timeout: payload.timeout ?? this.config.defaultTimeout,
    };

    try {
      // Invoke the agent
      const result = await agent.invoke(invocationConfig);

      const duration = Date.now() - startTime;

      // Convert InvocationResult to JobResult
      return {
        success: result.success,
        output: result.output,
        duration,
        metadata: {
          exitCode: result.exitCode,
          toolCalls: result.toolCalls,
          agentName,
          ...(result.error && { error: result.error }),
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle agent invocation errors
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
        duration,
        metadata: {
          agentName,
          error: {
            code: 'INVOCATION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}

describe('AgentHandler', () => {
  let registry: AgentRegistry;
  let config: AgentHandlerConfig;
  let handler: AgentHandler;
  let mockAgent: AgentInvoker & { invoke: Mock };

  beforeEach(() => {
    registry = new AgentRegistry();
    config = createDefaultConfig();
    mockAgent = createMockAgent('claude-code');
    registry.register(mockAgent);
    handler = new AgentHandler(registry, config);
  });

  describe('constructor', () => {
    it('creates handler with registry and config', () => {
      const newHandler = new AgentHandler(registry, config);
      expect(newHandler).toBeInstanceOf(AgentHandler);
    });
  });

  describe('handle - successful invocation', () => {
    it('returns success JobResult when agent invocation succeeds', async () => {
      const job = createMockJob();

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Agent execution completed successfully');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('includes metadata with exitCode and toolCalls', async () => {
      const toolCalls = [
        {
          toolName: 'Read',
          success: true,
          duration: 50,
          timestamp: new Date(),
        },
      ];
      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: 'Done',
        exitCode: 0,
        duration: 1000,
        toolCalls,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.exitCode).toBe(0);
      expect(result.metadata?.toolCalls).toEqual(toolCalls);
    });

    it('includes agent name in metadata', async () => {
      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.metadata?.agentName).toBe('claude-code');
    });
  });

  describe('handle - default agent', () => {
    it('uses claude-code as default when agent not specified in payload', async () => {
      const job = createMockJob({ agent: undefined });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalled();
    });

    it('uses default agent when payload.agent is not present', async () => {
      const payload: AgentJobPayload = {
        command: '/test:command',
        context: { workingDirectory: '/workspace' },
      };
      const job = createMockJob(payload);

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalled();
    });
  });

  describe('handle - specified agent', () => {
    it('uses specified agent from payload when provided', async () => {
      const copilotAgent = createMockAgent('copilot');
      registry.register(copilotAgent);

      const job = createMockJob({ agent: 'copilot' });
      await handler.handle(job);

      expect(copilotAgent.invoke).toHaveBeenCalled();
      expect(mockAgent.invoke).not.toHaveBeenCalled();
    });

    it('throws AgentNotFoundError when specified agent does not exist', async () => {
      const job = createMockJob({ agent: 'non-existent-agent' });

      await expect(handler.handle(job)).rejects.toThrow(AgentNotFoundError);
      await expect(handler.handle(job)).rejects.toThrow(
        'Agent "non-existent-agent" not found in registry'
      );
    });
  });

  describe('handle - context passing', () => {
    it('passes working directory to agent', async () => {
      const job = createMockJob({
        context: {
          workingDirectory: '/custom/workspace',
        },
      });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            workingDirectory: '/custom/workspace',
          }),
        })
      );
    });

    it('passes environment variables to agent', async () => {
      const job = createMockJob({
        context: {
          workingDirectory: '/workspace',
          environment: { API_KEY: 'secret', DEBUG: 'true' },
        },
      });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            environment: { API_KEY: 'secret', DEBUG: 'true' },
          }),
        })
      );
    });

    it('passes mode to agent', async () => {
      const job = createMockJob({
        context: {
          workingDirectory: '/workspace',
          mode: 'supervised',
        },
      });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            mode: 'supervised',
          }),
        })
      );
    });

    it('passes issue number to agent', async () => {
      const job = createMockJob({
        context: {
          workingDirectory: '/workspace',
          issueNumber: 123,
        },
      });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            issueNumber: 123,
          }),
        })
      );
    });

    it('passes branch to agent', async () => {
      const job = createMockJob({
        context: {
          workingDirectory: '/workspace',
          branch: 'feature/my-feature',
        },
      });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            branch: 'feature/my-feature',
          }),
        })
      );
    });

    it('passes command to agent', async () => {
      const job = createMockJob({ command: '/speckit:plan' });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          command: '/speckit:plan',
        })
      );
    });
  });

  describe('handle - timeout handling', () => {
    it('uses job-specific timeout when provided', async () => {
      const job = createMockJob({ timeout: 60000 });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 60000,
        })
      );
    });

    it('uses default timeout from config when job timeout not specified', async () => {
      const job = createMockJob({ timeout: undefined });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 300000, // default from config
        })
      );
    });

    it('handles timeout error from agent gracefully', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: false,
        output: 'Operation timed out',
        duration: 300000,
        error: {
          code: 'TIMEOUT',
          message: 'Operation exceeded timeout of 300000ms',
        },
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(false);
      expect(result.metadata?.error).toEqual({
        code: 'TIMEOUT',
        message: 'Operation exceeded timeout of 300000ms',
      });
    });
  });

  describe('handle - error handling', () => {
    it('returns failed JobResult when agent invocation returns success=false', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: false,
        output: 'Command failed with exit code 1',
        exitCode: 1,
        duration: 500,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Non-zero exit code',
        },
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(false);
      expect(result.output).toBe('Command failed with exit code 1');
      expect(result.metadata?.exitCode).toBe(1);
      expect(result.metadata?.error).toEqual({
        code: 'COMMAND_FAILED',
        message: 'Non-zero exit code',
      });
    });

    it('handles agent invoke throwing an exception', async () => {
      mockAgent.invoke.mockRejectedValueOnce(new Error('Agent crashed unexpectedly'));

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(false);
      expect(result.output).toBe('Agent crashed unexpectedly');
      expect(result.metadata?.error).toEqual({
        code: 'INVOCATION_ERROR',
        message: 'Agent crashed unexpectedly',
      });
    });

    it('handles non-Error exceptions', async () => {
      mockAgent.invoke.mockRejectedValueOnce('String error');

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(false);
      expect(result.output).toBe('String error');
    });

    it('includes duration in failed results', async () => {
      mockAgent.invoke.mockRejectedValueOnce(new Error('Failed'));

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('handle - InvocationResult to JobResult conversion', () => {
    it('maps success field correctly', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: 'Success',
        duration: 100,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(true);
    });

    it('maps output field correctly', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: 'Custom output message',
        duration: 100,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.output).toBe('Custom output message');
    });

    it('includes exitCode in metadata', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: 'Done',
        exitCode: 0,
        duration: 100,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.metadata?.exitCode).toBe(0);
    });

    it('includes toolCalls in metadata', async () => {
      const toolCalls = [
        {
          toolName: 'Write',
          success: true,
          duration: 200,
          timestamp: new Date(),
          inputSummary: 'Writing file...',
          outputSummary: 'File written',
        },
        {
          toolName: 'Bash',
          success: false,
          duration: 50,
          timestamp: new Date(),
          errorMessage: 'Command not found',
        },
      ];

      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: 'Completed',
        duration: 250,
        toolCalls,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.metadata?.toolCalls).toEqual(toolCalls);
    });

    it('calculates duration independently from agent duration', async () => {
      // Agent reports 100ms but actual handler time includes overhead
      mockAgent.invoke.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          success: true,
          output: 'Done',
          duration: 100, // Agent's internal duration
        };
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      // Handler duration should be at least 10ms (accounting for timing variance)
      // The key point is that duration is calculated by the handler, not taken from agent
      expect(result.duration).toBeGreaterThanOrEqual(10);
      expect(result.duration).toBeDefined();
    });

    it('includes error in metadata when invocation fails', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: false,
        output: 'Failed',
        duration: 100,
        error: {
          code: 'AGENT_ERROR',
          message: 'Something went wrong',
          details: { step: 'initialization' },
        },
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.metadata?.error).toEqual({
        code: 'AGENT_ERROR',
        message: 'Something went wrong',
        details: { step: 'initialization' },
      });
    });
  });

  describe('handle - edge cases', () => {
    it('handles empty output', async () => {
      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: '',
        duration: 100,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.output).toBe('');
      expect(result.success).toBe(true);
    });

    it('handles undefined optional context fields', async () => {
      const job = createMockJob({
        context: {
          workingDirectory: '/workspace',
          // No environment, mode, issueNumber, or branch
        },
      });

      await handler.handle(job);

      expect(mockAgent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            workingDirectory: '/workspace',
          }),
        })
      );
    });

    it('handles very long output', async () => {
      const longOutput = 'x'.repeat(100000);
      mockAgent.invoke.mockResolvedValueOnce({
        success: true,
        output: longOutput,
        duration: 100,
      });

      const job = createMockJob();
      const result = await handler.handle(job);

      expect(result.output).toBe(longOutput);
    });

    it('handles multiple sequential invocations', async () => {
      const job1 = createMockJob({ command: '/cmd1' });
      const job2 = createMockJob({ command: '/cmd2' });

      await handler.handle(job1);
      await handler.handle(job2);

      expect(mockAgent.invoke).toHaveBeenCalledTimes(2);
      expect(mockAgent.invoke).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ command: '/cmd1' })
      );
      expect(mockAgent.invoke).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ command: '/cmd2' })
      );
    });
  });

  describe('handle - registry integration', () => {
    it('allows switching between agents for different jobs', async () => {
      const cursorAgent = createMockAgent('cursor');
      registry.register(cursorAgent);

      const job1 = createMockJob({ agent: 'claude-code' });
      const job2 = createMockJob({ agent: 'cursor' });

      await handler.handle(job1);
      await handler.handle(job2);

      expect(mockAgent.invoke).toHaveBeenCalledTimes(1);
      expect(cursorAgent.invoke).toHaveBeenCalledTimes(1);
    });

    it('handles agent being unregistered between invocations', async () => {
      const job1 = createMockJob({ agent: 'claude-code' });
      await handler.handle(job1);

      registry.unregister('claude-code');

      const job2 = createMockJob({ agent: 'claude-code' });
      await expect(handler.handle(job2)).rejects.toThrow(AgentNotFoundError);
    });
  });

  describe('AgentLauncher integration', () => {
    it('end-to-end: job payload → registry → ClaudeCodeInvoker → LaunchRequest', async () => {
      // Create mock AgentLauncher
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      let resolveExit: (code: number | null) => void;
      const exitPromise = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });

      const mockLaunchHandle: LaunchHandle = {
        process: {
          stdout: stdoutEmitter,
          stderr: stderrEmitter,
          stdin: null,
          pid: 99999,
          kill: vi.fn(),
          exitPromise,
        } as any,
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'claude-code', intentKind: 'invoke' },
      };

      const mockLauncher = {
        launch: vi.fn().mockReturnValue(mockLaunchHandle),
        registerPlugin: vi.fn(),
      } as unknown as AgentLauncher & { launch: ReturnType<typeof vi.fn> };

      // Wire real ClaudeCodeInvoker through registry
      const launcherRegistry = new AgentRegistry();
      const realInvoker = new ClaudeCodeInvoker(mockLauncher);
      launcherRegistry.register(realInvoker);

      const launcherHandler = new AgentHandler(launcherRegistry, config);

      // Emit output and exit after a tick
      setTimeout(() => {
        stdoutEmitter.emit('data', Buffer.from('Agent completed'));
        setTimeout(() => resolveExit(0), 5);
      }, 10);

      const job = createMockJob({
        command: '/speckit:plan',
        context: {
          workingDirectory: '/workspace/project',
          environment: { NODE_ENV: 'test' },
          mode: 'autonomous',
        },
      });

      const result = await launcherHandler.handle(job);

      // Verify the full path
      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent completed');
      expect(mockLauncher.launch).toHaveBeenCalledWith({
        intent: { kind: 'invoke', command: '/speckit:plan' },
        cwd: '/workspace/project',
        env: {
          NODE_ENV: 'test',
          CLAUDE_MODE: 'autonomous',
        },
      });
    });
  });
});
