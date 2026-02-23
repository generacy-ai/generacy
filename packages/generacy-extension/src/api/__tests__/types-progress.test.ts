/**
 * Tests for progress Zod schemas.
 * Validates StepProgressSchema, PhaseProgressSchema, JobProgressSchema,
 * and QueueItemProgressSummarySchema with valid and invalid inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  StepProgressSchema,
  PhaseProgressSchema,
  JobProgressSchema,
  QueueItemProgressSummarySchema,
  StepStatusSchema,
  PhaseStatusSchema,
} from '../types';

describe('StepStatusSchema', () => {
  it.each(['pending', 'running', 'completed', 'failed', 'skipped'])(
    'should accept valid status "%s"',
    (status) => {
      expect(StepStatusSchema.parse(status)).toBe(status);
    }
  );

  it('should reject invalid status values', () => {
    expect(() => StepStatusSchema.parse('unknown')).toThrow();
    expect(() => StepStatusSchema.parse('')).toThrow();
    expect(() => StepStatusSchema.parse(123)).toThrow();
  });
});

describe('PhaseStatusSchema', () => {
  it.each(['pending', 'running', 'completed', 'failed', 'skipped'])(
    'should accept valid status "%s"',
    (status) => {
      expect(PhaseStatusSchema.parse(status)).toBe(status);
    }
  );

  it('should reject invalid status values', () => {
    expect(() => PhaseStatusSchema.parse('cancelled')).toThrow();
    expect(() => PhaseStatusSchema.parse(null)).toThrow();
  });
});

describe('StepProgressSchema', () => {
  it('should accept a valid minimal step (id, name, status only)', () => {
    const data = {
      id: 'T001',
      name: 'Extract conversion function',
      status: 'pending',
    };

    const result = StepProgressSchema.parse(data);

    expect(result.id).toBe('T001');
    expect(result.name).toBe('Extract conversion function');
    expect(result.status).toBe('pending');
    expect(result.startedAt).toBeUndefined();
    expect(result.completedAt).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('should accept a valid full step (all optional fields present)', () => {
    const data = {
      id: 'T003',
      name: 'Clear baseline.rec',
      status: 'completed',
      startedAt: '2026-02-23T10:14:36Z',
      completedAt: '2026-02-23T10:16:36Z',
      durationMs: 120000,
      output: 'Created src/utils/convert.ts',
      error: undefined,
    };

    const result = StepProgressSchema.parse(data);

    expect(result.id).toBe('T003');
    expect(result.status).toBe('completed');
    expect(result.startedAt).toBe('2026-02-23T10:14:36Z');
    expect(result.completedAt).toBe('2026-02-23T10:16:36Z');
    expect(result.durationMs).toBe(120000);
    expect(result.output).toBe('Created src/utils/convert.ts');
  });

  it('should accept a failed step with error', () => {
    const data = {
      id: 'T005',
      name: 'Run tests',
      status: 'failed',
      startedAt: '2026-02-23T10:00:00Z',
      completedAt: '2026-02-23T10:01:00Z',
      durationMs: 60000,
      output: 'FAIL src/index.test.ts',
      error: 'Test suite failed: 3 failures',
    };

    const result = StepProgressSchema.parse(data);

    expect(result.error).toBe('Test suite failed: 3 failures');
    expect(result.output).toBe('FAIL src/index.test.ts');
  });

  it('should reject invalid status values', () => {
    const data = {
      id: 'T001',
      name: 'Step',
      status: 'invalid-status',
    };

    expect(() => StepProgressSchema.parse(data)).toThrow();
  });

  it('should reject negative durationMs', () => {
    const data = {
      id: 'T001',
      name: 'Step',
      status: 'completed',
      durationMs: -100,
    };

    expect(() => StepProgressSchema.parse(data)).toThrow();
  });

  it('should accept durationMs of 0', () => {
    const data = {
      id: 'T001',
      name: 'Step',
      status: 'completed',
      durationMs: 0,
    };

    const result = StepProgressSchema.parse(data);
    expect(result.durationMs).toBe(0);
  });

  it('should reject missing required fields', () => {
    expect(() => StepProgressSchema.parse({ id: 'T001', name: 'Step' })).toThrow();
    expect(() => StepProgressSchema.parse({ id: 'T001', status: 'pending' })).toThrow();
    expect(() => StepProgressSchema.parse({ name: 'Step', status: 'pending' })).toThrow();
  });

  it('should reject invalid datetime format for startedAt', () => {
    const data = {
      id: 'T001',
      name: 'Step',
      status: 'running',
      startedAt: 'not-a-date',
    };

    expect(() => StepProgressSchema.parse(data)).toThrow();
  });

  it('should reject invalid datetime format for completedAt', () => {
    const data = {
      id: 'T001',
      name: 'Step',
      status: 'completed',
      completedAt: '2026-13-45',
    };

    expect(() => StepProgressSchema.parse(data)).toThrow();
  });
});

describe('PhaseProgressSchema', () => {
  it('should accept a valid phase with empty steps array', () => {
    const data = {
      id: 'setup',
      name: 'Setup',
      status: 'completed',
      startedAt: '2026-02-23T10:00:00Z',
      completedAt: '2026-02-23T10:00:00Z',
      durationMs: 32,
      steps: [],
    };

    const result = PhaseProgressSchema.parse(data);

    expect(result.id).toBe('setup');
    expect(result.name).toBe('Setup');
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(0);
    expect(result.durationMs).toBe(32);
  });

  it('should accept a valid phase with populated steps', () => {
    const data = {
      id: 'implementation',
      name: 'Implementation',
      status: 'running',
      startedAt: '2026-02-23T10:09:36Z',
      steps: [
        {
          id: 'T001',
          name: 'Extract conversion function',
          status: 'completed',
          durationMs: 120000,
          output: 'Created src/utils/convert.ts',
        },
        {
          id: 'T002',
          name: 'Add options mapping',
          status: 'running',
          startedAt: '2026-02-23T10:11:36Z',
        },
        {
          id: 'T003',
          name: 'Clear baseline.rec',
          status: 'pending',
        },
      ],
    };

    const result = PhaseProgressSchema.parse(data);

    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].status).toBe('completed');
    expect(result.steps[1].status).toBe('running');
    expect(result.steps[2].status).toBe('pending');
  });

  it('should accept a phase with error', () => {
    const data = {
      id: 'implementation',
      name: 'Implementation',
      status: 'failed',
      error: 'Build failed: exit code 1',
      steps: [],
    };

    const result = PhaseProgressSchema.parse(data);
    expect(result.error).toBe('Build failed: exit code 1');
  });

  it('should accept a minimal phase (no optional fields)', () => {
    const data = {
      id: 'setup',
      name: 'Setup',
      status: 'pending',
      steps: [],
    };

    const result = PhaseProgressSchema.parse(data);

    expect(result.startedAt).toBeUndefined();
    expect(result.completedAt).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('should reject invalid nested step data', () => {
    const data = {
      id: 'implementation',
      name: 'Implementation',
      status: 'running',
      steps: [
        {
          id: 'T001',
          name: 'Step 1',
          status: 'banana', // invalid step status
        },
      ],
    };

    expect(() => PhaseProgressSchema.parse(data)).toThrow();
  });

  it('should reject phase with missing steps array', () => {
    const data = {
      id: 'setup',
      name: 'Setup',
      status: 'pending',
    };

    expect(() => PhaseProgressSchema.parse(data)).toThrow();
  });

  it('should reject negative durationMs in phase', () => {
    const data = {
      id: 'setup',
      name: 'Setup',
      status: 'completed',
      durationMs: -1,
      steps: [],
    };

    expect(() => PhaseProgressSchema.parse(data)).toThrow();
  });

  it('should reject step with negative durationMs within phase', () => {
    const data = {
      id: 'implementation',
      name: 'Implementation',
      status: 'completed',
      steps: [
        {
          id: 'T001',
          name: 'Step 1',
          status: 'completed',
          durationMs: -500,
        },
      ],
    };

    expect(() => PhaseProgressSchema.parse(data)).toThrow();
  });
});

describe('JobProgressSchema', () => {
  const validPhase = {
    id: 'setup',
    name: 'Setup',
    status: 'completed',
    durationMs: 32,
    steps: [],
  };

  it('should accept a valid complete progress object', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 4,
      totalPhases: 8,
      completedPhases: 4,
      skippedPhases: 0,
      phases: [
        {
          id: 'setup',
          name: 'Setup',
          status: 'completed',
          startedAt: '2026-02-23T10:00:00Z',
          completedAt: '2026-02-23T10:00:00Z',
          durationMs: 32,
          steps: [],
        },
        {
          id: 'implementation',
          name: 'Implementation',
          status: 'running',
          startedAt: '2026-02-23T10:09:36Z',
          steps: [
            {
              id: 'T001',
              name: 'Extract conversion function',
              status: 'completed',
              durationMs: 120000,
              output: 'Created src/utils/convert.ts',
            },
            {
              id: 'T003',
              name: 'Clear baseline.rec',
              status: 'running',
              startedAt: '2026-02-23T10:14:36Z',
            },
          ],
        },
      ],
      updatedAt: '2026-02-23T10:14:36Z',
    };

    const result = JobProgressSchema.parse(data);

    expect(result.jobId).toBe('abc-123');
    expect(result.currentPhaseIndex).toBe(4);
    expect(result.totalPhases).toBe(8);
    expect(result.completedPhases).toBe(4);
    expect(result.skippedPhases).toBe(0);
    expect(result.phases).toHaveLength(2);
    expect(result.pullRequestUrl).toBeUndefined();
    expect(result.updatedAt).toBe('2026-02-23T10:14:36Z');
  });

  it('should reject missing required field: jobId', () => {
    const data = {
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [validPhase],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject missing required field: phases', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject missing required field: updatedAt', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [validPhase],
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should accept optional pullRequestUrl with valid URL', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 1,
      skippedPhases: 0,
      phases: [validPhase],
      pullRequestUrl: 'https://github.com/org/repo/pull/42',
      updatedAt: '2026-02-23T10:00:00Z',
    };

    const result = JobProgressSchema.parse(data);
    expect(result.pullRequestUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('should reject invalid URL format for pullRequestUrl', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [validPhase],
      pullRequestUrl: 'not-a-url',
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject negative currentPhaseIndex', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: -1,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [validPhase],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject non-integer totalPhases', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 2.5,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [validPhase],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject negative completedPhases', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: -1,
      skippedPhases: 0,
      phases: [validPhase],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject negative skippedPhases', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: -2,
      phases: [validPhase],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should accept empty phases array', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 0,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    const result = JobProgressSchema.parse(data);
    expect(result.phases).toHaveLength(0);
  });

  it('should reject invalid updatedAt datetime format', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [validPhase],
      updatedAt: 'yesterday',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });

  it('should reject invalid nested phase data', () => {
    const data = {
      jobId: 'abc-123',
      currentPhaseIndex: 0,
      totalPhases: 1,
      completedPhases: 0,
      skippedPhases: 0,
      phases: [
        {
          id: 'setup',
          name: 'Setup',
          status: 'invalid',
          steps: [],
        },
      ],
      updatedAt: '2026-02-23T10:00:00Z',
    };

    expect(() => JobProgressSchema.parse(data)).toThrow();
  });
});

describe('QueueItemProgressSummarySchema', () => {
  it('should accept a valid summary with all fields present', () => {
    const data = {
      currentPhase: 'implementation',
      phaseProgress: 'Phase 5/8',
      totalPhases: 8,
      completedPhases: 4,
      skippedPhases: 0,
    };

    const result = QueueItemProgressSummarySchema.parse(data);

    expect(result.currentPhase).toBe('implementation');
    expect(result.phaseProgress).toBe('Phase 5/8');
    expect(result.totalPhases).toBe(8);
    expect(result.completedPhases).toBe(4);
    expect(result.skippedPhases).toBe(0);
  });

  it('should accept an empty object (all fields optional)', () => {
    const data = {};

    const result = QueueItemProgressSummarySchema.parse(data);

    expect(result.currentPhase).toBeUndefined();
    expect(result.phaseProgress).toBeUndefined();
    expect(result.totalPhases).toBeUndefined();
    expect(result.completedPhases).toBeUndefined();
    expect(result.skippedPhases).toBeUndefined();
  });

  it('should accept partial fields', () => {
    const data = {
      currentPhase: 'setup',
      totalPhases: 3,
    };

    const result = QueueItemProgressSummarySchema.parse(data);

    expect(result.currentPhase).toBe('setup');
    expect(result.totalPhases).toBe(3);
    expect(result.phaseProgress).toBeUndefined();
  });

  it('should reject invalid type for totalPhases (string instead of number)', () => {
    const data = {
      totalPhases: 'eight',
    };

    expect(() => QueueItemProgressSummarySchema.parse(data)).toThrow();
  });

  it('should reject non-integer totalPhases', () => {
    const data = {
      totalPhases: 3.5,
    };

    expect(() => QueueItemProgressSummarySchema.parse(data)).toThrow();
  });

  it('should reject negative completedPhases', () => {
    const data = {
      completedPhases: -1,
    };

    expect(() => QueueItemProgressSummarySchema.parse(data)).toThrow();
  });

  it('should reject negative skippedPhases', () => {
    const data = {
      skippedPhases: -2,
    };

    expect(() => QueueItemProgressSummarySchema.parse(data)).toThrow();
  });

  it('should reject invalid type for currentPhase (number instead of string)', () => {
    const data = {
      currentPhase: 123,
    };

    expect(() => QueueItemProgressSummarySchema.parse(data)).toThrow();
  });

  it('should accept zero values for numeric fields', () => {
    const data = {
      totalPhases: 0,
      completedPhases: 0,
      skippedPhases: 0,
    };

    const result = QueueItemProgressSummarySchema.parse(data);

    expect(result.totalPhases).toBe(0);
    expect(result.completedPhases).toBe(0);
    expect(result.skippedPhases).toBe(0);
  });
});
