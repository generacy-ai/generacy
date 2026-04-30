import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@generacy-ai/activation-client', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/activation-client')>(
    '@generacy-ai/activation-client',
  );
  return {
    ...actual,
    initDeviceFlow: vi.fn(),
    pollForApproval: vi.fn(),
    NativeHttpClient: vi.fn(),
  };
});

vi.mock('../../../src/cli/utils/browser.js', () => ({
  openUrl: vi.fn(),
}));

import { initDeviceFlow, pollForApproval } from '@generacy-ai/activation-client';
import { ActivationError } from '@generacy-ai/activation-client';
import { openUrl } from '../../../src/cli/utils/browser.js';
import { runActivation } from '../../../src/cli/commands/deploy/activation.js';
import { DeployError } from '../../../src/cli/commands/deploy/types.js';

const mockInitDeviceFlow = vi.mocked(initDeviceFlow);
const mockPollForApproval = vi.mocked(pollForApproval);
const mockOpenUrl = vi.mocked(openUrl);

const mockLogger = { info: vi.fn(), warn: vi.fn() };

const CLOUD_URL = 'https://api.generacy.ai';

const deviceCodeResponse = {
  device_code: 'dev-code-123',
  user_code: 'ABCD-1234',
  verification_uri: 'https://generacy.ai/activate',
  interval: 5,
  expires_in: 600,
};

const approvedPollResponse = {
  status: 'approved' as const,
  cluster_api_key: 'key-abc',
  cluster_api_key_id: 'key-id-abc',
  cluster_id: 'cluster-1',
  project_id: 'project-1',
  org_id: 'org-1',
};

describe('runActivation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns ActivationResult with correct field mapping on approval', async () => {
    mockInitDeviceFlow.mockResolvedValue(deviceCodeResponse);
    mockPollForApproval.mockResolvedValue(approvedPollResponse);

    const result = await runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger });

    expect(result).toEqual({
      apiKey: 'key-abc',
      clusterApiKeyId: 'key-id-abc',
      clusterId: 'cluster-1',
      projectId: 'project-1',
      orgId: 'org-1',
    });

    expect(mockInitDeviceFlow).toHaveBeenCalledOnce();
    expect(mockPollForApproval).toHaveBeenCalledOnce();
    expect(mockPollForApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudUrl: CLOUD_URL,
        deviceCode: 'dev-code-123',
        interval: 5,
        expiresIn: 600,
      }),
    );
  });

  it('calls openUrl with the verification_uri', async () => {
    mockInitDeviceFlow.mockResolvedValue(deviceCodeResponse);
    mockPollForApproval.mockResolvedValue(approvedPollResponse);

    await runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger });

    expect(mockOpenUrl).toHaveBeenCalledOnce();
    expect(mockOpenUrl).toHaveBeenCalledWith('https://generacy.ai/activate');
  });

  it('retries up to maxCycles when device code expires', async () => {
    mockInitDeviceFlow.mockResolvedValue(deviceCodeResponse);

    const expiredResponse = { status: 'expired' as const };
    mockPollForApproval
      .mockResolvedValueOnce(expiredResponse)
      .mockResolvedValueOnce(expiredResponse)
      .mockResolvedValueOnce(approvedPollResponse);

    const result = await runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger, maxCycles: 3 });

    expect(result).toEqual({
      apiKey: 'key-abc',
      clusterApiKeyId: 'key-id-abc',
      clusterId: 'cluster-1',
      projectId: 'project-1',
      orgId: 'org-1',
    });

    expect(mockInitDeviceFlow).toHaveBeenCalledTimes(3);
    expect(mockPollForApproval).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('throws DeployError with ACTIVATION_FAILED after all cycles expire', async () => {
    mockInitDeviceFlow.mockResolvedValue(deviceCodeResponse);
    mockPollForApproval.mockResolvedValue({ status: 'expired' as const });

    await expect(
      runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger, maxCycles: 2 }),
    ).rejects.toThrow(DeployError);

    try {
      await runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger, maxCycles: 2 });
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).code).toBe('ACTIVATION_FAILED');
    }
  });

  it('wraps ActivationError in DeployError with ACTIVATION_FAILED code', async () => {
    mockInitDeviceFlow.mockRejectedValue(
      new ActivationError('Cloud unreachable', 'CLOUD_UNREACHABLE'),
    );

    try {
      await runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger });
      expect.fail('Expected runActivation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect(err).not.toBeInstanceOf(ActivationError);
      expect((err as DeployError).code).toBe('ACTIVATION_FAILED');
      expect((err as DeployError).message).toContain('Cloud unreachable');
      expect((err as DeployError).cause).toBeInstanceOf(ActivationError);
    }
  });

  it('wraps generic errors in DeployError with ACTIVATION_FAILED code', async () => {
    mockInitDeviceFlow.mockRejectedValue(new Error('network timeout'));

    try {
      await runActivation({ cloudUrl: CLOUD_URL, logger: mockLogger });
      expect.fail('Expected runActivation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect((err as DeployError).code).toBe('ACTIVATION_FAILED');
      expect((err as DeployError).message).toContain('network timeout');
      expect((err as DeployError).cause).toBeInstanceOf(Error);
    }
  });
});
