/**
 * Unit tests for artifact operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtifactOperations } from '../../src/operations/artifacts.js';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import { MAX_ARTIFACT_SIZE_BYTES } from '../../src/types/artifacts.js';
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
  artifactBucket: 'test-artifacts',
  retry: {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
  },
  logPollingIntervalMs: 2000,
};

// Mock build response with artifacts
const mockBuildWithArtifacts = {
  id: 'build-123',
  projectId: 'test-project',
  status: 4,
  artifacts: {
    objects: {
      location: 'gs://artifact-bucket/builds/build-123',
      paths: ['dist/**'],
    },
  },
};

// Mock file metadata
const mockFileMetadata = {
  size: '1024',
  contentType: 'application/octet-stream',
  generation: '12345',
  md5Hash: 'abc123',
  crc32c: 'def456',
  updated: '2024-01-01T00:00:00Z',
};

// Create mock storage
const createMockStorage = () => {
  const mockFile = {
    name: 'dist/bundle.js',
    getMetadata: vi.fn().mockResolvedValue([mockFileMetadata]),
    download: vi.fn().mockResolvedValue([Buffer.from('file contents')]),
    createReadStream: vi.fn().mockReturnValue({
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          setTimeout(() => callback(Buffer.from('stream data')), 0);
        }
        if (event === 'end') {
          setTimeout(() => callback(), 10);
        }
        return { on: vi.fn() };
      }),
      destroy: vi.fn(),
    }),
  };

  const mockBucket = {
    file: vi.fn().mockReturnValue(mockFile),
    getFiles: vi.fn().mockResolvedValue([[mockFile]]),
  };

  return {
    bucket: vi.fn().mockReturnValue(mockBucket),
    _mockFile: mockFile,
    _mockBucket: mockBucket,
  };
};

// Create mock Cloud Build client
const createMockCloudBuildClient = () => ({
  getBuild: vi.fn().mockResolvedValue([mockBuildWithArtifacts]),
});

describe('ArtifactOperations', () => {
  let mockCloudBuildClient: ReturnType<typeof createMockCloudBuildClient>;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let artifactOps: ArtifactOperations;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudBuildClient = createMockCloudBuildClient();
    mockStorage = createMockStorage();
    artifactOps = new ArtifactOperations(
      mockCloudBuildClient as any,
      mockStorage as any,
      mockConfig,
      mockLogger
    );
  });

  describe('listArtifacts', () => {
    it('should list artifacts from build config', async () => {
      const artifacts = await artifactOps.listArtifacts('build-123');

      expect(mockCloudBuildClient.getBuild).toHaveBeenCalledWith({
        projectId: 'test-project',
        id: 'build-123',
      });
      expect(artifacts.length).toBeGreaterThan(0);
    });

    it('should throw NotFoundError when build not found', async () => {
      mockCloudBuildClient.getBuild.mockResolvedValue([null]);

      await expect(artifactOps.listArtifacts('nonexistent'))
        .rejects.toThrow(NotFoundError);
    });

    it('should map artifact metadata correctly', async () => {
      const artifacts = await artifactOps.listArtifacts('build-123');

      const artifact = artifacts[0];
      expect(artifact?.path).toBe('dist/bundle.js');
      expect(artifact?.size).toBe(1024);
      expect(artifact?.contentType).toBe('application/octet-stream');
      expect(artifact?.md5Hash).toBe('abc123');
      expect(artifact?.updated).toBeInstanceOf(Date);
    });

    it('should also check configured artifact bucket', async () => {
      await artifactOps.listArtifacts('build-123');

      // Should check both the build artifacts and the configured bucket
      expect(mockStorage.bucket).toHaveBeenCalledWith('artifact-bucket');
      expect(mockStorage.bucket).toHaveBeenCalledWith('test-artifacts');
    });
  });

  describe('getArtifact', () => {
    it('should download artifact as Buffer', async () => {
      const buffer = await artifactOps.getArtifact('build-123', 'dist/bundle.js');

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe('file contents');
    });

    it('should throw NotFoundError when artifact not found', async () => {
      mockStorage._mockBucket.getFiles.mockResolvedValue([[]]);

      await expect(artifactOps.getArtifact('build-123', 'nonexistent.js'))
        .rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when artifact exceeds size limit', async () => {
      // Set file size above limit
      mockStorage._mockFile.getMetadata.mockResolvedValue([{
        ...mockFileMetadata,
        size: String(MAX_ARTIFACT_SIZE_BYTES + 1),
      }]);

      await expect(artifactOps.getArtifact('build-123', 'dist/bundle.js'))
        .rejects.toThrow(ValidationError);
    });

    it('should match artifact by path suffix', async () => {
      mockStorage._mockFile.name = 'builds/build-123/dist/bundle.js';
      mockStorage._mockBucket.getFiles.mockResolvedValue([[mockStorage._mockFile]]);

      // Should match by suffix
      const buffer = await artifactOps.getArtifact('build-123', 'bundle.js');

      expect(buffer).toBeInstanceOf(Buffer);
    });
  });

  describe('getArtifactStream', () => {
    it('should return a ReadableStream', async () => {
      const stream = await artifactOps.getArtifactStream('build-123', 'dist/bundle.js');

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should throw NotFoundError when artifact not found', async () => {
      mockStorage._mockBucket.getFiles.mockResolvedValue([[]]);

      await expect(artifactOps.getArtifactStream('build-123', 'nonexistent.js'))
        .rejects.toThrow(NotFoundError);
    });

    it('should work for large files (no size limit)', async () => {
      // Set file size above Buffer limit
      mockStorage._mockFile.getMetadata.mockResolvedValue([{
        ...mockFileMetadata,
        size: String(MAX_ARTIFACT_SIZE_BYTES + 1),
      }]);

      // Should NOT throw - streaming has no size limit
      const stream = await artifactOps.getArtifactStream('build-123', 'dist/bundle.js');

      expect(stream).toBeInstanceOf(ReadableStream);
    });
  });
});
