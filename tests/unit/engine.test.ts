/**
 * Workflow Engine Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowRuntime, type StepExecutor } from '../../src/engine/WorkflowRuntime.js';
import { WorkflowEventEmitter } from '../../src/events/WorkflowEventEmitter.js';
import type { WorkflowState } from '../../src/types/WorkflowState.js';
import type { WorkflowDefinition, WorkflowStep } from '../../src/types/WorkflowDefinition.js';
import type { WorkflowEvent } from '../../src/types/WorkflowEvent.js';

describe('WorkflowRuntime', () => {
  let eventEmitter: WorkflowEventEmitter;
  let events: WorkflowEvent[];

  const createDefinition = (steps: WorkflowStep[]): WorkflowDefinition => ({
    name: 'test-workflow',
    version: '1.0.0',
    steps,
  });

  const createState = (definition: WorkflowDefinition): WorkflowState => ({
    id: 'wf-1',
    definitionName: definition.name,
    definitionVersion: definition.version,
    definition,
    status: 'created',
    currentStepId: null,
    context: {
      input: {},
      outputs: {},
      data: {},
      metadata: {},
    },
    stepResults: {},
    stepAttempts: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    eventEmitter = new WorkflowEventEmitter();
    events = [];
    eventEmitter.onEvent((event) => events.push(event));
  });

  describe('start', () => {
    it('starts a workflow in created state', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();

      expect(runtime.status).toBe('running');
      expect(runtime.currentStepId).toBe('step-1');
      expect(events.some((e) => e.type === 'workflow:started')).toBe(true);
    });

    it('throws when starting non-created workflow', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      state.status = 'running';
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await expect(runtime.start()).rejects.toThrow('Cannot start workflow');
    });

    it('throws when workflow has no steps', async () => {
      const definition = createDefinition([]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await expect(runtime.start()).rejects.toThrow('no steps');
    });
  });

  describe('executeStep', () => {
    it('executes a step and advances to next', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' }, next: 'step-2' },
        { id: 'step-2', type: 'agent', config: { command: '/test2', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.executeStep();

      expect(runtime.currentStepId).toBe('step-2');
      expect(events.some((e) => e.type === 'step:completed')).toBe(true);
    });

    it('completes workflow when no more steps', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.executeStep();

      expect(runtime.status).toBe('completed');
      expect(events.some((e) => e.type === 'workflow:completed')).toBe(true);
    });

    it('enters waiting state for human steps', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'human', config: { action: 'review', urgency: 'when_available' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.executeStep();

      expect(runtime.status).toBe('waiting');
      expect(events.some((e) => e.type === 'step:waiting')).toBe(true);
    });

    it('evaluates condition steps', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'condition', config: { expression: 'data.approved == true', then: 'approved', else: 'rejected' } },
        { id: 'approved', type: 'agent', config: { command: '/approve', mode: 'coding' } },
        { id: 'rejected', type: 'agent', config: { command: '/reject', mode: 'coding' } },
      ]);
      const state = createState(definition);
      state.context.data = { approved: true };
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.executeStep();

      expect(runtime.currentStepId).toBe('approved');
    });
  });

  describe('run', () => {
    it('runs workflow to completion', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' }, next: 'step-2' },
        { id: 'step-2', type: 'agent', config: { command: '/test2', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.run();

      expect(runtime.status).toBe('completed');
      expect(runtime.getState().stepResults['step-1']).toBeDefined();
      expect(runtime.getState().stepResults['step-2']).toBeDefined();
    });

    it('stops at human step in waiting state', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' }, next: 'step-2' },
        { id: 'step-2', type: 'human', config: { action: 'approve', urgency: 'blocking_soon' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.run();

      expect(runtime.status).toBe('waiting');
      expect(runtime.currentStepId).toBe('step-2');
    });
  });

  describe('pause/resume', () => {
    it('pauses a running workflow', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' }, next: 'step-2' },
        { id: 'step-2', type: 'agent', config: { command: '/test2', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.pause();

      expect(runtime.status).toBe('paused');
      expect(events.some((e) => e.type === 'workflow:paused')).toBe(true);
    });

    it('resumes a paused workflow', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.pause();
      await runtime.resume();

      expect(runtime.status).toBe('running');
      expect(events.some((e) => e.type === 'workflow:resumed')).toBe(true);
    });
  });

  describe('provideInput', () => {
    it('provides input to waiting workflow and advances', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'human', config: { action: 'review', urgency: 'when_available' }, next: 'step-2' },
        { id: 'step-2', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.executeStep(); // Enter waiting state

      expect(runtime.status).toBe('waiting');

      await runtime.provideInput({ approved: true });

      expect(runtime.status).toBe('running');
      expect(runtime.currentStepId).toBe('step-2');
      expect(runtime.context.outputs['step-1']).toEqual({ approved: true });
    });
  });

  describe('cancel', () => {
    it('cancels a running workflow', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.cancel('User requested cancellation');

      expect(runtime.status).toBe('cancelled');
      expect(events.some((e) => e.type === 'workflow:cancelled')).toBe(true);
    });

    it('throws when cancelling completed workflow', async () => {
      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.run();

      await expect(runtime.cancel()).rejects.toThrow('Cannot cancel workflow');
    });
  });

  describe('error handling', () => {
    it('handles step execution errors', async () => {
      const failingExecutor: StepExecutor = async () => ({
        success: false,
        error: { code: 'TEST_ERROR', message: 'Test error' },
      });

      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' } },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, { eventEmitter, stepExecutor: failingExecutor });

      await runtime.run();

      expect(runtime.status).toBe('failed');
      expect(runtime.getState().error).toBeDefined();
      expect(events.some((e) => e.type === 'workflow:failed')).toBe(true);
    });

    it('retries on failure with retry handler', async () => {
      let attempts = 0;
      const retryExecutor: StepExecutor = async () => {
        attempts++;
        if (attempts < 2) {
          return { success: false, error: { code: 'RETRY', message: 'Retry needed' } };
        }
        return { success: true };
      };

      const definition = createDefinition([
        { id: 'step-1', type: 'agent', config: { command: '/test', mode: 'coding' }, retries: 3 },
      ]);
      const state = createState(definition);
      const runtime = new WorkflowRuntime(state, {
        eventEmitter,
        stepExecutor: retryExecutor,
        errorHandler: {
          onError: () => ({ type: 'retry', maxAttempts: 3 }),
        },
      });

      await runtime.run();

      expect(runtime.status).toBe('completed');
      expect(attempts).toBe(2);
    });
  });

  describe('conditional navigation', () => {
    it('evaluates conditional next steps', async () => {
      const definition = createDefinition([
        {
          id: 'step-1',
          type: 'agent',
          config: { command: '/test', mode: 'coding' },
          next: [
            { condition: 'data.status == approved', stepId: 'approved' },
            { condition: 'data.status == rejected', stepId: 'rejected' },
          ],
        },
        { id: 'approved', type: 'agent', config: { command: '/approve', mode: 'coding' } },
        { id: 'rejected', type: 'agent', config: { command: '/reject', mode: 'coding' } },
      ]);
      const state = createState(definition);
      state.context.data = { status: 'rejected' };
      const runtime = new WorkflowRuntime(state, { eventEmitter });

      await runtime.start();
      await runtime.executeStep();

      expect(runtime.currentStepId).toBe('rejected');
    });
  });
});
