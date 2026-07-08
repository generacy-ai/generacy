import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GhAuthError } from '@generacy-ai/workflow-engine';
import { LabelMonitorService, type AuthHealthSink } from '../../../src/services/label-monitor-service.js';
import type { QueueManager, PhaseTracker } from '../../../src/types/index.js';
import type { MonitorConfig, RepositoryConfig } from '../../../src/config/schema.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockPhaseTracker(): PhaseTracker {
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
  };
}

const config: MonitorConfig = {
  pollIntervalMs: 30000,
  adaptivePolling: false,
  maxConcurrentPolls: 1,
};

const repos: RepositoryConfig[] = [{ owner: 'o', repo: 'r' }];

describe('LabelMonitorService — 401 classification', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let phaseTracker: PhaseTracker;
  let queueAdapter: QueueManager;
  let authHealth: AuthHealthSink & { recordResult: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logger = createMockLogger();
    phaseTracker = createMockPhaseTracker();
    queueAdapter = {
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
    authHealth = { recordResult: vi.fn() };
  });

  it('catches GhAuthError, emits a single structured warn log, and calls health sink', async () => {
    const ghAuthError = new GhAuthError(401, 'HTTP 401: Bad credentials');
    const mockClient = {
      listIssuesWithLabel: vi.fn().mockRejectedValue(ghAuthError),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new LabelMonitorService(
      logger,
      clientFactory,
      phaseTracker,
      queueAdapter,
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

    // generic error log should NOT fire on 401 path
    const genericErrCalls = logger.error.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('Error polling repository'),
    );
    expect(genericErrCalls).toHaveLength(0);
  });

  it('records ok=true on successful poll cycle', async () => {
    const mockClient = {
      listIssuesWithLabel: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new LabelMonitorService(
      logger,
      clientFactory,
      phaseTracker,
      queueAdapter,
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

  it('does not call health sink when no githubAppCredentialId is configured', async () => {
    const ghAuthError = new GhAuthError(401, 'HTTP 401: Bad credentials');
    const mockClient = {
      listIssuesWithLabel: vi.fn().mockRejectedValue(ghAuthError),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new LabelMonitorService(
      logger,
      clientFactory,
      phaseTracker,
      queueAdapter,
      config,
      repos,
      undefined,
      undefined,
      authHealth,
      undefined,
    );

    await service.poll();
    expect(authHealth.recordResult).not.toHaveBeenCalled();
    // structured warn still emitted (no credentialId)
    const warnCalls = logger.warn.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('GitHub authentication failing'),
    );
    expect(warnCalls).toHaveLength(1);
  });

  it('still logs generic "Error polling repository" for non-401 errors', async () => {
    const mockClient = {
      listIssuesWithLabel: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
    const clientFactory = vi.fn().mockReturnValue(mockClient);

    const service = new LabelMonitorService(
      logger,
      clientFactory,
      phaseTracker,
      queueAdapter,
      config,
      repos,
      undefined,
      undefined,
      authHealth,
      'primary-github-app',
    );

    await service.poll();
    expect(authHealth.recordResult).not.toHaveBeenCalled();
    const genericErrCalls = logger.error.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('Error polling repository'),
    );
    expect(genericErrCalls).toHaveLength(1);
  });
});
