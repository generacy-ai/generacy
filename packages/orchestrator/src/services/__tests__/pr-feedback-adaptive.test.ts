import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrFeedbackMonitorService } from '../pr-feedback-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { QueueManager } from '../../types/monitor.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';
import type { Logger } from '../../worker/types.js';

/**
 * #953 — Per-service adaptive-polling assertions on PrFeedbackMonitorService.
 * Divisor is 2 (not 3), and adaptivePolling defaults to `false` on this service.
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

function updateAdaptive(svc: PrFeedbackMonitorService): void {
  (svc as unknown as { updateAdaptivePolling: () => void }).updateAdaptivePolling();
}

describe('PrFeedbackMonitorService adaptive polling (#953)', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createLogger();
  });

  it('default adaptivePolling=false → interval stays at 60s indefinitely, no log', () => {
    const svc = new PrFeedbackMonitorService(
      logger,
      clientFactory,
      createQueueManager(),
      createConfig({ adaptivePolling: false }),
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      false, // webhooksConfigured — hardcoded false in server.ts
    );
    updateAdaptive(svc);
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('increasing PR feedback poll frequency'),
    );
    expect(infoCalls).toHaveLength(0);
  });

  it('adaptivePolling=true opt-in → interval drops to basePoll/2 on cycle 1, one log line, divisor is 2 not 3', () => {
    const svc = new PrFeedbackMonitorService(
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
    // 60_000 / 2 = 30_000 (clamp does not bind vs. 10_000 min)
    expect(svc.getState().currentPollIntervalMs).toBe(30_000);
    // divisor was 2 — divisor 3 would give 20_000
    expect(svc.getState().currentPollIntervalMs).not.toBe(20_000);
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('increasing PR feedback poll frequency'),
    );
    expect(infoCalls).toHaveLength(1);
  });

  it('adaptivePolling=true opt-in → cycle 2+ is idempotent, no additional log', () => {
    const svc = new PrFeedbackMonitorService(
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
      ([, msg]) => typeof msg === 'string' && msg.includes('increasing PR feedback poll frequency'),
    );
    expect(infoCalls).toHaveLength(1);
  });
});
