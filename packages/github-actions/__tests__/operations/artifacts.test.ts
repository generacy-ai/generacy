import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listArtifacts,
  getArtifact,
  downloadArtifact,
  deleteArtifact,
  listRepoArtifacts,
} from '../../src/operations/artifacts.js';
import { GitHubClient } from '../../src/client.js';
import { ArtifactNotFoundError, RunNotFoundError } from '../../src/utils/errors.js';

vi.mock('../../src/client.js', () => ({
  GitHubClient: vi.fn(),
}));

describe('artifacts operations', () => {
  let mockClient: GitHubClient;

  const mockArtifact = {
    id: 1001,
    node_id: 'MDEwOkNoZWNrU3VpdGUx',
    name: 'build-output',
    size_in_bytes: 1024000,
    archive_download_url: 'https://api.github.com/repos/owner/repo/actions/artifacts/1001/zip',
    expired: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    expires_at: '2024-04-01T00:00:00Z',
    workflow_run: {
      id: 123,
      repository_id: 456,
      head_repository_id: 456,
      head_branch: 'main',
      head_sha: 'abc123',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      getOwner: vi.fn().mockReturnValue('test-owner'),
      getRepo: vi.fn().mockReturnValue('test-repo'),
      request: vi.fn(),
      requestRaw: vi.fn(),
    } as unknown as GitHubClient;
  });

  describe('listArtifacts', () => {
    it('should list artifacts for a workflow run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        artifacts: [mockArtifact],
      });

      const artifacts = await listArtifacts(mockClient, 123);

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.name).toBe('build-output');
      expect(artifacts[0]?.expired).toBe(false);
    });

    it('should throw RunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(listArtifacts(mockClient, 999)).rejects.toThrow(
        RunNotFoundError
      );
    });
  });

  describe('getArtifact', () => {
    it('should return a specific artifact', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockArtifact
      );

      const artifact = await getArtifact(mockClient, 1001);

      expect(artifact.id).toBe(1001);
      expect(artifact.name).toBe('build-output');
    });

    it('should throw ArtifactNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(getArtifact(mockClient, 9999)).rejects.toThrow(
        ArtifactNotFoundError
      );
    });
  });

  describe('downloadArtifact', () => {
    it('should download artifact as Buffer', async () => {
      const mockData = Buffer.from('artifact content');
      (mockClient.requestRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockData,
      });

      const buffer = await downloadArtifact(mockClient, 1001);

      expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    it('should handle ArrayBuffer response', async () => {
      const mockData = new ArrayBuffer(16);
      (mockClient.requestRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockData,
      });

      const buffer = await downloadArtifact(mockClient, 1001);

      expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    it('should throw ArtifactNotFoundError on Not Found', async () => {
      (mockClient.requestRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(downloadArtifact(mockClient, 9999)).rejects.toThrow(
        ArtifactNotFoundError
      );
    });
  });

  describe('deleteArtifact', () => {
    it('should delete an artifact', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

      await expect(deleteArtifact(mockClient, 1001)).resolves.not.toThrow();
    });

    it('should throw ArtifactNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(deleteArtifact(mockClient, 9999)).rejects.toThrow(
        ArtifactNotFoundError
      );
    });
  });

  describe('listRepoArtifacts', () => {
    it('should list all repository artifacts', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        artifacts: [mockArtifact],
      });

      const artifacts = await listRepoArtifacts(mockClient);

      expect(artifacts).toHaveLength(1);
    });

    it('should accept filter options', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        artifacts: [],
      });

      await listRepoArtifacts(mockClient, {
        per_page: 10,
        name: 'build-output',
      });

      expect(mockClient.request).toHaveBeenCalled();
    });
  });
});
