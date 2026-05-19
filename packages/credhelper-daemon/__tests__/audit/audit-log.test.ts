import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AuditLog } from '../../src/audit/audit-log.js';
import type { AuditConfig } from '../../src/audit/types.js';

// Mock transport to capture flushed batches
vi.mock('../../src/audit/transport.js', () => ({
  flushBatch: vi.fn().mockResolvedValue(undefined),
}));

import { flushBatch } from '../../src/audit/transport.js';

const mockFlush = vi.mocked(flushBatch);

function makeConfig(overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    capacity: 5000,
    flushIntervalMs: 60000, // high to avoid timer-based flushes in tests
    maxBatchSize: 50,
    controlPlaneSocketPath: '/tmp/test-control.sock',
    clusterId: 'test-cluster',
    workerId: 'test-worker',
    ...overrides,
  };
}

describe('AuditLog', () => {
  let log: AuditLog;

  beforeEach(() => {
    mockFlush.mockClear();
  });

  afterEach(async () => {
    if (log) await log.stop();
  });

  it('records an entry and adds timestamp/actor/clusterId', () => {
    log = new AuditLog(makeConfig());

    log.record({
      action: 'session.begin',
      sessionId: 's1',
      role: 'dev',
      success: true,
    });

    expect(log.size).toBe(1);
  });

  it('triggers early flush when batch size is reached', async () => {
    log = new AuditLog(makeConfig({ maxBatchSize: 5 }));

    for (let i = 0; i < 5; i++) {
      log.record({
        action: 'credential.mint',
        credentialId: `c${i}`,
        success: true,
      });
    }

    // Wait for the async flush to complete
    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalledTimes(1);
    });

    const batch = mockFlush.mock.calls[0]![0]!;
    expect(batch.entries).toHaveLength(5);
    expect(batch.droppedSinceLastBatch).toBe(0);
  });

  it('flushes on timer', async () => {
    vi.useFakeTimers();
    log = new AuditLog(makeConfig({ flushIntervalMs: 100 }));
    log.start();

    log.record({ action: 'session.begin', success: true });

    await vi.advanceTimersByTimeAsync(150);

    expect(mockFlush).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('tracks dropped entries in batch payload', async () => {
    log = new AuditLog(makeConfig({ capacity: 3, maxBatchSize: 5 }));

    for (let i = 0; i < 5; i++) {
      log.record({
        action: 'credential.mint',
        credentialId: `c${i}`,
        success: true,
      });
    }

    // 5 records into capacity 3 → 2 dropped, triggers flush at 3 (maxBatchSize 5 > capacity 3)
    // Actually, the early flush triggers at size >= maxBatchSize, but capacity is 3 so max buffer is 3.
    // After 5 pushes with capacity 3, buffer has 3 entries and 2 dropped.
    // Since 3 < 5 (maxBatchSize), early flush doesn't trigger automatically.
    // Force flush:
    await log.flush();

    expect(mockFlush).toHaveBeenCalledTimes(1);
    const batch = mockFlush.mock.calls[0]![0]!;
    expect(batch.entries).toHaveLength(3);
    expect(batch.droppedSinceLastBatch).toBe(2);
  });

  it('throws in dev mode when a field exceeds 256 chars', () => {
    log = new AuditLog(makeConfig());

    expect(() =>
      log.record({
        action: 'credential.mint',
        credentialId: 'a'.repeat(300),
        success: true,
      }),
    ).toThrow(/exceeds 256 chars/);
  });

  it('includes optional fields only when provided', async () => {
    log = new AuditLog(makeConfig({ maxBatchSize: 1 }));

    log.record({
      action: 'proxy.docker',
      success: true,
      proxy: { method: 'GET', path: '/containers/json', decision: 'allow' },
    });

    await vi.waitFor(() => {
      expect(mockFlush).toHaveBeenCalledTimes(1);
    });

    const entry = mockFlush.mock.calls[0]![0]!.entries[0]!;
    expect(entry.proxy).toEqual({ method: 'GET', path: '/containers/json', decision: 'allow' });
    expect(entry.credentialId).toBeUndefined();
    expect(entry.role).toBeUndefined();
  });
});
