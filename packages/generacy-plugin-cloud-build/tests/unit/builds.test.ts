/**
 * Unit tests for build operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuildOperations } from '../../src/operations/builds.js';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import type { CloudBuildConfig } from '../../src/config/types.js';
import type { Logger } from 'pino';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

// Mock config
const mockConfig: CloudBuildConfig = {
  projectId: 'test-project',
  location: 'global',
  retry: {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
  },
  logPollingIntervalMs: 2000,
};

// Mock build response
const mockBuildResponse = {
  id: 'build-123',
  projectId: 'test-project',
  status: 4, // SUCCESS
  statusDetail: 'Build completed',
  createTime: { seconds: 1704067200, nanos: 0 },
  startTime: { seconds: 1704067210, nanos: 0 },
  finishTime: { seconds: 1704067310, nanos: 0 },
  steps: [
    {
      id: 'step-1',
      name: 'node:20',
      args: ['install'],
      status: 4, // SUCCESS
    },
  ],
  logUrl: 'https://console.cloud.google.com/cloud-build/builds/build-123',
  tags: ['test'],
};

// Mock Cloud Build client
const createMockClient = () => ({
  runBuildTrigger: vi.fn().mockResolvedValue([
    { promise: () => Promise.resolve([mockBuildResponse]) },
  ]),
  createBuild: vi.fn().mockResolvedValue([
    { promise: () => Promise.resolve([mockBuildResponse]) },
  ]),
  getBuild: vi.fn().mockResolvedValue([mockBuildResponse]),
  listBuilds: vi.fn().mockResolvedValue([[mockBuildResponse], null, { nextPageToken: undefined }]),
  cancelBuild: vi.fn().mockResolvedValue([{}]),
  retryBuild: vi.fn().mockResolvedValue([
    { promise: () => Promise.resolve([mockBuildResponse]) },
  ]),
});

describe('BuildOperations', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let buildOps: BuildOperations;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    buildOps = new BuildOperations(mockClient as any, mockConfig, mockLogger);
  });

  describe('triggerBuild', () => {
    it('should trigger a build from a trigger ID', async () => {
      const result = await buildOps.triggerBuild('trigger-123');

      expect(mockClient.runBuildTrigger).toHaveBeenCalledWith({
        projectId: 'test-project',
        triggerId: 'trigger-123',
        source: undefined,
      });
      expect(result.id).toBe('build-123');
      expect(result.status).toBe('SUCCESS');
    });

    it('should pass source when provided', async () => {
      const source = {
        repoSource: {
          repoName: 'my-repo',
          branchName: 'main',
        },
      };

      await buildOps.triggerBuild('trigger-123', source);

      // runBuildTrigger API expects RepoSource directly, not nested under source.repoSource
      expect(mockClient.runBuildTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            repoName: 'my-repo',
            branchName: 'main',
          }),
        })
      );
    });
  });

  describe('runBuild', () => {
    it('should create a build from config', async () => {
      const config = {
        steps: [{ name: 'node:20', args: ['install'] }],
      };

      const result = await buildOps.runBuild(config);

      expect(mockClient.createBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'test-project',
          build: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ name: 'node:20' }),
            ]),
          }),
        })
      );
      expect(result.id).toBe('build-123');
    });

    it('should throw ValidationError when no steps provided', async () => {
      await expect(buildOps.runBuild({ steps: [] }))
        .rejects.toThrow(ValidationError);
    });

    it('should pass all build options', async () => {
      const config = {
        steps: [{ name: 'node:20', args: ['build'] }],
        timeout: '3600s',
        tags: ['production'],
        substitutions: { _ENV: 'prod' },
      };

      await buildOps.runBuild(config);

      expect(mockClient.createBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          build: expect.objectContaining({
            timeout: { seconds: 3600 },
            tags: ['production'],
            substitutions: { _ENV: 'prod' },
          }),
        })
      );
    });
  });

  describe('getBuild', () => {
    it('should get a build by ID', async () => {
      const result = await buildOps.getBuild('build-123');

      expect(mockClient.getBuild).toHaveBeenCalledWith({
        projectId: 'test-project',
        id: 'build-123',
      });
      expect(result.id).toBe('build-123');
    });

    it('should throw NotFoundError when build not found', async () => {
      mockClient.getBuild.mockResolvedValue([null]);

      await expect(buildOps.getBuild('nonexistent'))
        .rejects.toThrow(NotFoundError);
    });

    it('should map all build fields correctly', async () => {
      const result = await buildOps.getBuild('build-123');

      expect(result.id).toBe('build-123');
      expect(result.projectId).toBe('test-project');
      expect(result.status).toBe('SUCCESS');
      expect(result.statusDetail).toBe('Build completed');
      expect(result.createTime).toBeInstanceOf(Date);
      expect(result.startTime).toBeInstanceOf(Date);
      expect(result.finishTime).toBeInstanceOf(Date);
      expect(result.duration).toBe(100); // 310 - 210 seconds
      expect(result.logUrl).toBe('https://console.cloud.google.com/cloud-build/builds/build-123');
      expect(result.tags).toEqual(['test']);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.name).toBe('node:20');
    });
  });

  describe('listBuilds', () => {
    it('should list builds without filter', async () => {
      const result = await buildOps.listBuilds();

      expect(mockClient.listBuilds).toHaveBeenCalledWith({
        projectId: 'test-project',
        filter: undefined,
        pageSize: 50,
        pageToken: undefined,
      });
      expect(result.items).toHaveLength(1);
    });

    it('should apply status filter', async () => {
      await buildOps.listBuilds({ status: 'SUCCESS' });

      expect(mockClient.listBuilds).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: '(status="SUCCESS")',
        })
      );
    });

    it('should apply multiple status filters', async () => {
      await buildOps.listBuilds({ status: ['SUCCESS', 'FAILURE'] });

      expect(mockClient.listBuilds).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: '(status="SUCCESS" OR status="FAILURE")',
        })
      );
    });

    it('should apply trigger filter', async () => {
      await buildOps.listBuilds({ triggerId: 'trigger-123' });

      expect(mockClient.listBuilds).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: 'build_trigger_id="trigger-123"',
        })
      );
    });

    it('should apply pagination', async () => {
      await buildOps.listBuilds({ pageSize: 10, pageToken: 'token-123' });

      expect(mockClient.listBuilds).toHaveBeenCalledWith(
        expect.objectContaining({
          pageSize: 10,
          pageToken: 'token-123',
        })
      );
    });
  });

  describe('cancelBuild', () => {
    it('should cancel a build', async () => {
      await buildOps.cancelBuild('build-123');

      expect(mockClient.cancelBuild).toHaveBeenCalledWith({
        projectId: 'test-project',
        id: 'build-123',
      });
    });
  });

  describe('retryBuild', () => {
    it('should retry a build', async () => {
      const result = await buildOps.retryBuild('build-123');

      expect(mockClient.retryBuild).toHaveBeenCalledWith({
        projectId: 'test-project',
        id: 'build-123',
      });
      expect(result.id).toBe('build-123');
    });
  });

  describe('status mapping', () => {
    it.each([
      [0, 'STATUS_UNKNOWN'],
      [1, 'PENDING'],
      [2, 'QUEUED'],
      [3, 'WORKING'],
      [4, 'SUCCESS'],
      [5, 'FAILURE'],
      [6, 'INTERNAL_ERROR'],
      [7, 'TIMEOUT'],
      [8, 'CANCELLED'],
      [9, 'EXPIRED'],
    ])('should map status %i to %s', async (statusCode, expectedStatus) => {
      mockClient.getBuild.mockResolvedValue([{ ...mockBuildResponse, status: statusCode }]);

      const result = await buildOps.getBuild('build-123');

      expect(result.status).toBe(expectedStatus);
    });
  });
});
