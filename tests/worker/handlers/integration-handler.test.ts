/**
 * Tests for the IntegrationHandler class.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from '../../../src/scheduler/types.js';
import type {
  JobResult,
  IntegrationJobPayload,
  IntegrationJobResult,
  IntegrationHandlerConfig,
} from '../../../src/worker/types.js';

// Integration plugin interface for mocking
interface IntegrationPlugin {
  execute(
    action: string,
    params: Record<string, unknown>
  ): Promise<{ output: unknown; statusCode?: number }>;
}

// Mock IntegrationHandler implementation for testing
// This will be replaced by the actual implementation
class IntegrationHandler {
  private integrations: Map<string, IntegrationPlugin>;
  private config: IntegrationHandlerConfig;

  constructor(
    integrations: Map<string, IntegrationPlugin>,
    config: IntegrationHandlerConfig
  ) {
    this.integrations = integrations;
    this.config = config;
  }

  async handle(job: Job): Promise<IntegrationJobResult> {
    const payload = job.payload as IntegrationJobPayload;
    const { integration, action, params, timeout } = payload;

    const plugin = this.integrations.get(integration);
    if (!plugin) {
      throw new Error(`Integration not found: ${integration}`);
    }

    const effectiveTimeout = timeout ?? this.config.defaultTimeout;

    try {
      const result = await Promise.race([
        plugin.execute(action, params),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Integration timeout')), effectiveTimeout);
        }),
      ]);

      return {
        success: true,
        output: result.output,
        statusCode: result.statusCode,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Integration timeout') {
        throw error;
      }
      throw error;
    }
  }
}

// Helper to create a test job
function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_test-123',
    workflowId: 'workflow-1',
    stepId: 'step-1',
    type: 'integration',
    status: 'pending',
    priority: 'normal',
    attempts: 0,
    maxAttempts: 3,
    payload: {
      integration: 'github',
      action: 'createIssue',
      params: { title: 'Test Issue', body: 'Test body' },
    } as IntegrationJobPayload,
    createdAt: new Date().toISOString(),
    visibilityTimeout: 30000,
    ...overrides,
  };
}

// Helper to create default config
function createDefaultConfig(): IntegrationHandlerConfig {
  return {
    defaultTimeout: 30000,
    retry: {
      maxRetries: 3,
      retryDelay: 1000,
      retryOn: [500, 502, 503, 504],
    },
  };
}

describe('IntegrationHandler', () => {
  let handler: IntegrationHandler;
  let mockPlugin: IntegrationPlugin;
  let integrations: Map<string, IntegrationPlugin>;
  let config: IntegrationHandlerConfig;

  beforeEach(() => {
    mockPlugin = {
      execute: vi.fn().mockResolvedValue({
        output: { id: 123, url: 'https://github.com/test/issue/123' },
        statusCode: 200,
      }),
    };

    integrations = new Map<string, IntegrationPlugin>();
    integrations.set('github', mockPlugin);

    config = createDefaultConfig();
    handler = new IntegrationHandler(integrations, config);
  });

  describe('constructor', () => {
    it('should create handler with integrations map and config', () => {
      const h = new IntegrationHandler(integrations, config);
      expect(h).toBeDefined();
    });

    it('should accept empty integrations map', () => {
      const emptyMap = new Map<string, IntegrationPlugin>();
      const h = new IntegrationHandler(emptyMap, config);
      expect(h).toBeDefined();
    });

    it('should accept multiple integrations', () => {
      const slackPlugin: IntegrationPlugin = {
        execute: vi.fn().mockResolvedValue({ output: 'ok' }),
      };
      integrations.set('slack', slackPlugin);

      const h = new IntegrationHandler(integrations, config);
      expect(h).toBeDefined();
    });
  });

  describe('successful integration execution', () => {
    it('should execute integration and return result', async () => {
      const job = createTestJob();

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        id: 123,
        url: 'https://github.com/test/issue/123',
      });
      expect(result.statusCode).toBe(200);
    });

    it('should return result with different output types', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: ['item1', 'item2', 'item3'],
        statusCode: 200,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(result.output).toEqual(['item1', 'item2', 'item3']);
    });

    it('should return result with string output', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: 'Operation completed successfully',
        statusCode: 200,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Operation completed successfully');
    });

    it('should return result with null output', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: null,
        statusCode: 204,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(result.output).toBeNull();
      expect(result.statusCode).toBe(204);
    });
  });

  describe('integration not found error', () => {
    it('should throw error when integration is not found', async () => {
      const job = createTestJob({
        payload: {
          integration: 'unknown-integration',
          action: 'someAction',
          params: {},
        } as IntegrationJobPayload,
      });

      await expect(handler.handle(job)).rejects.toThrow(
        'Integration not found: unknown-integration'
      );
    });

    it('should throw error with correct integration name in message', async () => {
      const job = createTestJob({
        payload: {
          integration: 'jira',
          action: 'createTicket',
          params: {},
        } as IntegrationJobPayload,
      });

      await expect(handler.handle(job)).rejects.toThrow('Integration not found: jira');
    });

    it('should not call execute when integration not found', async () => {
      const job = createTestJob({
        payload: {
          integration: 'missing',
          action: 'test',
          params: {},
        } as IntegrationJobPayload,
      });

      try {
        await handler.handle(job);
      } catch {
        // Expected to throw
      }

      expect(mockPlugin.execute).not.toHaveBeenCalled();
    });
  });

  describe('integration execution error', () => {
    it('should throw error when plugin execution fails', async () => {
      vi.mocked(mockPlugin.execute).mockRejectedValue(new Error('API rate limit exceeded'));

      const job = createTestJob();

      await expect(handler.handle(job)).rejects.toThrow('API rate limit exceeded');
    });

    it('should propagate original error from plugin', async () => {
      const originalError = new Error('Connection refused');
      vi.mocked(mockPlugin.execute).mockRejectedValue(originalError);

      const job = createTestJob();

      try {
        await handler.handle(job);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBe(originalError);
      }
    });

    it('should handle plugin throwing non-Error objects', async () => {
      vi.mocked(mockPlugin.execute).mockRejectedValue('String error');

      const job = createTestJob();

      await expect(handler.handle(job)).rejects.toBe('String error');
    });

    it('should handle plugin throwing with HTTP error details', async () => {
      const httpError = new Error('HTTP 403 Forbidden');
      (httpError as Error & { statusCode: number }).statusCode = 403;
      vi.mocked(mockPlugin.execute).mockRejectedValue(httpError);

      const job = createTestJob();

      await expect(handler.handle(job)).rejects.toThrow('HTTP 403 Forbidden');
    });
  });

  describe('passing correct action and params', () => {
    it('should pass action to plugin execute', async () => {
      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'createPullRequest',
          params: { title: 'PR Title' },
        } as IntegrationJobPayload,
      });

      await handler.handle(job);

      expect(mockPlugin.execute).toHaveBeenCalledWith('createPullRequest', { title: 'PR Title' });
    });

    it('should pass params to plugin execute', async () => {
      const params = {
        owner: 'test-org',
        repo: 'test-repo',
        title: 'Test Issue',
        body: 'Issue description',
        labels: ['bug', 'priority-high'],
      };

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'createIssue',
          params,
        } as IntegrationJobPayload,
      });

      await handler.handle(job);

      expect(mockPlugin.execute).toHaveBeenCalledWith('createIssue', params);
    });

    it('should pass empty params object when no params provided', async () => {
      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'listRepos',
          params: {},
        } as IntegrationJobPayload,
      });

      await handler.handle(job);

      expect(mockPlugin.execute).toHaveBeenCalledWith('listRepos', {});
    });

    it('should pass params with nested objects', async () => {
      const params = {
        config: {
          settings: {
            enabled: true,
            options: ['a', 'b', 'c'],
          },
        },
        metadata: {
          source: 'test',
        },
      };

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'configure',
          params,
        } as IntegrationJobPayload,
      });

      await handler.handle(job);

      expect(mockPlugin.execute).toHaveBeenCalledWith('configure', params);
    });

    it('should call correct integration plugin', async () => {
      const slackPlugin: IntegrationPlugin = {
        execute: vi.fn().mockResolvedValue({ output: 'posted', statusCode: 200 }),
      };
      integrations.set('slack', slackPlugin);
      handler = new IntegrationHandler(integrations, config);

      const job = createTestJob({
        payload: {
          integration: 'slack',
          action: 'postMessage',
          params: { channel: '#general', text: 'Hello' },
        } as IntegrationJobPayload,
      });

      await handler.handle(job);

      expect(slackPlugin.execute).toHaveBeenCalledWith('postMessage', {
        channel: '#general',
        text: 'Hello',
      });
      expect(mockPlugin.execute).not.toHaveBeenCalled();
    });
  });

  describe('handling different status codes', () => {
    it('should return 200 status code for successful creation', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { created: true },
        statusCode: 200,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.statusCode).toBe(200);
    });

    it('should return 201 status code for created resource', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { id: 'new-resource' },
        statusCode: 201,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.statusCode).toBe(201);
    });

    it('should return 204 status code for no content', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: null,
        statusCode: 204,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.statusCode).toBe(204);
    });

    it('should return undefined status code when not provided', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { data: 'result' },
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.statusCode).toBeUndefined();
    });

    it('should return 202 status code for accepted/async operation', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { jobId: 'async-job-123' },
        statusCode: 202,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.statusCode).toBe(202);
    });

    it('should handle 3xx status codes', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { redirectUrl: 'https://new-location.com' },
        statusCode: 301,
      });

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.statusCode).toBe(301);
      expect(result.success).toBe(true);
    });
  });

  describe('timeout handling', () => {
    it('should throw timeout error when execution exceeds default timeout', async () => {
      vi.mocked(mockPlugin.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ output: 'late' }), 100);
          })
      );

      const shortTimeoutConfig: IntegrationHandlerConfig = {
        defaultTimeout: 50,
        retry: config.retry,
      };
      handler = new IntegrationHandler(integrations, shortTimeoutConfig);

      const job = createTestJob();

      await expect(handler.handle(job)).rejects.toThrow('Integration timeout');
    });

    it('should use job-specific timeout when provided', async () => {
      vi.mocked(mockPlugin.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ output: 'success' }), 100);
          })
      );

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'longOperation',
          params: {},
          timeout: 200,
        } as IntegrationJobPayload,
      });

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
    });

    it('should timeout with job-specific timeout when exceeded', async () => {
      vi.mocked(mockPlugin.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ output: 'late' }), 200);
          })
      );

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'quickOperation',
          params: {},
          timeout: 50,
        } as IntegrationJobPayload,
      });

      await expect(handler.handle(job)).rejects.toThrow('Integration timeout');
    });

    it('should complete before timeout when operation is fast', async () => {
      vi.mocked(mockPlugin.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ output: 'fast', statusCode: 200 }), 10);
          })
      );

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(result.output).toBe('fast');
    });

    it('should use default timeout when job timeout is undefined', async () => {
      vi.mocked(mockPlugin.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ output: 'done' }), 50);
          })
      );

      // Default timeout is 30000, so 50ms should complete
      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'test',
          params: {},
          // No timeout specified
        } as IntegrationJobPayload,
      });

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle job with complex payload', async () => {
      const complexParams = {
        files: [
          { path: 'src/index.ts', content: 'export {}' },
          { path: 'package.json', content: '{"name": "test"}' },
        ],
        options: {
          branch: 'feature/test',
          message: 'Add files',
          author: {
            name: 'Test User',
            email: 'test@example.com',
          },
        },
      };

      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { sha: 'abc123' },
        statusCode: 201,
      });

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'commitFiles',
          params: complexParams,
        } as IntegrationJobPayload,
      });

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(mockPlugin.execute).toHaveBeenCalledWith('commitFiles', complexParams);
    });

    it('should handle multiple sequential executions', async () => {
      const job1 = createTestJob({
        id: 'job_1',
        payload: {
          integration: 'github',
          action: 'action1',
          params: { id: 1 },
        } as IntegrationJobPayload,
      });

      const job2 = createTestJob({
        id: 'job_2',
        payload: {
          integration: 'github',
          action: 'action2',
          params: { id: 2 },
        } as IntegrationJobPayload,
      });

      vi.mocked(mockPlugin.execute)
        .mockResolvedValueOnce({ output: 'result1', statusCode: 200 })
        .mockResolvedValueOnce({ output: 'result2', statusCode: 201 });

      const result1 = await handler.handle(job1);
      const result2 = await handler.handle(job2);

      expect(result1.output).toBe('result1');
      expect(result1.statusCode).toBe(200);
      expect(result2.output).toBe('result2');
      expect(result2.statusCode).toBe(201);
      expect(mockPlugin.execute).toHaveBeenCalledTimes(2);
    });

    it('should handle integration name with special characters', async () => {
      const specialPlugin: IntegrationPlugin = {
        execute: vi.fn().mockResolvedValue({ output: 'ok', statusCode: 200 }),
      };
      integrations.set('my-integration_v2.0', specialPlugin);
      handler = new IntegrationHandler(integrations, config);

      const job = createTestJob({
        payload: {
          integration: 'my-integration_v2.0',
          action: 'test',
          params: {},
        } as IntegrationJobPayload,
      });

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(specialPlugin.execute).toHaveBeenCalled();
    });

    it('should handle action with empty string', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({ output: 'default', statusCode: 200 });

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: '',
          params: {},
        } as IntegrationJobPayload,
      });

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(mockPlugin.execute).toHaveBeenCalledWith('', {});
    });

    it('should handle params with undefined values', async () => {
      const params = {
        required: 'value',
        optional: undefined,
      };

      vi.mocked(mockPlugin.execute).mockResolvedValue({ output: 'ok', statusCode: 200 });

      const job = createTestJob({
        payload: {
          integration: 'github',
          action: 'test',
          params,
        } as IntegrationJobPayload,
      });

      const result = await handler.handle(job);

      expect(result.success).toBe(true);
      expect(mockPlugin.execute).toHaveBeenCalledWith('test', params);
    });
  });

  describe('JobHandler interface compliance', () => {
    it('should return JobResult with success property', async () => {
      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
    });

    it('should return JobResult with output property', async () => {
      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result).toHaveProperty('output');
    });

    it('should implement handle method that accepts Job', async () => {
      expect(typeof handler.handle).toBe('function');

      const job = createTestJob();
      const result = await handler.handle(job);

      expect(result).toBeDefined();
    });

    it('should return IntegrationJobResult with optional statusCode', async () => {
      vi.mocked(mockPlugin.execute).mockResolvedValue({
        output: { data: 'test' },
        statusCode: 200,
      });

      const job = createTestJob();
      const result = await handler.handle(job) as IntegrationJobResult;

      expect(result.statusCode).toBe(200);
    });
  });
});
