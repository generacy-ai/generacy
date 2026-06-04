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
  delete process.env['GENERACY_PRE_APPROVED_DEVICE_CODE'];
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

    it('forwards initialWorkers to pollForApproval (T016)', async () => {
      vi.mocked(readKeyFile).mockResolvedValue(null);
      vi.mocked(requestDeviceCode).mockResolvedValue({
        device_code: 'dc-2',
        user_code: 'EFGH-5678',
        verification_uri: 'https://generacy.ai/activate',
        interval: 5,
        expires_in: 300,
      });
      vi.mocked(pollForApproval).mockResolvedValue({
        status: 'approved',
        cluster_api_key: 'key-2',
        cluster_api_key_id: 'kid-2',
        cluster_id: 'cl-2',
        project_id: 'pj-2',
        org_id: 'org-2',
        cloud_url: 'https://api.generacy.ai',
      });
      vi.mocked(writeKeyFile).mockResolvedValue(undefined);
      vi.mocked(writeClusterJson).mockResolvedValue(undefined);

      await activate({ ...baseOptions, initialWorkers: 4 });

      expect(pollForApproval).toHaveBeenCalledWith(
        expect.objectContaining({ workers: 4 }),
      );
    });
  });

  describe('pre-approved device-code path', () => {
    it('happy path: skips requestDeviceCode and persists key from pollForApproval', async () => {
      process.env['GENERACY_PRE_APPROVED_DEVICE_CODE'] = 'pre-approved-dc-1';
      vi.mocked(readKeyFile).mockResolvedValue(null);
      vi.mocked(pollForApproval).mockResolvedValue({
        status: 'approved',
        cluster_api_key: 'pre-key-1',
        cluster_api_key_id: 'pre-kid-1',
        cluster_id: 'pre-cl-1',
        project_id: 'pre-pj-1',
        org_id: 'pre-org-1',
        cloud_url: 'https://api.generacy.ai',
      });
      vi.mocked(writeKeyFile).mockResolvedValue(undefined);
      vi.mocked(writeClusterJson).mockResolvedValue(undefined);

      const result = await activate(baseOptions);

      expect(requestDeviceCode).not.toHaveBeenCalled();
      expect(pollForApproval).toHaveBeenCalledWith(
        expect.objectContaining({ deviceCode: 'pre-approved-dc-1' }),
      );
      expect(writeKeyFile).toHaveBeenCalledWith(baseOptions.keyFilePath, 'pre-key-1');
      expect(writeClusterJson).toHaveBeenCalledWith(
        baseOptions.clusterJsonPath,
        expect.objectContaining({
          cluster_id: 'pre-cl-1',
          project_id: 'pre-pj-1',
          org_id: 'pre-org-1',
          cloud_url: 'https://api.generacy.ai',
        }),
      );
      expect(process.env['GENERACY_PRE_APPROVED_DEVICE_CODE']).toBeUndefined();
      expect(result).toEqual({
        apiKey: 'pre-key-1',
        clusterApiKeyId: 'pre-kid-1',
        clusterId: 'pre-cl-1',
        projectId: 'pre-pj-1',
        orgId: 'pre-org-1',
        cloudUrl: 'https://api.generacy.ai',
      });
      expect(mockLogger.info).toHaveBeenCalledWith({
        event: 'activation-start',
        mode: 'pre-approved',
      });
    });

    it('terminal failure falls back to interactive flow', async () => {
      process.env['GENERACY_PRE_APPROVED_DEVICE_CODE'] = 'pre-approved-expired';
      vi.mocked(readKeyFile).mockResolvedValue(null);
      // First call (pre-approved branch) returns expired; second call
      // (interactive branch) returns approved.
      vi.mocked(pollForApproval)
        .mockResolvedValueOnce({ status: 'expired' })
        .mockResolvedValueOnce({
          status: 'approved',
          cluster_api_key: 'fallback-key',
          cluster_api_key_id: 'fallback-kid',
          cluster_id: 'fallback-cl',
          project_id: 'fallback-pj',
          org_id: 'fallback-org',
          cloud_url: 'https://api.generacy.ai',
        });
      vi.mocked(requestDeviceCode).mockResolvedValue({
        device_code: 'interactive-dc',
        user_code: 'WXYZ-9999',
        verification_uri: 'https://generacy.ai/activate',
        interval: 5,
        expires_in: 300,
      });
      vi.mocked(writeKeyFile).mockResolvedValue(undefined);
      vi.mocked(writeClusterJson).mockResolvedValue(undefined);

      const result = await activate(baseOptions);

      expect(requestDeviceCode).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Pre-approved device code redemption failed'),
      );
      expect(mockLogger.info).toHaveBeenCalledWith({
        event: 'activation-start',
        mode: 'pre-approved',
      });
      expect(mockLogger.info).toHaveBeenCalledWith({
        event: 'activation-start',
        mode: 'interactive',
      });
      expect(result.apiKey).toBe('fallback-key');
    });

    it('transient retries happen inside pollForApproval (single call)', async () => {
      process.env['GENERACY_PRE_APPROVED_DEVICE_CODE'] = 'pre-approved-transient';
      vi.mocked(readKeyFile).mockResolvedValue(null);
      // pollForApproval mock already abstracts away authorization_pending /
      // slow_down — we just assert the outer code calls it exactly once and
      // does not double-trigger requestDeviceCode.
      vi.mocked(pollForApproval).mockResolvedValue({
        status: 'approved',
        cluster_api_key: 'transient-key',
        cluster_api_key_id: 'transient-kid',
        cluster_id: 'transient-cl',
        project_id: 'transient-pj',
        org_id: 'transient-org',
        cloud_url: 'https://api.generacy.ai',
      });
      vi.mocked(writeKeyFile).mockResolvedValue(undefined);
      vi.mocked(writeClusterJson).mockResolvedValue(undefined);

      await activate(baseOptions);

      expect(pollForApproval).toHaveBeenCalledTimes(1);
      expect(requestDeviceCode).not.toHaveBeenCalled();
    });

    it('no pre-approved env var → unchanged interactive path with structured log', async () => {
      // env var deliberately unset (cleared in beforeEach)
      vi.mocked(readKeyFile).mockResolvedValue(null);
      vi.mocked(requestDeviceCode).mockResolvedValue({
        device_code: 'dc-baseline',
        user_code: 'WXYZ-0000',
        verification_uri: 'https://generacy.ai/activate',
        interval: 5,
        expires_in: 300,
      });
      vi.mocked(pollForApproval).mockResolvedValue({
        status: 'approved',
        cluster_api_key: 'baseline-key',
        cluster_api_key_id: 'baseline-kid',
        cluster_id: 'baseline-cl',
        project_id: 'baseline-pj',
        org_id: 'baseline-org',
        cloud_url: 'https://api.generacy.ai',
      });
      vi.mocked(writeKeyFile).mockResolvedValue(undefined);
      vi.mocked(writeClusterJson).mockResolvedValue(undefined);

      await activate(baseOptions);

      expect(mockLogger.info).toHaveBeenCalledWith({
        event: 'activation-start',
        mode: 'interactive',
      });
      expect(mockLogger.info).not.toHaveBeenCalledWith({
        event: 'activation-start',
        mode: 'pre-approved',
      });
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
