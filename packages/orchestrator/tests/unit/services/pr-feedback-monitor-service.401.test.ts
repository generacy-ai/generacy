import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GhAuthError } from '@generacy-ai/workflow-engine';
import { PrFeedbackMonitorService } from '../../../src/services/pr-feedback-monitor-service.js';
import type { AuthHealthSink } from '../../../src/services/label-monitor-service.js';
import type { QueueManager } from '../../../src/types/index.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../../src/config/schema.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockQueueManager(): QueueManager {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueIfAbsent: vi.fn().mockResolvedValue(true),
    hasInFlight: vi.fn().mockResolvedValue(false),
    claim: vi.fn().mockResolvedValue(null),
    release: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    getQueueItems: vi.fn().mockResolvedValue([]),
    getActiveWorkerCount: vi.fn().mockResolvedValue(0),
  };
}

const config: PrMonitorConfig = {
  enabled: true,
  pollIntervalMs: 60000,
  adaptivePolling: false,
  maxConcurrentPolls: 1,
  webhookSecret: 'test',
};

const repos: RepositoryConfig[] = [{ owner: 'o', repo: 'r' }];

describe('PrFeedbackMonitorService — 401 classification', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queueManager: QueueManager;
  let authHealth: AuthHealthSink & { recordResult: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logger = createMockLogger();
    queueManager = createMockQueueManager();
    authHealth = { recordResult: vi.fn() };
  });

  it('catches GhAuthError from listOpenPullRequests, emits structured warn, and notifies health', async () => {
    const ghAuthError = new GhAuthError(401, 'HTTP 401: Bad credentials');
    const mockClient = {
      listOpenPullRequests: vi.fn().mockRejectedValue(ghAuthError),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new PrFeedbackMonitorService(
      logger as unknown as Parameters<typeof PrFeedbackMonitorService.prototype.constructor>[0],
      clientFactory,
      queueManager,
      config,
      repos,
      undefined,
      undefined,
      authHealth,
      'primary-github-app',
    );

    await service.poll();

    expect(authHealth.recordResult).toHaveBeenCalledTimes(1);
    expect(authHealth.recordResult).toHaveBeenCalledWith('primary-github-app', {
      ok: false,
      statusCode: 401,
    });

    const warnCalls = logger.warn.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('GitHub authentication failing'),
    );
    expect(warnCalls).toHaveLength(1);
    const [meta] = warnCalls[0]!;
    expect(meta).toMatchObject({ statusCode: 401, credentialId: 'primary-github-app' });

    const genericErrCalls = logger.error.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' && call[1].includes('Error polling repository for open PRs'),
    );
    expect(genericErrCalls).toHaveLength(0);
  });

  it('records ok=true on successful list', async () => {
    const mockClient = {
      listOpenPullRequests: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new PrFeedbackMonitorService(
      logger as unknown as Parameters<typeof PrFeedbackMonitorService.prototype.constructor>[0],
      clientFactory,
      queueManager,
      config,
      repos,
      undefined,
      undefined,
      authHealth,
      'primary-github-app',
    );

    await service.poll();
    const okCalls = authHealth.recordResult.mock.calls.filter(
      (call) => (call[1] as { ok: boolean }).ok === true,
    );
    expect(okCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('still treats rate-limit errors as a separate path', async () => {
    const mockClient = {
      listOpenPullRequests: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new PrFeedbackMonitorService(
      logger as unknown as Parameters<typeof PrFeedbackMonitorService.prototype.constructor>[0],
      clientFactory,
      queueManager,
      config,
      repos,
      undefined,
      undefined,
      authHealth,
      'primary-github-app',
    );

    await service.poll();
    expect(authHealth.recordResult).not.toHaveBeenCalled();
    const rateLimitCalls = logger.warn.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('rate limit'),
    );
    expect(rateLimitCalls).toHaveLength(1);
  });
});
