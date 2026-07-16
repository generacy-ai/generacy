import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelMonitorService } from '../label-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { PhaseTracker, QueueManager } from '../../types/monitor.js';
import type { MonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';

/**
 * #953 — Per-service adaptive-polling assertions on LabelMonitorService.
 *
 * The service's `updateAdaptivePolling` is private, but its side effects on
 * `state.currentPollIntervalMs` are visible via `getState()`. We reach into
 * the private method via a cast — this mirrors how existing tests exercise
 * private phase-loop internals in this repo.
 */

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createStubPhaseTracker(): PhaseTracker {
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
    isDuplicateRaw: vi.fn().mockResolvedValue(false),
    markProcessedRaw: vi.fn().mockResolvedValue(undefined),
  };
}

function createQueueManager(): QueueManager {
  const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return new InMemoryQueueAdapter(noopLogger);
}

const clientFactory: GitHubClientFactory = vi.fn().mockReturnValue({}) as unknown as GitHubClientFactory;
const repos: RepositoryConfig[] = [{ owner: 'test-org', repo: 'test-repo' }];

/**
 * Use a base of 60_000 (not the default 30_000) so `basePoll / 3 = 20_000`
 * exceeds `MIN_POLL_INTERVAL_MS = 10_000` — the clamp does not bind and the
 * divide computation is verifiable.
 */
function createConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    pollIntervalMs: 60_000,
    webhookSecret: undefined,
    maxConcurrentPolls: 5,
    adaptivePolling: true,
    clusterGithubUsername: undefined,
    ...overrides,
  };
}

// Accessor for the private updateAdaptivePolling method.
function updateAdaptive(svc: LabelMonitorService): void {
  (svc as unknown as { updateAdaptivePolling: () => void }).updateAdaptivePolling();
}

describe('LabelMonitorService adaptive polling (#953)', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });

  it('webhooksConfigured=false, adaptivePolling=true → cycle 1 drops to basePoll/3, emits one log line', () => {
    const svc = new LabelMonitorService(
      logger,
      clientFactory,
      createStubPhaseTracker(),
      createQueueManager(),
      createConfig({ adaptivePolling: true }),
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      false, // webhooksConfigured
    );
    updateAdaptive(svc);
    const state = svc.getState();
    expect(state.currentPollIntervalMs).toBe(20_000); // 60_000 / 3
    expect(state.webhookHealthy).toBe(false);
    const infoCalls = logger.info.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('Webhooks appear unhealthy'));
    expect(infoCalls).toHaveLength(1);
  });

  it('webhooksConfigured=false, adaptivePolling=true → cycle 2 is idempotent (no additional log)', () => {
    const svc = new LabelMonitorService(
      logger,
      clientFactory,
      createStubPhaseTracker(),
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
    const infoCalls = logger.info.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('Webhooks appear unhealthy'));
    expect(infoCalls).toHaveLength(1);
    expect(svc.getState().currentPollIntervalMs).toBe(20_000);
  });

  it('webhooksConfigured=false, adaptivePolling=false → interval stays at base indefinitely, no log', () => {
    const svc = new LabelMonitorService(
      logger,
      clientFactory,
      createStubPhaseTracker(),
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
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    const infoCalls = logger.info.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('Webhooks appear unhealthy'));
    expect(infoCalls).toHaveLength(0);
  });

  it('webhooksConfigured=true, lastWebhookEvent=null → no-op grace (interval stays at base)', () => {
    const svc = new LabelMonitorService(
      logger,
      clientFactory,
      createStubPhaseTracker(),
      createQueueManager(),
      createConfig({ adaptivePolling: true }),
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // webhooksConfigured
    );
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    expect(svc.getState().webhookHealthy).toBe(true);
    const infoCalls = logger.info.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('Webhooks appear unhealthy'));
    expect(infoCalls).toHaveLength(0);
  });
});
