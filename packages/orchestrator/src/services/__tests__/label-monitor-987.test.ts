import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelMonitorService } from '../label-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { PhaseTracker, QueueManager } from '../../types/monitor.js';
import type { MonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';

/**
 * #987 — `setWebhooksConfigured(true, opts?)` contract on LabelMonitorService.
 * See specs/987-summary-cluster-where-smee/contracts/setter-contract.md.
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

function updateAdaptive(svc: LabelMonitorService): void {
  (svc as unknown as { updateAdaptivePolling: () => void }).updateAdaptivePolling();
}

function makeSvc(webhooksConfigured = false, adaptivePolling = true): LabelMonitorService {
  return new LabelMonitorService(
    createLogger(),
    clientFactory,
    createStubPhaseTracker(),
    createQueueManager(),
    createConfig({ adaptivePolling }),
    repos,
    undefined,
    undefined,
    undefined,
    undefined,
    webhooksConfigured,
  );
}

describe('LabelMonitorService setWebhooksConfigured (#987)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('1. flip flips flag + realigns base/current when opts supplied', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 600_000 });
    const state = svc.getState();
    expect(state.webhooksConfigured).toBe(true);
    expect(state.basePollIntervalMs).toBe(600_000);
    expect(state.currentPollIntervalMs).toBe(600_000);
  });

  it('2. adaptivePolling option is untouched by the setter (staleness path still reachable)', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 60_000 });
    // Steady-state: no stale event, should stay at base.
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    expect(svc.getState().webhookHealthy).toBe(true);
    // Now simulate staleness by advancing state.lastWebhookEvent into the past
    // and verify staleness branch still triggers (proves adaptivePolling wasn't
    // silently disabled by the setter).
    svc.recordWebhookEvent();
    (svc as unknown as { state: { lastWebhookEvent: number } }).state.lastWebhookEvent =
      Date.now() - 60_000 * 3;
    updateAdaptive(svc);
    expect(svc.getState().webhookHealthy).toBe(false);
    // divisor=3, base=60_000 → 20_000
    expect(svc.getState().currentPollIntervalMs).toBe(20_000);
  });

  it('3. staleness still reachable post-flip: reason webhook-stale, to-fast, current=fast', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 60_000 });
    svc.recordWebhookEvent();
    (svc as unknown as { state: { lastWebhookEvent: number } }).state.lastWebhookEvent =
      Date.now() - 60_000 * 3;
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(20_000);
    expect(svc.getState().webhookHealthy).toBe(false);
  });

  it('4. recovery still reachable post-flip: reason webhook-recovered, to-base', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 60_000 });
    svc.recordWebhookEvent();
    (svc as unknown as { state: { lastWebhookEvent: number } }).state.lastWebhookEvent =
      Date.now() - 60_000 * 3;
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(20_000);
    // Fresh event → recovery to base
    svc.recordWebhookEvent();
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    expect(svc.getState().webhookHealthy).toBe(true);
  });

  it('5. idempotent double-flip: state after 2nd call === state after 1st call', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 100_000 });
    const first = { ...svc.getState() };
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 100_000 });
    const second = svc.getState();
    expect(second).toEqual(first);
  });

  it('6. type-level: false argument is rejected by TypeScript', () => {
    const svc = makeSvc(false, true);
    // @ts-expect-error setter accepts only literal `true`
    svc.setWebhooksConfigured(false);
    // Runtime behavior: we invoked with a `false` cast, but TS should have
    // already blocked it. The runtime setter treats any truthy call as flip.
    expect(svc.getState().webhooksConfigured).toBe(true);
  });
});
