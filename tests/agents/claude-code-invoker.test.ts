import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  ClaudeCodeInvoker,
  AgentFeature,
  AgentInitializationError,
  InvocationErrorCodes,
  type InvocationConfig,
} from '../../src/agents/index.js';
import type { AgentLauncher, LaunchHandle } from '@generacy-ai/orchestrator';

/**
 * Create a mock ChildProcessHandle for testing.
 */
function createMockProcessHandle(options?: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  delay?: number;
}): {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: null;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  exitPromise: Promise<number | null>;
  _emitOutput: () => void;
} {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const delay = options?.delay ?? 10;
  const exitCode = options?.exitCode ?? 0;

  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  const _emitOutput = () => {
    if (options?.stdout) {
      stdoutEmitter.emit('data', Buffer.from(options.stdout));
    }
    if (options?.stderr) {
      stderrEmitter.emit('data', Buffer.from(options.stderr));
    }
    setTimeout(() => {
      resolveExit(exitCode);
    }, delay);
  };

  // Auto-emit after delay
  setTimeout(_emitOutput, delay);

  return {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: null,
    pid: 12345,
    kill: vi.fn().mockImplementation(() => {
      setTimeout(() => resolveExit(null), 5);
      return true;
    }),
    exitPromise,
    _emitOutput,
  };
}

/**
 * Create a mock LaunchHandle wrapping a mock process.
 */
function createMockLaunchHandle(processHandle: ReturnType<typeof createMockProcessHandle>): LaunchHandle {
  return {
    process: processHandle as any,
    outputParser: {
      processChunk: () => {},
      flush: () => {},
    },
    metadata: {
      pluginId: 'claude-code',
      intentKind: 'invoke',
    },
  };
}

/**
 * Create a mock AgentLauncher.
 */
function createMockLauncher(): AgentLauncher & { launch: ReturnType<typeof vi.fn> } {
  return {
    launch: vi.fn(),
    registerPlugin: vi.fn(),
  } as any;
}

describe('ClaudeCodeInvoker', () => {
  let mockLauncher: ReturnType<typeof createMockLauncher>;
  let invoker: ClaudeCodeInvoker;

  beforeEach(() => {
    mockLauncher = createMockLauncher();
    invoker = new ClaudeCodeInvoker(mockLauncher);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('name', () => {
    it('has the correct name', () => {
      expect(invoker.name).toBe('claude-code');
    });
  });

  describe('supports', () => {
    it('returns true for Streaming feature', () => {
      expect(invoker.supports(AgentFeature.Streaming)).toBe(true);
    });

    it('returns true for McpTools feature', () => {
      expect(invoker.supports(AgentFeature.McpTools)).toBe(true);
    });
  });

  describe('isAvailable', () => {
    it('returns true when launch succeeds with exit code 0', async () => {
      const mockProcess = createMockProcessHandle({ exitCode: 0 });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.isAvailable();
      expect(result).toBe(true);
      expect(mockLauncher.launch).toHaveBeenCalledWith({
        intent: { kind: 'generic-subprocess', command: 'claude', args: ['--version'] },
        cwd: expect.any(String),
      });
    });

    it('returns false when launch succeeds with non-zero exit code', async () => {
      const mockProcess = createMockProcessHandle({ exitCode: 1 });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.isAvailable();
      expect(result).toBe(false);
    });

    it('returns false when launch throws', async () => {
      mockLauncher.launch.mockImplementation(() => {
        throw new Error('Launch failed');
      });

      const result = await invoker.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('initialize', () => {
    it('succeeds when CLI is available', async () => {
      const mockProcess = createMockProcessHandle({ exitCode: 0 });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      await expect(invoker.initialize()).resolves.not.toThrow();
    });

    it('throws AgentInitializationError when CLI is unavailable', async () => {
      mockLauncher.launch.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      await expect(invoker.initialize()).rejects.toThrow(AgentInitializationError);
    });
  });

  describe('invoke', () => {
    const baseConfig: InvocationConfig = {
      command: '/speckit:specify',
      context: {
        workingDirectory: '/test/workspace',
      },
    };

    it('builds LaunchRequest with invoke intent and correct cwd', async () => {
      const mockProcess = createMockProcessHandle({ exitCode: 0, stdout: 'output' });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      await invoker.invoke(baseConfig);

      expect(mockLauncher.launch).toHaveBeenCalledWith({
        intent: { kind: 'invoke', command: '/speckit:specify' },
        cwd: '/test/workspace',
        env: {},
      });
    });

    it('executes command and captures stdout/stderr', async () => {
      const mockProcess = createMockProcessHandle({
        exitCode: 0,
        stdout: 'output from stdout',
        stderr: 'output from stderr',
      });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.output).toContain('output from stdout');
      expect(result.output).toContain('output from stderr');
    });

    it('returns success=true with output on zero exit code', async () => {
      const mockProcess = createMockProcessHandle({
        exitCode: 0,
        stdout: 'success output',
      });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('success output');
    });

    it('returns success=false with COMMAND_FAILED error on non-zero exit', async () => {
      const mockProcess = createMockProcessHandle({
        exitCode: 1,
        stderr: 'command failed',
      });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error?.code).toBe(InvocationErrorCodes.COMMAND_FAILED);
    });

    it('returns success=false with TIMEOUT error when timeout exceeded', async () => {
      // Create a process that never exits on its own
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      let resolveExit: (code: number | null) => void;
      const exitPromise = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });

      const mockProcess = {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: null,
        pid: 12345,
        kill: vi.fn().mockImplementation(() => {
          // Simulate process dying after kill
          setTimeout(() => resolveExit(null), 5);
          return true;
        }),
        exitPromise,
      };

      mockLauncher.launch.mockReturnValue({
        process: mockProcess as any,
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'claude-code', intentKind: 'invoke' },
      });

      const config: InvocationConfig = {
        ...baseConfig,
        timeout: 50,
      };

      const result = await invoker.invoke(config);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(InvocationErrorCodes.TIMEOUT);
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('passes environment variables including CLAUDE_MODE via LaunchRequest.env', async () => {
      const mockProcess = createMockProcessHandle({ exitCode: 0 });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const config: InvocationConfig = {
        command: '/speckit:specify',
        context: {
          workingDirectory: '/test/workspace',
          mode: 'test-mode',
          environment: {
            CUSTOM_VAR: 'custom-value',
          },
        },
      };

      await invoker.invoke(config);

      expect(mockLauncher.launch).toHaveBeenCalledWith({
        intent: { kind: 'invoke', command: '/speckit:specify' },
        cwd: '/test/workspace',
        env: {
          CUSTOM_VAR: 'custom-value',
          CLAUDE_MODE: 'test-mode',
        },
      });
    });

    it('passes working directory from context as cwd', async () => {
      const mockProcess = createMockProcessHandle({ exitCode: 0 });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const config: InvocationConfig = {
        command: '/test:command',
        context: {
          workingDirectory: '/custom/workspace',
        },
      };

      await invoker.invoke(config);

      expect(mockLauncher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/custom/workspace',
        })
      );
    });

    it('parses tool calls from structured output', async () => {
      const toolCallOutput = JSON.stringify({
        toolCalls: [
          {
            toolName: 'Read',
            success: true,
            duration: 50,
            timestamp: new Date().toISOString(),
          },
          {
            toolName: 'Write',
            success: true,
            duration: 100,
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const mockProcess = createMockProcessHandle({
        exitCode: 0,
        stdout: `Some output\n---TOOL_CALLS---\n${toolCallOutput}\n---END_TOOL_CALLS---\nMore output`,
      });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls?.[0]?.toolName).toBe('Read');
      expect(result.toolCalls?.[1]?.toolName).toBe('Write');
    });

    it('returns empty toolCalls when parsing fails (graceful degradation)', async () => {
      const mockProcess = createMockProcessHandle({
        exitCode: 0,
        stdout: 'Normal output without tool calls',
      });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.toolCalls).toEqual([]);
    });

    it('tracks duration of invocation', async () => {
      const mockProcess = createMockProcessHandle({
        exitCode: 0,
        delay: 50,
      });
      mockLauncher.launch.mockReturnValue(createMockLaunchHandle(mockProcess));

      const result = await invoker.invoke(baseConfig);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('returns AGENT_ERROR when launch throws', async () => {
      mockLauncher.launch.mockImplementation(() => {
        throw new Error('Unknown intent kind "invoke"');
      });

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(InvocationErrorCodes.AGENT_ERROR);
      expect(result.error?.message).toContain('Unknown intent kind');
      expect(result.toolCalls).toEqual([]);
    });
  });

  describe('shutdown', () => {
    it('completes without error', async () => {
      await expect(invoker.shutdown()).resolves.not.toThrow();
    });
  });
});
