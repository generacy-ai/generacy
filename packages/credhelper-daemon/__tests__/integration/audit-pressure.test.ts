import { describe, it, expect, vi } from 'vitest';

import { AuditLog } from '../../src/audit/audit-log.js';
import type { AuditConfig } from '../../src/audit/types.js';

// Mock transport — simulate control-plane offline (never resolves during test)
vi.mock('../../src/audit/transport.js', () => ({
  flushBatch: vi.fn().mockResolvedValue(undefined),
}));

import { flushBatch } from '../../src/audit/transport.js';
const mockFlush = vi.mocked(flushBatch);

describe('Audit pressure test', () => {
  it('handles 10000 rapid records with bounded memory', async () => {
    const capacity = 5000;
    const config: AuditConfig = {
      capacity,
      flushIntervalMs: 60000, // no timer-based flush
      maxBatchSize: capacity + 1, // larger than capacity so early flush never triggers
      controlPlaneSocketPath: '/tmp/nonexistent.sock',
      clusterId: 'pressure-test-cluster',
      workerId: 'pressure-test-worker',
    };

    const log = new AuditLog(config);
    const totalRecords = 10000;

    // Record 10000 entries rapidly — no early flush since maxBatchSize > capacity
    for (let i = 0; i < totalRecords; i++) {
      log.record({
        action: 'credential.mint',
        credentialId: `cred-${i}`,
        sessionId: `session-${i % 10}`,
        role: 'developer',
        pluginId: 'github-pat',
        success: true,
      });
    }

    // Buffer should be bounded by capacity
    expect(log.size).toBeLessThanOrEqual(capacity);
    expect(log.size).toBe(capacity);

    // Drain remaining
    await log.flush();

    expect(mockFlush).toHaveBeenCalledTimes(1);

    // Verify that dropped entries were reported
    const batch = mockFlush.mock.calls[0]![0]!;
    const totalDropped = batch.droppedSinceLastBatch;

    // With 10000 records into capacity 5000, we must have 5000 drops
    expect(totalDropped).toBe(totalRecords - capacity);

    // Flushed entries + dropped = total records
    expect(batch.entries.length + totalDropped).toBe(totalRecords);

    await log.stop();
  });

  it('operates correctly with control-plane offline', async () => {
    // Reset mock to simulate errors
    mockFlush.mockRejectedValue(new Error('connection refused'));

    const config: AuditConfig = {
      capacity: 100,
      flushIntervalMs: 60000,
      maxBatchSize: 10,
      controlPlaneSocketPath: '/tmp/nonexistent.sock',
      clusterId: 'offline-test',
      workerId: 'w1',
    };

    const log = new AuditLog(config);

    // Should not throw even when transport fails
    for (let i = 0; i < 50; i++) {
      log.record({
        action: 'credential.resolve',
        credentialId: `cred-${i}`,
        success: true,
      });
    }

    // Buffer should be bounded
    expect(log.size).toBeLessThanOrEqual(100);

    await log.stop();

    // Restore mock
    mockFlush.mockResolvedValue(undefined);
  });
});
