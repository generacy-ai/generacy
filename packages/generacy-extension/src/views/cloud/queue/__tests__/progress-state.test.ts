/**
 * Tests for JobProgressState class.
 * Tests snapshot replacement, incremental merge (phase/step events),
 * expanded phases tracking, and snapshot-after-incremental correctness.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  JobProgress,
  PhaseProgress,
  StepProgress,
  WorkflowPhaseEventData,
  WorkflowStepEventData,
} from '../../../../api/types';
import { JobProgressState } from '../progress-state';

/** Create a minimal step for testing */
function createStep(overrides: Partial<StepProgress> = {}): StepProgress {
  return {
    id: 'step-1',
    name: 'Step 1',
    status: 'pending',
    ...overrides,
  };
}

/** Create a minimal phase for testing */
function createPhase(overrides: Partial<PhaseProgress> = {}): PhaseProgress {
  return {
    id: 'phase-1',
    name: 'Phase 1',
    status: 'pending',
    steps: [],
    ...overrides,
  };
}

/** Create a minimal job progress snapshot for testing */
function createProgress(overrides: Partial<JobProgress> = {}): JobProgress {
  return {
    jobId: 'job-1',
    currentPhaseIndex: 0,
    totalPhases: 3,
    completedPhases: 0,
    skippedPhases: 0,
    phases: [
      createPhase({ id: 'setup', name: 'Setup', status: 'completed' }),
      createPhase({
        id: 'implementation',
        name: 'Implementation',
        status: 'running',
        steps: [
          createStep({ id: 'impl-step-1', name: 'Generate code', status: 'completed', durationMs: 1200 }),
          createStep({ id: 'impl-step-2', name: 'Run tests', status: 'running' }),
          createStep({ id: 'impl-step-3', name: 'Validate', status: 'pending' }),
        ],
      }),
      createPhase({ id: 'cleanup', name: 'Cleanup', status: 'pending' }),
    ],
    updatedAt: '2024-01-15T10:00:00Z',
    ...overrides,
  };
}

describe('JobProgressState', () => {
  let state: JobProgressState;

  beforeEach(() => {
    state = new JobProgressState();
  });

  describe('initial state', () => {
    it('should return null progress before any snapshot', () => {
      expect(state.getProgress()).toBeNull();
    });

    it('should return empty expanded phases set before any snapshot', () => {
      expect(state.getExpandedPhases().size).toBe(0);
    });
  });

  describe('applySnapshot', () => {
    it('should store full progress state correctly', () => {
      const progress = createProgress();

      state.applySnapshot(progress);

      const result = state.getProgress();
      expect(result).not.toBeNull();
      expect(result!.jobId).toBe('job-1');
      expect(result!.totalPhases).toBe(3);
      expect(result!.phases).toHaveLength(3);
      expect(result!.phases[0].id).toBe('setup');
      expect(result!.phases[1].id).toBe('implementation');
      expect(result!.phases[2].id).toBe('cleanup');
    });

    it('should replace previous state entirely', () => {
      const first = createProgress({ jobId: 'job-1', totalPhases: 3 });
      const second = createProgress({
        jobId: 'job-2',
        totalPhases: 5,
        phases: [
          createPhase({ id: 'alpha', name: 'Alpha', status: 'running' }),
          createPhase({ id: 'beta', name: 'Beta', status: 'pending' }),
          createPhase({ id: 'gamma', name: 'Gamma', status: 'pending' }),
          createPhase({ id: 'delta', name: 'Delta', status: 'pending' }),
          createPhase({ id: 'epsilon', name: 'Epsilon', status: 'pending' }),
        ],
      });

      state.applySnapshot(first);
      state.applySnapshot(second);

      const result = state.getProgress();
      expect(result!.jobId).toBe('job-2');
      expect(result!.totalPhases).toBe(5);
      expect(result!.phases).toHaveLength(5);
      expect(result!.phases[0].id).toBe('alpha');
    });

    it('should recalculate expanded phases — running phase expanded', () => {
      const progress = createProgress();

      state.applySnapshot(progress);

      const expanded = state.getExpandedPhases();
      expect(expanded.has('implementation')).toBe(true);
      expect(expanded.has('setup')).toBe(false);
      expect(expanded.has('cleanup')).toBe(false);
    });

    it('should expand failed phases', () => {
      const progress = createProgress({
        phases: [
          createPhase({ id: 'setup', name: 'Setup', status: 'completed' }),
          createPhase({ id: 'implementation', name: 'Implementation', status: 'failed', error: 'Build failed' }),
          createPhase({ id: 'cleanup', name: 'Cleanup', status: 'pending' }),
        ],
      });

      state.applySnapshot(progress);

      const expanded = state.getExpandedPhases();
      expect(expanded.has('implementation')).toBe(true);
      expect(expanded.has('setup')).toBe(false);
    });

    it('should expand both running and failed phases', () => {
      const progress = createProgress({
        phases: [
          createPhase({ id: 'phase-a', name: 'A', status: 'failed', error: 'Oops' }),
          createPhase({ id: 'phase-b', name: 'B', status: 'running' }),
          createPhase({ id: 'phase-c', name: 'C', status: 'pending' }),
        ],
      });

      state.applySnapshot(progress);

      const expanded = state.getExpandedPhases();
      expect(expanded.has('phase-a')).toBe(true);
      expect(expanded.has('phase-b')).toBe(true);
      expect(expanded.has('phase-c')).toBe(false);
    });

    it('should clear expanded set when no phases are running or failed', () => {
      const progress = createProgress({
        phases: [
          createPhase({ id: 'setup', name: 'Setup', status: 'completed' }),
          createPhase({ id: 'implementation', name: 'Implementation', status: 'completed' }),
          createPhase({ id: 'cleanup', name: 'Cleanup', status: 'completed' }),
        ],
      });

      state.applySnapshot(progress);

      expect(state.getExpandedPhases().size).toBe(0);
    });
  });

  describe('applyPhaseEvent', () => {
    it('should update existing phase status and timestamps', () => {
      state.applySnapshot(createProgress());

      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'implementation',
          name: 'Implementation',
          status: 'completed',
          startedAt: '2024-01-15T10:01:00Z',
          completedAt: '2024-01-15T10:05:00Z',
          durationMs: 240000,
        }),
        phaseIndex: 1,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      const phase = state.getProgress()!.phases.find((p) => p.id === 'implementation');
      expect(phase!.status).toBe('completed');
      expect(phase!.startedAt).toBe('2024-01-15T10:01:00Z');
      expect(phase!.completedAt).toBe('2024-01-15T10:05:00Z');
      expect(phase!.durationMs).toBe(240000);
    });

    it('should update currentPhaseIndex when phase starts running', () => {
      state.applySnapshot(createProgress());

      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'cleanup',
          name: 'Cleanup',
          status: 'running',
          startedAt: '2024-01-15T10:05:00Z',
        }),
        phaseIndex: 2,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      expect(state.getProgress()!.currentPhaseIndex).toBe(2);
    });

    it('should ignore event for unknown phase ID', () => {
      state.applySnapshot(createProgress());
      const originalUpdatedAt = state.getProgress()!.updatedAt;

      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'nonexistent',
          name: 'Does Not Exist',
          status: 'running',
        }),
        phaseIndex: 99,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      // updatedAt should not change for ignored events
      expect(state.getProgress()!.updatedAt).toBe(originalUpdatedAt);
    });

    it('should not modify state when no progress has been applied', () => {
      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({ id: 'setup', status: 'running' }),
        phaseIndex: 0,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      expect(state.getProgress()).toBeNull();
    });

    it('should update expanded phases set on phase start', () => {
      state.applySnapshot(createProgress());
      // Initially, 'implementation' is running and expanded
      expect(state.getExpandedPhases().has('implementation')).toBe(true);

      // Start cleanup phase
      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'cleanup',
          name: 'Cleanup',
          status: 'running',
          startedAt: '2024-01-15T10:05:00Z',
        }),
        phaseIndex: 2,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      const expanded = state.getExpandedPhases();
      expect(expanded.has('cleanup')).toBe(true);
      // Previous running phase should be collapsed
      expect(expanded.has('implementation')).toBe(false);
    });

    it('should collapse phase on completion', () => {
      state.applySnapshot(createProgress());
      expect(state.getExpandedPhases().has('implementation')).toBe(true);

      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'implementation',
          name: 'Implementation',
          status: 'completed',
          completedAt: '2024-01-15T10:05:00Z',
          durationMs: 300000,
        }),
        phaseIndex: 1,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      expect(state.getExpandedPhases().has('implementation')).toBe(false);
    });

    it('should update phase error field', () => {
      state.applySnapshot(createProgress());

      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'implementation',
          name: 'Implementation',
          status: 'failed',
          error: 'Build failed: exit code 1',
        }),
        phaseIndex: 1,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      const phase = state.getProgress()!.phases.find((p) => p.id === 'implementation');
      expect(phase!.error).toBe('Build failed: exit code 1');
    });

    it('should update updatedAt timestamp on successful merge', () => {
      state.applySnapshot(createProgress());
      const originalUpdatedAt = state.getProgress()!.updatedAt;

      const event: WorkflowPhaseEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'implementation',
          name: 'Implementation',
          status: 'completed',
          completedAt: '2024-01-15T10:05:00Z',
        }),
        phaseIndex: 1,
        totalPhases: 3,
      };

      state.applyPhaseEvent(event);

      expect(state.getProgress()!.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe('applyStepEvent', () => {
    it('should update existing step within correct phase', () => {
      state.applySnapshot(createProgress());

      const event: WorkflowStepEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'implementation',
        phaseIndex: 1,
        step: createStep({
          id: 'impl-step-2',
          name: 'Run tests',
          status: 'completed',
          startedAt: '2024-01-15T10:02:00Z',
          completedAt: '2024-01-15T10:03:30Z',
          durationMs: 90000,
          output: 'All 42 tests passed',
        }),
        stepIndex: 1,
        totalSteps: 3,
      };

      state.applyStepEvent(event);

      const phase = state.getProgress()!.phases.find((p) => p.id === 'implementation');
      const step = phase!.steps.find((s) => s.id === 'impl-step-2');
      expect(step!.status).toBe('completed');
      expect(step!.durationMs).toBe(90000);
      expect(step!.output).toBe('All 42 tests passed');
    });

    it('should ignore event for unknown phase', () => {
      state.applySnapshot(createProgress());
      const originalUpdatedAt = state.getProgress()!.updatedAt;

      const event: WorkflowStepEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'nonexistent-phase',
        phaseIndex: 99,
        step: createStep({ id: 'step-x', status: 'running' }),
        stepIndex: 0,
        totalSteps: 1,
      };

      state.applyStepEvent(event);

      expect(state.getProgress()!.updatedAt).toBe(originalUpdatedAt);
    });

    it('should ignore event for unknown step within known phase', () => {
      state.applySnapshot(createProgress());
      const originalUpdatedAt = state.getProgress()!.updatedAt;

      const event: WorkflowStepEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'implementation',
        phaseIndex: 1,
        step: createStep({ id: 'nonexistent-step', status: 'running' }),
        stepIndex: 99,
        totalSteps: 3,
      };

      state.applyStepEvent(event);

      expect(state.getProgress()!.updatedAt).toBe(originalUpdatedAt);
    });

    it('should not modify state when no progress has been applied', () => {
      const event: WorkflowStepEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'implementation',
        phaseIndex: 1,
        step: createStep({ id: 'impl-step-1', status: 'completed' }),
        stepIndex: 0,
        totalSteps: 3,
      };

      state.applyStepEvent(event);

      expect(state.getProgress()).toBeNull();
    });

    it('should update step output and error fields', () => {
      state.applySnapshot(createProgress());

      const event: WorkflowStepEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'implementation',
        phaseIndex: 1,
        step: createStep({
          id: 'impl-step-2',
          name: 'Run tests',
          status: 'failed',
          error: 'Test suite failed: 3 failures',
          output: 'FAIL src/index.test.ts',
        }),
        stepIndex: 1,
        totalSteps: 3,
      };

      state.applyStepEvent(event);

      const phase = state.getProgress()!.phases.find((p) => p.id === 'implementation');
      const step = phase!.steps.find((s) => s.id === 'impl-step-2');
      expect(step!.status).toBe('failed');
      expect(step!.error).toBe('Test suite failed: 3 failures');
      expect(step!.output).toBe('FAIL src/index.test.ts');
    });

    it('should update updatedAt timestamp on successful merge', () => {
      state.applySnapshot(createProgress());
      const originalUpdatedAt = state.getProgress()!.updatedAt;

      const event: WorkflowStepEventData = {
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'implementation',
        phaseIndex: 1,
        step: createStep({
          id: 'impl-step-2',
          name: 'Run tests',
          status: 'completed',
        }),
        stepIndex: 1,
        totalSteps: 3,
      };

      state.applyStepEvent(event);

      expect(state.getProgress()!.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe('getExpandedPhases', () => {
    it('should return running phase ID only when one phase is running', () => {
      state.applySnapshot(createProgress());

      const expanded = state.getExpandedPhases();
      expect(expanded.size).toBe(1);
      expect(expanded.has('implementation')).toBe(true);
    });

    it('should return empty set when no phases are running', () => {
      state.applySnapshot(
        createProgress({
          phases: [
            createPhase({ id: 'setup', name: 'Setup', status: 'completed' }),
            createPhase({ id: 'implementation', name: 'Implementation', status: 'completed' }),
            createPhase({ id: 'cleanup', name: 'Cleanup', status: 'pending' }),
          ],
        })
      );

      expect(state.getExpandedPhases().size).toBe(0);
    });

    it('should track transition from one running phase to the next', () => {
      state.applySnapshot(createProgress());
      expect(state.getExpandedPhases().has('implementation')).toBe(true);
      expect(state.getExpandedPhases().has('cleanup')).toBe(false);

      // Complete implementation phase
      state.applyPhaseEvent({
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'implementation',
          name: 'Implementation',
          status: 'completed',
          completedAt: '2024-01-15T10:05:00Z',
          durationMs: 300000,
        }),
        phaseIndex: 1,
        totalPhases: 3,
      });

      // implementation collapsed after completion
      expect(state.getExpandedPhases().has('implementation')).toBe(false);
      expect(state.getExpandedPhases().size).toBe(0);

      // Start cleanup phase
      state.applyPhaseEvent({
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'cleanup',
          name: 'Cleanup',
          status: 'running',
          startedAt: '2024-01-15T10:05:01Z',
        }),
        phaseIndex: 2,
        totalPhases: 3,
      });

      // Now cleanup is expanded, implementation stays collapsed
      const expanded = state.getExpandedPhases();
      expect(expanded.has('cleanup')).toBe(true);
      expect(expanded.has('implementation')).toBe(false);
      expect(expanded.size).toBe(1);
    });
  });

  describe('snapshot after incremental', () => {
    it('should overwrite stale incremental state correctly', () => {
      // Start with initial snapshot
      state.applySnapshot(createProgress());

      // Apply some incremental updates
      state.applyPhaseEvent({
        workflowId: 'wf-1',
        jobId: 'job-1',
        phase: createPhase({
          id: 'implementation',
          name: 'Implementation',
          status: 'completed',
          completedAt: '2024-01-15T10:05:00Z',
          durationMs: 300000,
        }),
        phaseIndex: 1,
        totalPhases: 3,
      });

      state.applyStepEvent({
        workflowId: 'wf-1',
        jobId: 'job-1',
        phaseId: 'implementation',
        phaseIndex: 1,
        step: createStep({
          id: 'impl-step-2',
          name: 'Run tests',
          status: 'completed',
          durationMs: 90000,
        }),
        stepIndex: 1,
        totalSteps: 3,
      });

      // Now apply a fresh snapshot that represents a different state
      const freshProgress = createProgress({
        jobId: 'job-1',
        currentPhaseIndex: 2,
        completedPhases: 2,
        phases: [
          createPhase({ id: 'setup', name: 'Setup', status: 'completed', durationMs: 500 }),
          createPhase({ id: 'implementation', name: 'Implementation', status: 'completed', durationMs: 320000 }),
          createPhase({
            id: 'cleanup',
            name: 'Cleanup',
            status: 'running',
            startedAt: '2024-01-15T10:06:00Z',
            steps: [createStep({ id: 'cleanup-step-1', name: 'Cleanup files', status: 'running' })],
          }),
        ],
        updatedAt: '2024-01-15T10:06:05Z',
      });

      state.applySnapshot(freshProgress);

      // Verify snapshot replaced the stale incremental state
      const result = state.getProgress()!;
      expect(result.currentPhaseIndex).toBe(2);
      expect(result.completedPhases).toBe(2);
      expect(result.updatedAt).toBe('2024-01-15T10:06:05Z');

      // Cleanup is now running, so it should be expanded
      const expanded = state.getExpandedPhases();
      expect(expanded.has('cleanup')).toBe(true);
      expect(expanded.has('implementation')).toBe(false);
      expect(expanded.size).toBe(1);

      // Verify the implementation phase has the snapshot's durationMs, not the incremental one
      const implPhase = result.phases.find((p) => p.id === 'implementation');
      expect(implPhase!.durationMs).toBe(320000);
    });
  });

  describe('reset', () => {
    it('should clear progress and expanded phases', () => {
      state.applySnapshot(createProgress());
      expect(state.getProgress()).not.toBeNull();
      expect(state.getExpandedPhases().size).toBeGreaterThan(0);

      state.reset();

      expect(state.getProgress()).toBeNull();
      expect(state.getExpandedPhases().size).toBe(0);
    });
  });
});
