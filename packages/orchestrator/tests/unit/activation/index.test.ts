import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate } from '../../../src/activation/index.js';
import type { ClusterJson } from '../../../src/activation/types.js';

// Mock persistence
vi.mock('../../../src/activation/persistence.js', () => ({
  readKeyFile: vi.fn(),
  writeKeyFile: vi.fn(),
  readClusterJson: vi.fn(),
  writeClusterJson: vi.fn(),
}));

// Mock client
vi.mock('../../../src/activation/client.js', () => ({
  NativeHttpClient: vi.fn(),
  requestDeviceCode: vi.fn(),
}));

// Mock poller
vi.mock('../../../src/activation/poller.js', () => ({
  pollForApproval: vi.fn(),
}));

import { readKeyFile, writeKeyFile, readClusterJson, writeClusterJson } from '../../../src/activation/persistence.js';
import { requestDeviceCode } from '../../../src/activation/client.js';
import { pollForApproval } from '../../../src/activation/poller.js';

const mockLogger = { info: vi.fn(), warn: vi.fn() } as unknown as import('pino').Logger;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activate', () => {
  const baseOptions = {
    cloudUrl: 'https://api.generacy.ai',
    keyFilePath: '/var/lib/generacy/cluster-api-key',
    clusterJsonPath: '/var/lib/generacy/cluster.json',
    logger: mockLogger,
  };

  describe('device-flow path', () => {
    it('returns cloudUrl from poll result (T006)', async () => {
      vi.mocked(readKeyFile).mockResolvedValue(null);
      vi.mocked(requestDeviceCode).mockResolvedValue({
        device_code: 'dc-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://generacy.ai/activate',
        interval: 5,
        expires_in: 300,
      });
      vi.mocked(pollForApproval).mockResolvedValue({
        status: 'approved',
        cluster_api_key: 'key-1',
        cluster_api_key_id: 'kid-1',
        cluster_id: 'cl-1',
        project_id: 'pj-1',
        org_id: 'org-1',
        cloud_url: 'https://custom.generacy.example.com',
      });
      vi.mocked(writeKeyFile).mockResolvedValue(undefined);
      vi.mocked(writeClusterJson).mockResolvedValue(undefined);

      const result = await activate(baseOptions);

      expect(result.cloudUrl).toBe('https://custom.generacy.example.com');
      expect(result.apiKey).toBe('key-1');
      expect(result.clusterApiKeyId).toBe('kid-1');
      expect(result.clusterId).toBe('cl-1');

      // Verify cloud_url is persisted from poll result, not from input config
      expect(writeClusterJson).toHaveBeenCalledWith(
        baseOptions.clusterJsonPath,
        expect.objectContaining({
          cloud_url: 'https://custom.generacy.example.com',
        }),
      );
    });
  });

  describe('existing-key path', () => {
    it('returns cloudUrl from cluster.json metadata (T007)', async () => {
      vi.mocked(readKeyFile).mockResolvedValue('existing-key-abc');
      vi.mocked(readClusterJson).mockResolvedValue({
        cluster_id: 'cl-existing',
        project_id: 'pj-existing',
        org_id: 'org-existing',
        cloud_url: 'https://self-hosted.example.com',
        activated_at: '2026-04-30T12:00:00.000Z',
      } satisfies ClusterJson);

      const result = await activate(baseOptions);

      expect(result.cloudUrl).toBe('https://self-hosted.example.com');
      expect(result.apiKey).toBe('existing-key-abc');
      expect(result.clusterId).toBe('cl-existing');
    });

    it('returns undefined cloudUrl when cluster.json is missing', async () => {
      vi.mocked(readKeyFile).mockResolvedValue('existing-key-abc');
      vi.mocked(readClusterJson).mockResolvedValue(null);

      const result = await activate(baseOptions);

      expect(result.cloudUrl).toBeUndefined();
      expect(result.clusterId).toBe('unknown');
    });
  });
});
