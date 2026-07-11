/**
 * #916 FR-004: `LabelSyncService.syncRepo` per-label loop that consumes the
 * shared `classifyLabelProvisioningError`.
 *
 * Races on individual `createLabel` calls no longer flip `success` to false —
 * only real classified errors do. A single 422 keeps the rest of the loop
 * running and surfaces the actual failure cause via `error` and via an
 * error-level log.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LabelSyncService } from '../label-sync-service.js';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeClient() {
  return {
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
    updateLabel: vi.fn().mockResolvedValue(undefined),
  };
}

describe('LabelSyncService per-label classification (#916 FR-004)', () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('all races: success=true, no error-level log, everything recorded as unchanged', async () => {
    const client = makeClient();
    client.createLabel.mockRejectedValue(new Error('label already exists'));

    const service = new LabelSyncService(mockLogger, () => client as never);
    const result = await service.syncRepo('org', 'repo');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.unchanged).toBe(WORKFLOW_LABELS.length);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalled(); // race branch logs at info
    // Every label recorded, all as unchanged.
    expect(result.results).toHaveLength(WORKFLOW_LABELS.length);
    expect(result.results.every((r) => r.action === 'unchanged')).toBe(true);
  });

  it('one 422 among many: success=false with actual cause, other labels still recorded', async () => {
    const client = makeClient();
    client.createLabel.mockImplementation(async (_owner: string, _repo: string, name: string) => {
      if (name === 'blocked:stuck-feedback-loop') {
        throw new Error(
          'HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)',
        );
      }
    });

    const service = new LabelSyncService(mockLogger, () => client as never);
    const result = await service.syncRepo('org', 'repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain('description is too long');
    // The other labels still processed.
    expect(result.created).toBe(WORKFLOW_LABELS.length - 1);
    // The failed label is not in results (loop continued past it without a push).
    // Verify the error-level log carried the classified cause + status code.
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const errorCall = mockLogger.error.mock.calls[0]![0] as string;
    expect(errorCall).toContain('blocked:stuck-feedback-loop');
    expect(errorCall).toContain('description is too long');
    expect(errorCall).toContain('HTTP 422');
  });
});
