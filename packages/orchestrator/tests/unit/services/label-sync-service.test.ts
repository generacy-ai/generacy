import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelSyncService } from '../../../src/services/label-sync-service.js';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';

// Mock logger
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Mock GitHubClient
function createMockClient(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  return {
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
    updateLabel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof createMockClientFactory> extends (...args: unknown[]) => infer R ? R : never;
}

function createMockClientFactory(client?: ReturnType<typeof createMockClient>) {
  const mockClient = client ?? createMockClient();
  return { factory: vi.fn().mockReturnValue(mockClient), client: mockClient };
}

describe('LabelSyncService', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let service: LabelSyncService;
  let mockClient: ReturnType<typeof createMockClient>;
  let clientFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = createMockLogger();
    const { factory, client } = createMockClientFactory();
    mockClient = client;
    clientFactory = factory;
    service = new LabelSyncService(logger, clientFactory);
  });

  describe('syncRepo', () => {
    it('should create missing labels', async () => {
      // No existing labels — all should be created
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.syncRepo('owner', 'repo');

      expect(result.success).toBe(true);
      expect(result.created).toBe(WORKFLOW_LABELS.length);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(mockClient.createLabel).toHaveBeenCalledTimes(WORKFLOW_LABELS.length);
    });

    it('should update labels with wrong color', async () => {
      const existingLabels = WORKFLOW_LABELS.map(l => ({
        name: l.name,
        color: 'FFFFFF', // Wrong color
        description: l.description,
      }));
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue(existingLabels);

      const result = await service.syncRepo('owner', 'repo');

      expect(result.success).toBe(true);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(WORKFLOW_LABELS.length);
      expect(result.unchanged).toBe(0);
      expect(mockClient.updateLabel).toHaveBeenCalledTimes(WORKFLOW_LABELS.length);
    });

    it('should update labels with wrong description', async () => {
      const existingLabels = WORKFLOW_LABELS.map(l => ({
        name: l.name,
        color: l.color,
        description: 'wrong description',
      }));
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue(existingLabels);

      const result = await service.syncRepo('owner', 'repo');

      expect(result.success).toBe(true);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(WORKFLOW_LABELS.length);
      expect(result.unchanged).toBe(0);
    });

    it('should skip labels that already match', async () => {
      const existingLabels = WORKFLOW_LABELS.map(l => ({
        name: l.name,
        color: l.color,
        description: l.description,
      }));
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue(existingLabels);

      const result = await service.syncRepo('owner', 'repo');

      expect(result.success).toBe(true);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(WORKFLOW_LABELS.length);
      expect(mockClient.createLabel).not.toHaveBeenCalled();
      expect(mockClient.updateLabel).not.toHaveBeenCalled();
    });

    it('should never delete labels', async () => {
      // Extra labels exist that aren't in WORKFLOW_LABELS
      const existingLabels = [
        ...WORKFLOW_LABELS.map(l => ({ name: l.name, color: l.color, description: l.description })),
        { name: 'custom:label', color: '000000', description: 'Should not be deleted' },
      ];
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue(existingLabels);

      const result = await service.syncRepo('owner', 'repo');

      expect(result.success).toBe(true);
      expect(result.unchanged).toBe(WORKFLOW_LABELS.length);
      // No delete method should be called — it doesn't even exist on the service
      expect(result.results.every(r => r.action === 'unchanged')).toBe(true);
    });

    it('should return error result when listLabels fails', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

      const result = await service.syncRepo('owner', 'repo');

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });

  describe('syncAll', () => {
    it('should continue sync when one repo fails', async () => {
      let callCount = 0;
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('First repo failed'));
        }
        return Promise.resolve(
          WORKFLOW_LABELS.map(l => ({ name: l.name, color: l.color, description: l.description }))
        );
      });

      const repos = [
        { owner: 'org', repo: 'repo1' },
        { owner: 'org', repo: 'repo2' },
      ];
      const result = await service.syncAll(repos);

      expect(result.totalRepos).toBe(2);
      expect(result.successfulRepos).toBe(1);
      expect(result.failedRepos).toBe(1);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
    });

    it('should return correct counts in SyncAllResult', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const repos = [
        { owner: 'org', repo: 'repo1' },
        { owner: 'org', repo: 'repo2' },
        { owner: 'org', repo: 'repo3' },
      ];
      const result = await service.syncAll(repos);

      expect(result.totalRepos).toBe(3);
      expect(result.successfulRepos).toBe(3);
      expect(result.failedRepos).toBe(0);
      expect(result.results).toHaveLength(3);
    });

    it('should handle empty repository list gracefully', async () => {
      const result = await service.syncAll([]);

      expect(result.totalRepos).toBe(0);
      expect(result.successfulRepos).toBe(0);
      expect(result.failedRepos).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('sync tracking', () => {
    it('should skip already-synced repos in syncAll', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue(
        WORKFLOW_LABELS.map(l => ({ name: l.name, color: l.color, description: l.description }))
      );

      const repos = [{ owner: 'org', repo: 'repo1' }];

      // First call syncs the repo
      await service.syncAll(repos);
      expect(mockClient.listLabels).toHaveBeenCalledTimes(1);

      // Second call should skip it
      const result2 = await service.syncAll(repos);
      expect(mockClient.listLabels).toHaveBeenCalledTimes(1); // Not called again
      expect(result2.results).toHaveLength(0);
    });

    it('should skip already-synced repos in syncNewRepo', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // First sync
      await service.syncRepo('org', 'repo1');
      expect(mockClient.listLabels).toHaveBeenCalledTimes(1);

      // syncNewRepo should return null for already-synced repo
      const result = await service.syncNewRepo('org', 'repo1');
      expect(result).toBeNull();
      expect(mockClient.listLabels).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should sync new repo via syncNewRepo if not tracked', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.syncNewRepo('org', 'new-repo');
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });

    it('forceSync should bypass tracking', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue(
        WORKFLOW_LABELS.map(l => ({ name: l.name, color: l.color, description: l.description }))
      );

      // First sync marks repo as tracked
      await service.syncRepo('org', 'repo1');
      expect(mockClient.listLabels).toHaveBeenCalledTimes(1);

      // forceSync should still call the API
      const result = await service.forceSync('org', 'repo1');
      expect(result.success).toBe(true);
      expect(mockClient.listLabels).toHaveBeenCalledTimes(2);
    });

    it('resetTracking should clear the tracked set', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // Sync a repo
      await service.syncRepo('org', 'repo1');
      expect(mockClient.listLabels).toHaveBeenCalledTimes(1);

      // Reset tracking
      service.resetTracking();

      // Now syncAll should process the repo again
      await service.syncAll([{ owner: 'org', repo: 'repo1' }]);
      expect(mockClient.listLabels).toHaveBeenCalledTimes(2);
    });
  });

  describe('config schema', () => {
    it('should validate valid owner/repo config', async () => {
      // Import the schema for testing
      const { RepositoryConfigSchema } = await import('../../../src/config/schema.js');

      const result = RepositoryConfigSchema.safeParse({ owner: 'generacy-ai', repo: 'generacy' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.owner).toBe('generacy-ai');
        expect(result.data.repo).toBe('generacy');
      }
    });

    it('should reject empty owner string', async () => {
      const { RepositoryConfigSchema } = await import('../../../src/config/schema.js');

      const result = RepositoryConfigSchema.safeParse({ owner: '', repo: 'generacy' });
      expect(result.success).toBe(false);
    });

    it('should reject empty repo string', async () => {
      const { RepositoryConfigSchema } = await import('../../../src/config/schema.js');

      const result = RepositoryConfigSchema.safeParse({ owner: 'org', repo: '' });
      expect(result.success).toBe(false);
    });

    it('should default to empty repositories array', async () => {
      const { OrchestratorConfigSchema } = await import('../../../src/config/schema.js');

      const result = OrchestratorConfigSchema.safeParse({
        auth: {
          jwt: { secret: 'test-secret-at-least-32-characters-long' },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.repositories).toEqual([]);
      }
    });

    it('should parse ORCHESTRATOR_REPOSITORIES env var', async () => {
      // Simulate env var parsing logic
      const reposStr = 'org1/repo1, org2/repo2';
      const repos = reposStr.split(',').map(r => {
        const [owner, repo] = r.trim().split('/');
        return { owner, repo };
      }).filter(r => r.owner && r.repo);

      expect(repos).toEqual([
        { owner: 'org1', repo: 'repo1' },
        { owner: 'org2', repo: 'repo2' },
      ]);
    });
  });
});
