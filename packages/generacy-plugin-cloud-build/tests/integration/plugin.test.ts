/**
 * Integration tests for the Cloud Build plugin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudBuildPlugin } from '../../src/plugin.js';
import type { CloudBuildConfigInput } from '../../src/config/types.js';
import type { Logger } from 'pino';

// Mock Google Cloud libraries
vi.mock('@google-cloud/cloudbuild', () => ({
  CloudBuildClient: vi.fn().mockImplementation(() => ({
    runBuildTrigger: vi.fn().mockResolvedValue([
      { promise: () => Promise.resolve([{ id: 'build-123', status: 4 }]) },
    ]),
    createBuild: vi.fn().mockResolvedValue([
      { promise: () => Promise.resolve([{ id: 'build-456', status: 1 }]) },
    ]),
    getBuild: vi.fn().mockResolvedValue([{ id: 'build-123', status: 4, steps: [] }]),
    listBuilds: vi.fn().mockResolvedValue([
      [{ id: 'build-123', status: 4, steps: [] }],
      null,
      { nextPageToken: undefined },
    ]),
    cancelBuild: vi.fn().mockResolvedValue([{}]),
    retryBuild: vi.fn().mockResolvedValue([
      { promise: () => Promise.resolve([{ id: 'build-789', status: 1 }]) },
    ]),
    listBuildTriggers: vi.fn().mockResolvedValue([
      [{ id: 'trigger-123', name: 'test-trigger' }],
    ]),
    createBuildTrigger: vi.fn().mockResolvedValue([
      { id: 'trigger-456', name: 'new-trigger' },
    ]),
    getBuildTrigger: vi.fn().mockResolvedValue([
      { id: 'trigger-123', name: 'test-trigger' },
    ]),
    updateBuildTrigger: vi.fn().mockResolvedValue([
      { id: 'trigger-123', name: 'updated-trigger' },
    ]),
    deleteBuildTrigger: vi.fn().mockResolvedValue([{}]),
  })),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: vi.fn().mockReturnValue({
      file: vi.fn().mockReturnValue({
        getMetadata: vi.fn().mockResolvedValue([{
          size: '1024',
          contentType: 'text/plain',
          updated: new Date().toISOString(),
        }]),
        download: vi.fn().mockResolvedValue([Buffer.from('test content')]),
        createReadStream: vi.fn().mockReturnValue({
          on: vi.fn((event, callback) => {
            if (event === 'end') setTimeout(callback, 0);
            return { on: vi.fn() };
          }),
          destroy: vi.fn(),
        }),
      }),
      getFiles: vi.fn().mockResolvedValue([[
        { name: 'artifact.txt' },
      ]]),
    }),
  })),
}));

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

describe('CloudBuildPlugin', () => {
  let plugin: CloudBuildPlugin;

  const validConfig: CloudBuildConfigInput = {
    projectId: 'test-project',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new CloudBuildPlugin(validConfig, { logger: mockLogger });
  });

  describe('initialization', () => {
    it('should initialize with minimal config', () => {
      const p = new CloudBuildPlugin({ projectId: 'test-project' });
      expect(p).toBeInstanceOf(CloudBuildPlugin);
    });

    it('should initialize with full config', () => {
      const p = new CloudBuildPlugin({
        projectId: 'test-project',
        location: 'us-central1',
        serviceAccountKey: JSON.stringify({
          type: 'service_account',
          project_id: 'test-project',
          private_key_id: 'key-id',
          private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n',
          client_email: 'test@test-project.iam.gserviceaccount.com',
          client_id: '123',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
          auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
          client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
        }),
        defaultTrigger: 'my-trigger',
        artifactBucket: 'my-bucket',
        retry: {
          maxAttempts: 5,
          initialDelayMs: 2000,
          maxDelayMs: 60000,
        },
        logPollingIntervalMs: 5000,
      });
      expect(p).toBeInstanceOf(CloudBuildPlugin);
    });

    it('should throw on invalid projectId', () => {
      expect(() => new CloudBuildPlugin({ projectId: '' }))
        .toThrow();
    });
  });

  describe('build operations', () => {
    it('should trigger a build', async () => {
      const result = await plugin.triggerBuild('trigger-123');
      expect(result.id).toBe('build-123');
    });

    it('should run a build', async () => {
      const result = await plugin.runBuild({
        steps: [{ name: 'node:20', args: ['install'] }],
      });
      expect(result.id).toBe('build-456');
    });

    it('should get a build', async () => {
      const result = await plugin.getBuild('build-123');
      expect(result.id).toBe('build-123');
    });

    it('should list builds', async () => {
      const result = await plugin.listBuilds();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe('build-123');
    });

    it('should cancel a build', async () => {
      await expect(plugin.cancelBuild('build-123')).resolves.not.toThrow();
    });

    it('should retry a build', async () => {
      const result = await plugin.retryBuild('build-123');
      expect(result.id).toBe('build-789');
    });
  });

  describe('log operations', () => {
    it('should return an AsyncIterable for log streaming', () => {
      const stream = plugin.streamLogs('build-123');
      expect(stream[Symbol.asyncIterator]).toBeDefined();
    });
  });

  describe('artifact operations', () => {
    it('should list artifacts', async () => {
      const artifacts = await plugin.listArtifacts('build-123');
      expect(Array.isArray(artifacts)).toBe(true);
    });
  });

  describe('trigger operations', () => {
    it('should list triggers', async () => {
      const triggers = await plugin.listTriggers();
      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.id).toBe('trigger-123');
    });

    it('should create a trigger', async () => {
      const result = await plugin.createTrigger({
        name: 'new-trigger',
        filename: 'cloudbuild.yaml',
      });
      expect(result.id).toBe('trigger-456');
    });

    it('should update a trigger', async () => {
      const result = await plugin.updateTrigger('trigger-123', {
        description: 'Updated',
      });
      expect(result.name).toBe('updated-trigger');
    });

    it('should delete a trigger', async () => {
      await expect(plugin.deleteTrigger('trigger-123')).resolves.not.toThrow();
    });
  });

  describe('interface compliance', () => {
    it('should implement all interface methods', () => {
      // Build operations
      expect(typeof plugin.triggerBuild).toBe('function');
      expect(typeof plugin.runBuild).toBe('function');
      expect(typeof plugin.getBuild).toBe('function');
      expect(typeof plugin.listBuilds).toBe('function');
      expect(typeof plugin.cancelBuild).toBe('function');
      expect(typeof plugin.retryBuild).toBe('function');

      // Log operations
      expect(typeof plugin.streamLogs).toBe('function');

      // Artifact operations
      expect(typeof plugin.listArtifacts).toBe('function');
      expect(typeof plugin.getArtifact).toBe('function');
      expect(typeof plugin.getArtifactStream).toBe('function');

      // Trigger operations
      expect(typeof plugin.listTriggers).toBe('function');
      expect(typeof plugin.createTrigger).toBe('function');
      expect(typeof plugin.updateTrigger).toBe('function');
      expect(typeof plugin.deleteTrigger).toBe('function');
    });
  });
});
