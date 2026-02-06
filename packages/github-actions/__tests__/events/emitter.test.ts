import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowEventEmitter, createEventEmitter } from '../../src/events/emitter.js';
import { SimpleEventBus } from '../../src/events/types.js';
import type { WorkflowRun } from '../../src/types/workflows.js';
import type { CheckRun } from '../../src/types/check-runs.js';
import type { Job } from '../../src/types/jobs.js';

describe('WorkflowEventEmitter', () => {
  let eventBus: SimpleEventBus;
  let emitter: WorkflowEventEmitter;

  const createMockRun = (
    conclusion: WorkflowRun['conclusion'] = 'success',
    status: WorkflowRun['status'] = 'completed'
  ): WorkflowRun => ({
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: 'abc123',
    status,
    conclusion,
    html_url: 'https://github.com/owner/repo/actions/runs/123',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:01:00Z',
    run_started_at: '2024-01-01T00:00:00Z',
    actor: { id: 1, login: 'user', avatar_url: '', type: 'User' },
    event: 'push',
    run_attempt: 1,
  });

  const createMockJob = (
    name: string,
    conclusion: Job['conclusion'] = 'success'
  ): Job => ({
    id: 456,
    run_id: 123,
    name,
    status: 'completed',
    conclusion,
    steps: [],
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:01:00Z',
    runner_id: 1,
    runner_name: 'ubuntu-latest',
  });

  const createMockCheckRun = (): CheckRun => ({
    id: 789,
    node_id: 'MDEwOkNoZWNrU3VpdGUx',
    name: 'lint',
    head_sha: 'abc123def456789012345678901234567890abcd',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/owner/repo/runs/789',
  });

  beforeEach(() => {
    eventBus = new SimpleEventBus();
    emitter = new WorkflowEventEmitter(eventBus);
  });

  describe('emitWorkflowCompleted', () => {
    it('should emit workflow.completed event', () => {
      const handler = vi.fn();
      eventBus.on('workflow.completed', handler);

      const run = createMockRun('success');
      emitter.emitWorkflowCompleted(run);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        type: 'workflow.completed',
        runId: 123,
        workflow: '.github/workflows/ci.yml',
        conclusion: 'success',
        duration: expect.any(Number),
        url: 'https://github.com/owner/repo/actions/runs/123',
      });
    });

    it('should calculate duration correctly', () => {
      const handler = vi.fn();
      eventBus.on('workflow.completed', handler);

      const run = createMockRun('success');
      emitter.emitWorkflowCompleted(run);

      const event = handler.mock.calls[0]?.[0];
      expect(event.duration).toBe(60000); // 1 minute
    });
  });

  describe('emitWorkflowFailed', () => {
    it('should emit workflow.failed event', () => {
      const handler = vi.fn();
      eventBus.on('workflow.failed', handler);

      const run = createMockRun('failure');
      const failedJobs = [createMockJob('test', 'failure')];
      emitter.emitWorkflowFailed(run, failedJobs);

      expect(handler).toHaveBeenCalledWith({
        type: 'workflow.failed',
        runId: 123,
        workflow: '.github/workflows/ci.yml',
        error: 'Jobs failed: test',
        failedJobs: ['test'],
        url: 'https://github.com/owner/repo/actions/runs/123',
      });
    });

    it('should handle cancelled workflow', () => {
      const handler = vi.fn();
      eventBus.on('workflow.failed', handler);

      const run = createMockRun('cancelled');
      emitter.emitWorkflowFailed(run);

      const event = handler.mock.calls[0]?.[0];
      expect(event.error).toBe('Workflow was cancelled');
    });

    it('should handle timed out workflow', () => {
      const handler = vi.fn();
      eventBus.on('workflow.failed', handler);

      const run = createMockRun('timed_out');
      emitter.emitWorkflowFailed(run);

      const event = handler.mock.calls[0]?.[0];
      expect(event.error).toBe('Workflow timed out');
    });
  });

  describe('emitCheckRunCompleted', () => {
    it('should emit check_run.completed event', () => {
      const handler = vi.fn();
      eventBus.on('check_run.completed', handler);

      const check = createMockCheckRun();
      emitter.emitCheckRunCompleted(check);

      expect(handler).toHaveBeenCalledWith({
        type: 'check_run.completed',
        checkRunId: 789,
        name: 'lint',
        conclusion: 'success',
        headSha: 'abc123def456789012345678901234567890abcd',
      });
    });
  });

  describe('emitForWorkflowRun', () => {
    it('should emit completed event for successful run', () => {
      const completedHandler = vi.fn();
      const failedHandler = vi.fn();
      eventBus.on('workflow.completed', completedHandler);
      eventBus.on('workflow.failed', failedHandler);

      emitter.emitForWorkflowRun(createMockRun('success'));

      expect(completedHandler).toHaveBeenCalledTimes(1);
      expect(failedHandler).not.toHaveBeenCalled();
    });

    it('should emit failed event for failed run', () => {
      const completedHandler = vi.fn();
      const failedHandler = vi.fn();
      eventBus.on('workflow.completed', completedHandler);
      eventBus.on('workflow.failed', failedHandler);

      emitter.emitForWorkflowRun(createMockRun('failure'));

      expect(failedHandler).toHaveBeenCalledTimes(1);
      expect(completedHandler).not.toHaveBeenCalled();
    });

    it('should not emit for in-progress run', () => {
      const handler = vi.fn();
      eventBus.on('workflow.completed', handler);
      eventBus.on('workflow.failed', handler);

      emitter.emitForWorkflowRun(createMockRun(null, 'in_progress'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit completed for neutral conclusion', () => {
      const handler = vi.fn();
      eventBus.on('workflow.completed', handler);

      emitter.emitForWorkflowRun(createMockRun('neutral'));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('createEventEmitter', () => {
    it('should create a WorkflowEventEmitter instance', () => {
      const em = createEventEmitter(eventBus);
      expect(em).toBeInstanceOf(WorkflowEventEmitter);
    });
  });
});

describe('SimpleEventBus', () => {
  let eventBus: SimpleEventBus;

  beforeEach(() => {
    eventBus = new SimpleEventBus();
  });

  it('should call handlers on emit', () => {
    const handler = vi.fn();
    eventBus.on('test', handler);
    eventBus.emit('test', { data: 'value' });

    expect(handler).toHaveBeenCalledWith({ data: 'value' });
  });

  it('should support multiple handlers', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    eventBus.on('test', handler1);
    eventBus.on('test', handler2);
    eventBus.emit('test', 'data');

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('should return unsubscribe function', () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.on('test', handler);

    eventBus.emit('test', 1);
    unsubscribe();
    eventBus.emit('test', 2);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support once subscription', () => {
    const handler = vi.fn();
    eventBus.once('test', handler);

    eventBus.emit('test', 1);
    eventBus.emit('test', 2);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should handle errors in handlers gracefully', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const errorHandler = () => {
      throw new Error('Handler error');
    };
    const normalHandler = vi.fn();

    eventBus.on('test', errorHandler);
    eventBus.on('test', normalHandler);
    eventBus.emit('test', 'data');

    expect(normalHandler).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('should clear all handlers', () => {
    const handler = vi.fn();
    eventBus.on('test', handler);
    eventBus.clear();
    eventBus.emit('test', 'data');

    expect(handler).not.toHaveBeenCalled();
  });

  it('should report listener count', () => {
    expect(eventBus.listenerCount('test')).toBe(0);
    eventBus.on('test', () => {});
    expect(eventBus.listenerCount('test')).toBe(1);
    eventBus.on('test', () => {});
    expect(eventBus.listenerCount('test')).toBe(2);
  });
});
