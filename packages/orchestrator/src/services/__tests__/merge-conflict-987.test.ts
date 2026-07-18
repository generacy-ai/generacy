import { describe, it, expect, vi } from 'vitest';
import { MergeConflictMonitorService } from '../merge-conflict-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { QueueManager } from '../../types/monitor.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';
import type { Logger } from '../../worker/types.js';

/**
 * #987 — `setWebhooksConfigured(true, opts?)` contract on MergeConflictMonitorService.
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
    adaptivePolling: true,
    maxConcurrentPolls: 3,
    ...overrides,
  };
}

function updateAdaptive(svc: MergeConflictMonitorService): void {
  (svc as unknown as { updateAdaptivePolling: () => void }).updateAdaptivePolling();
}

function makeSvc(webhooksConfigured = false, adaptivePolling = true): MergeConflictMonitorService {
  return new MergeConflictMonitorService(
    createLogger(),
    clientFactory,
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

describe('MergeConflictMonitorService setWebhooksConfigured (#987)', () => {
  it('1. flip flips flag + realigns base/current when opts supplied', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 600_000 });
    const state = svc.getState();
    expect(state.webhooksConfigured).toBe(true);
    expect(state.basePollIntervalMs).toBe(600_000);
    expect(state.currentPollIntervalMs).toBe(600_000);
  });

  it('2. adaptivePolling option is untouched by the setter', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 60_000 });
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    svc.recordWebhookEvent();
    (svc as unknown as { state: { lastWebhookEvent: number } }).state.lastWebhookEvent =
      Date.now() - 60_000 * 3;
    updateAdaptive(svc);
    expect(svc.getState().webhookHealthy).toBe(false);
    expect(svc.getState().currentPollIntervalMs).toBe(30_000);
  });

  it('3. staleness still reachable post-flip', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 60_000 });
    svc.recordWebhookEvent();
    (svc as unknown as { state: { lastWebhookEvent: number } }).state.lastWebhookEvent =
      Date.now() - 60_000 * 3;
    updateAdaptive(svc);
    expect(svc.getState().currentPollIntervalMs).toBe(30_000);
    expect(svc.getState().webhookHealthy).toBe(false);
  });

  it('4. recovery still reachable post-flip', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 60_000 });
    svc.recordWebhookEvent();
    (svc as unknown as { state: { lastWebhookEvent: number } }).state.lastWebhookEvent =
      Date.now() - 60_000 * 3;
    updateAdaptive(svc);
    svc.recordWebhookEvent();
    expect(svc.getState().currentPollIntervalMs).toBe(60_000);
    expect(svc.getState().webhookHealthy).toBe(true);
  });

  it('5. idempotent double-flip', () => {
    const svc = makeSvc(false, true);
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 100_000 });
    const first = { ...svc.getState() };
    svc.setWebhooksConfigured(true, { basePollIntervalMs: 100_000 });
    expect(svc.getState()).toEqual(first);
  });

  it('6. type-level: false argument is rejected by TypeScript', () => {
    const svc = makeSvc(false, true);
    // @ts-expect-error setter accepts only literal `true`
    svc.setWebhooksConfigured(false);
    expect(svc.getState().webhooksConfigured).toBe(true);
  });
});
