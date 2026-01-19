import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  ClaudeCodeInvoker,
  AgentFeature,
  AgentInitializationError,
  InvocationErrorCodes,
  type InvocationConfig,
} from '../../src/agents/index.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const mockSpawn = spawn as ReturnType<typeof vi.fn>;

interface MockProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createMockProcess(options?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delay?: number;
  killSignal?: string;
}): MockProcess {
  const process = new EventEmitter() as MockProcess;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn().mockImplementation((signal?: string) => {
    if (options?.killSignal) {
      process.emit('close', null, options.killSignal);
    }
    return true;
  });
  process.pid = 12345;

  // Simulate async behavior
  const delay = options?.delay ?? 10;
  setTimeout(() => {
    if (options?.stdout) {
      process.stdout.emit('data', Buffer.from(options.stdout));
    }
    if (options?.stderr) {
      process.stderr.emit('data', Buffer.from(options.stderr));
    }
    setTimeout(() => {
      process.emit('close', options?.exitCode ?? 0);
    }, delay);
  }, delay);

  return process;
}

describe('ClaudeCodeInvoker', () => {
  let invoker: ClaudeCodeInvoker;

  beforeEach(() => {
    invoker = new ClaudeCodeInvoker();
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
    it('returns true when claude CLI exists', async () => {
      const mockProcess = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.isAvailable();
      expect(result).toBe(true);
    });

    it('returns false when claude CLI is missing', async () => {
      const mockProcess = new EventEmitter() as MockProcess;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.kill = vi.fn();
      mockProcess.pid = 12345;

      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      // Emit error asynchronously
      setTimeout(() => {
        mockProcess.emit('error', new Error('ENOENT: command not found'));
      }, 10);

      const result = await invoker.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('initialize', () => {
    it('succeeds when CLI is available', async () => {
      const mockProcess = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      await expect(invoker.initialize()).resolves.not.toThrow();
    });

    it('throws AgentInitializationError when CLI is unavailable', async () => {
      const mockProcess = new EventEmitter() as MockProcess;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.kill = vi.fn();
      mockProcess.pid = 12345;

      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      setTimeout(() => {
        mockProcess.emit('error', new Error('ENOENT'));
      }, 10);

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

    it('executes command and captures stdout/stderr', async () => {
      const mockProcess = createMockProcess({
        exitCode: 0,
        stdout: 'output from stdout',
        stderr: 'output from stderr',
      });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.output).toContain('output from stdout');
      expect(result.output).toContain('output from stderr');
    });

    it('returns success=true with output on zero exit code', async () => {
      const mockProcess = createMockProcess({
        exitCode: 0,
        stdout: 'success output',
      });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('success output');
    });

    it('returns success=false with COMMAND_FAILED error on non-zero exit', async () => {
      const mockProcess = createMockProcess({
        exitCode: 1,
        stderr: 'command failed',
      });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error?.code).toBe(InvocationErrorCodes.COMMAND_FAILED);
    });

    it('returns success=false with TIMEOUT error when timeout exceeded', async () => {
      const mockProcess = new EventEmitter() as MockProcess;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.kill = vi.fn().mockImplementation(() => {
        // Emit close after kill
        setTimeout(() => {
          mockProcess.emit('close', null, 'SIGTERM');
        }, 5);
        return true;
      });
      mockProcess.pid = 12345;

      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const config: InvocationConfig = {
        ...baseConfig,
        timeout: 50,
      };

      const result = await invoker.invoke(config);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(InvocationErrorCodes.TIMEOUT);
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('passes mode via environment variable', async () => {
      const mockProcess = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const config: InvocationConfig = {
        command: '/speckit:specify',
        context: {
          workingDirectory: '/test/workspace',
          mode: 'test-mode',
        },
      };

      await invoker.invoke(config);

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_MODE: 'test-mode',
          }),
        })
      );
    });

    it('uses working directory from context', async () => {
      const mockProcess = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const config: InvocationConfig = {
        command: '/test:command',
        context: {
          workingDirectory: '/custom/workspace',
        },
      };

      await invoker.invoke(config);

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/custom/workspace',
        })
      );
    });

    it('merges environment variables from context', async () => {
      const mockProcess = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const config: InvocationConfig = {
        command: '/test:command',
        context: {
          workingDirectory: '/test/workspace',
          environment: {
            CUSTOM_VAR: 'custom-value',
          },
        },
      };

      await invoker.invoke(config);

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CUSTOM_VAR: 'custom-value',
          }),
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

      const mockProcess = createMockProcess({
        exitCode: 0,
        stdout: `Some output\n---TOOL_CALLS---\n${toolCallOutput}\n---END_TOOL_CALLS---\nMore output`,
      });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls?.[0]?.toolName).toBe('Read');
      expect(result.toolCalls?.[1]?.toolName).toBe('Write');
    });

    it('returns empty toolCalls when parsing fails (graceful degradation)', async () => {
      const mockProcess = createMockProcess({
        exitCode: 0,
        stdout: 'Normal output without tool calls',
      });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.invoke(baseConfig);

      expect(result.success).toBe(true);
      expect(result.toolCalls).toEqual([]);
    });

    it('tracks duration of invocation', async () => {
      const mockProcess = createMockProcess({
        exitCode: 0,
        delay: 50,
      });
      mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

      const result = await invoker.invoke(baseConfig);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shutdown', () => {
    it('completes without error', async () => {
      await expect(invoker.shutdown()).resolves.not.toThrow();
    });
  });
});
