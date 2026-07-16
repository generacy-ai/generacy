import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MergeConflictMonitorService } from '../merge-conflict-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { QueueManager } from '../../types/monitor.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';
import type { Logger } from '../../worker/types.js';

/**
 * #953 — Per-service adaptive-polling assertions on MergeConflictMonitorService.
 * Mirror of pr-feedback-adaptive.test.ts (same divisor=2, same default=false),
 * different log string.
 */

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createQueueManager(): QueueManager {
  const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return new InMemoryQueueAdapter(noopLogger);
}

const clientFactory: GitHubClientFactory = vi.fn().mockReturnValue({}) as unknown as GitHubClientFactory;
const repos: RepositoryConfig[] = [{ owner: 'test-org', repo: 'test-repo' }];

function createConfig(overrides: Partial<PrMonitorConfig> = {}): PrMonitorConfig {
  return {
    enabled: true,
    pollIntervalMs: 60_000,
    webhookSecret: undefined,
    adaptivePolling: false, // #953: new default
    maxConcurrentPolls: 3,
    ...overrides,
  };
}

function updateAdaptive(svc: MergeConflictMonitorService): void {
  (svc as unknown as { updateAdaptivePolling: () => void }).updateAdaptivePolling();
}

describe('MergeConflictMonitorService adaptive polling (#953)', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createLogger();
  });

  it('default adaptivePolling=false → interval stays at 60s indefinitely, no log', () => {
    const svc = new MergeConflictMonitorService(
      logger,
      clientFactory,
      createQueueManager(),
      createConfig({ adaptivePolling: false }),
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    updateAdaptive(svc);
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('increasing merge-conflict poll frequency'),
    );
    expect(infoCalls).toHaveLength(0);
  });

  it('adaptivePolling=true opt-in → interval drops to basePoll/2 on cycle 1, one log line, divisor is 2', () => {
    const svc = new MergeConflictMonitorService(
      logger,
      clientFactory,
      createQueueManager(),
      createConfig({ adaptivePolling: true }),
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(30_000);
    expect(svc.getState().currentPollIntervalMs).not.toBe(20_000);
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('increasing merge-conflict poll frequency'),
    );
    expect(infoCalls).toHaveLength(1);
  });

  it('adaptivePolling=true opt-in → cycle 2+ is idempotent, no additional log', () => {
    const svc = new MergeConflictMonitorService(
      logger,
      clientFactory,
      createQueueManager(),
      createConfig({ adaptivePolling: true }),
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    updateAdaptive(svc);
    updateAdaptive(svc);
    updateAdaptive(svc);
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('increasing merge-conflict poll frequency'),
    );
    expect(infoCalls).toHaveLength(1);
  });
});
