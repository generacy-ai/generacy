/**
 * Unit tests for Invoker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { Invoker } from '../../src/invocation/invoker.js';
import { Session } from '../../src/session/session.js';
import type { ContainerConfig } from '../../src/types.js';
import { buildClaudeCommand, buildModeCommand } from '../../src/invocation/types.js';

// Mock ContainerManager
const createMockContainerManager = () => ({
  exec: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      type: 'result',
      exit_code: 0,
      content: 'Task completed successfully',
    }),
    stderr: '',
  }),
  getContainer: vi.fn().mockReturnValue({
    containerId: 'container-123',
    state: { status: 'running', containerId: 'container-123' },
  }),
});

const createMockLogger = (): Logger =>
  ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

const createTestConfig = (): ContainerConfig => ({
  image: 'test-image:latest',
  workdir: '/workspace',
  env: {},
  mounts: [],
  network: 'test-network',
});

describe('Invoker', () => {
  let invoker: Invoker;
  let mockContainerManager: ReturnType<typeof createMockContainerManager>;
  let mockLogger: Logger;
  let session: Session;

  beforeEach(() => {
    mockContainerManager = createMockContainerManager();
    mockLogger = createMockLogger();
    invoker = new Invoker(mockContainerManager as any, mockLogger);

    session = new Session({ containerConfig: createTestConfig() });
    session.onContainerStarted('container-123');
  });

  describe('invoke', () => {
    it('should execute a prompt and return result', async () => {
      const result = await invoker.invoke(session, 'Hello, Claude');

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(session.id);
      expect(result.invocationId).toBeDefined();
      expect(result.exitCode).toBe(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should call container exec with correct command', async () => {
      await invoker.invoke(session, 'Test prompt');

      expect(mockContainerManager.exec).toHaveBeenCalledWith(
        session.id,
        expect.arrayContaining(['claude', '--headless', '--prompt', 'Test prompt']),
        expect.any(Object)
      );
    });

    it('should set mode before invocation if specified', async () => {
      await invoker.invoke(session, 'Test prompt', { mode: 'test-mode' });

      // First call should be mode setting
      expect(mockContainerManager.exec).toHaveBeenCalledWith(
        session.id,
        ['agency', 'mode', 'set', 'test-mode'],
        expect.any(Object)
      );
    });

    it('should handle failed invocations', async () => {
      mockContainerManager.exec.mockResolvedValue({
        exitCode: 1,
        stdout: JSON.stringify({ type: 'error', error: 'Something failed' }),
        stderr: 'Error output',
      });

      const result = await invoker.invoke(session, 'Failing prompt');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBeDefined();
    });

    it('should track invocation state', async () => {
      const result = await invoker.invoke(session, 'Test prompt');

      const invocation = invoker.getInvocation(result.invocationId);

      expect(invocation).toBeDefined();
      expect(invocation!.sessionId).toBe(session.id);
      expect(invocation!.prompt).toBe('Test prompt');
      expect(invocation!.state.status).toBe('completed');
    });

    it('should handle timeout', async () => {
      mockContainerManager.exec.mockRejectedValue(
        new Error('Command timed out after 1000ms')
      );

      const result = await invoker.invoke(session, 'Slow prompt', {
        timeout: 1000,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('API_TIMEOUT');
    });

    it('should collect modified files from tool results', async () => {
      mockContainerManager.exec.mockResolvedValue({
        exitCode: 0,
        stdout: [
          JSON.stringify({
            type: 'tool_result',
            tool: 'Write',
            file: '/workspace/file1.ts',
            result: { success: true },
          }),
          JSON.stringify({
            type: 'tool_result',
            tool: 'Write',
            file: '/workspace/file2.ts',
            result: { success: true },
          }),
          JSON.stringify({ type: 'result', exit_code: 0 }),
        ].join('\n'),
        stderr: '',
      });

      const result = await invoker.invoke(session, 'Create files');

      expect(result.filesModified).toContain('/workspace/file1.ts');
      expect(result.filesModified).toContain('/workspace/file2.ts');
    });
  });

  describe('setMode', () => {
    it('should execute mode command', async () => {
      await invoker.setMode(session.id, 'production');

      expect(mockContainerManager.exec).toHaveBeenCalledWith(
        session.id,
        ['agency', 'mode', 'set', 'production'],
        expect.any(Object)
      );
    });

    it('should throw on mode setting failure', async () => {
      mockContainerManager.exec.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Mode not found',
      });

      await expect(invoker.setMode(session.id, 'invalid-mode')).rejects.toThrow(
        'Failed to set mode'
      );
    });
  });

  describe('executeCommand', () => {
    it('should execute command and parse output', async () => {
      mockContainerManager.exec.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ type: 'assistant', content: 'Hello' }) + '\n',
        stderr: '',
      });

      const result = await invoker.executeCommand(session.id, ['echo', 'test']);

      expect(result.exitCode).toBe(0);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]!.type).toBe('stdout');
    });

    it('should call onOutput callback for each chunk', async () => {
      mockContainerManager.exec.mockResolvedValue({
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'assistant', content: 'Line 1' }),
          JSON.stringify({ type: 'assistant', content: 'Line 2' }),
        ].join('\n') + '\n',
        stderr: '',
      });

      const chunks: any[] = [];
      await invoker.executeCommand(session.id, ['test'], {
        onOutput: (chunk) => chunks.push(chunk),
      });

      expect(chunks).toHaveLength(2);
    });
  });

  describe('getSessionInvocations', () => {
    it('should return invocations for a session', async () => {
      await invoker.invoke(session, 'Prompt 1');
      await invoker.invoke(session, 'Prompt 2');

      const invocations = invoker.getSessionInvocations(session.id);

      expect(invocations).toHaveLength(2);
    });

    it('should return empty array for unknown session', () => {
      const invocations = invoker.getSessionInvocations('unknown');

      expect(invocations).toHaveLength(0);
    });
  });

  describe('cleanupSession', () => {
    it('should remove invocations for a session', async () => {
      await invoker.invoke(session, 'Prompt 1');
      await invoker.invoke(session, 'Prompt 2');

      invoker.cleanupSession(session.id);

      const invocations = invoker.getSessionInvocations(session.id);
      expect(invocations).toHaveLength(0);
    });
  });
});

describe('buildClaudeCommand', () => {
  it('should build basic command', () => {
    const cmd = buildClaudeCommand({ prompt: 'Test' });

    expect(cmd).toContain('claude');
    expect(cmd).toContain('--headless');
    expect(cmd).toContain('--prompt');
    expect(cmd).toContain('Test');
  });

  it('should include json output flag', () => {
    const cmd = buildClaudeCommand({
      prompt: 'Test',
      outputFormat: 'json',
    });

    expect(cmd).toContain('--output');
    expect(cmd).toContain('json');
  });

  it('should include tools whitelist', () => {
    const cmd = buildClaudeCommand({
      prompt: 'Test',
      tools: ['Read', 'Write'],
    });

    expect(cmd).toContain('--allowedTools');
    expect(cmd).toContain('Read,Write');
  });

  it('should include working directory', () => {
    const cmd = buildClaudeCommand({
      prompt: 'Test',
      workdir: '/workspace',
    });

    expect(cmd).toContain('--cwd');
    expect(cmd).toContain('/workspace');
  });

  it('should include resume session', () => {
    const cmd = buildClaudeCommand({
      prompt: 'Test',
      resumeSession: 'session-123',
    });

    expect(cmd).toContain('--resume');
    expect(cmd).toContain('session-123');
  });

  it('should include max turns', () => {
    const cmd = buildClaudeCommand({
      prompt: 'Test',
      maxTurns: 50,
    });

    expect(cmd).toContain('--max-turns');
    expect(cmd).toContain('50');
  });
});

describe('buildModeCommand', () => {
  it('should build mode command', () => {
    const cmd = buildModeCommand('production');

    expect(cmd).toEqual(['agency', 'mode', 'set', 'production']);
  });
});
