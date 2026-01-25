/**
 * Tests for workflow executor
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkflowExecutor,
  ExecutionEventEmitter,
  createExecutionEvent,
  resetActionsRegistration,
  registerActionHandler,
} from '../index.js';
import { prepareWorkflow } from '../../loader/index.js';
import type {
  WorkflowDefinition,
  ActionHandler,
  StepDefinition,
  ActionContext,
  ActionResult,
  ValidationResult,
} from '../../types/index.js';
import { NoopLogger } from '../../types/logger.js';

// Mock action handler for testing
class MockAction implements ActionHandler {
  readonly type = 'mock.action';
  executeResult: Partial<ActionResult> = { success: true, output: { data: 'test' } };

  canHandle(step: StepDefinition): boolean {
    return step.action === 'mock.action';
  }

  validate(_step: StepDefinition): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(_step: StepDefinition, _context: ActionContext): Promise<ActionResult> {
    return {
      success: this.executeResult.success ?? true,
      output: this.executeResult.output ?? {},
      duration: 100,
      ...this.executeResult,
    };
  }
}

describe('ExecutionEventEmitter', () => {
  it('should add and remove listeners', () => {
    const emitter = new ExecutionEventEmitter();
    const listener = vi.fn();

    const disposable = emitter.addEventListener(listener);
    emitter.emit({ type: 'workflow:start', timestamp: Date.now(), workflowName: 'test' });

    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
    emitter.emit({ type: 'workflow:complete', timestamp: Date.now(), workflowName: 'test' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should emit events to all listeners', () => {
    const emitter = new ExecutionEventEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.addEventListener(listener1);
    emitter.addEventListener(listener2);

    emitter.emit({ type: 'step:start', timestamp: Date.now(), workflowName: 'test' });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  it('should catch listener errors', () => {
    const emitter = new ExecutionEventEmitter();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    emitter.addEventListener(() => {
      throw new Error('Listener error');
    });

    expect(() => {
      emitter.emit({ type: 'workflow:start', timestamp: Date.now(), workflowName: 'test' });
    }).not.toThrow();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('createExecutionEvent', () => {
  it('should create event with required fields', () => {
    const event = createExecutionEvent('workflow:start', 'my-workflow');

    expect(event.type).toBe('workflow:start');
    expect(event.workflowName).toBe('my-workflow');
    expect(event.timestamp).toBeDefined();
  });

  it('should include optional fields', () => {
    const event = createExecutionEvent('step:complete', 'workflow', {
      phaseName: 'phase1',
      stepName: 'step1',
      message: 'Success',
      data: { result: 'ok' },
    });

    expect(event.phaseName).toBe('phase1');
    expect(event.stepName).toBe('step1');
    expect(event.message).toBe('Success');
    expect(event.data).toEqual({ result: 'ok' });
  });
});

describe('WorkflowExecutor', () => {
  const mockAction = new MockAction();

  beforeEach(() => {
    resetActionsRegistration();
    registerActionHandler(mockAction);
  });

  afterEach(() => {
    resetActionsRegistration();
  });

  const createTestWorkflow = (): WorkflowDefinition => ({
    name: 'test-workflow',
    phases: [
      {
        name: 'phase1',
        steps: [
          {
            name: 'step1',
            action: 'mock.action',
          },
        ],
      },
    ],
  });

  it('should execute a simple workflow', async () => {
    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    const workflow = prepareWorkflow(createTestWorkflow());
    const result = await executor.execute(workflow, {
      workdir: '/tmp',
      env: {},
    });

    expect(result.status).toBe('completed');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.steps).toHaveLength(1);
    expect(result.phases[0]!.steps[0]!.status).toBe('completed');
  });

  it('should emit events during execution', async () => {
    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    const events: string[] = [];
    executor.addEventListener((event) => {
      events.push(event.type);
    });

    const workflow = prepareWorkflow(createTestWorkflow());
    await executor.execute(workflow, {
      workdir: '/tmp',
      env: {},
    });

    expect(events).toContain('workflow:start');
    expect(events).toContain('phase:start');
    expect(events).toContain('step:start');
    expect(events).toContain('step:complete');
    expect(events).toContain('phase:complete');
    expect(events).toContain('workflow:complete');
  });

  it('should handle step failure', async () => {
    mockAction.executeResult = {
      success: false,
      error: 'Step failed',
    };

    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    const workflow = prepareWorkflow(createTestWorkflow());
    const result = await executor.execute(workflow, {
      workdir: '/tmp',
      env: {},
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Step failed');
  });

  it('should continue on error when configured', async () => {
    mockAction.executeResult = {
      success: false,
      error: 'Step failed',
    };

    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    const definition: WorkflowDefinition = {
      name: 'test',
      phases: [
        {
          name: 'phase1',
          steps: [
            { name: 'step1', action: 'mock.action', continueOnError: true },
            { name: 'step2', action: 'mock.action' },
          ],
        },
      ],
    };

    // Make second step succeed
    let callCount = 0;
    mockAction.execute = async () => {
      callCount++;
      if (callCount === 1) {
        return { success: false, error: 'First failed', duration: 100 };
      }
      return { success: true, output: {}, duration: 100 };
    };

    const workflow = prepareWorkflow(definition);
    const result = await executor.execute(workflow, {
      workdir: '/tmp',
      env: {},
    });

    expect(result.status).toBe('completed');
    expect(result.phases[0]!.steps[0]!.status).toBe('failed');
    expect(result.phases[0]!.steps[1]!.status).toBe('completed');
  });

  it('should pass inputs to execution context', async () => {
    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    let capturedContext: ActionContext | null = null;
    mockAction.execute = async (_step, context) => {
      capturedContext = context;
      return { success: true, output: {}, duration: 100 };
    };

    const workflow = prepareWorkflow(createTestWorkflow());
    await executor.execute(
      workflow,
      { workdir: '/tmp', env: {} },
      { name: 'TestUser' }
    );

    expect(capturedContext!.inputs).toEqual({ name: 'TestUser' });
  });

  it('should support cancellation via AbortSignal', async () => {
    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    const controller = new AbortController();

    mockAction.execute = async () => {
      // Simulate long-running operation
      await new Promise(resolve => setTimeout(resolve, 100));
      return { success: true, output: {}, duration: 100 };
    };

    // Cancel after a short delay
    setTimeout(() => controller.abort(), 10);

    const workflow = prepareWorkflow(createTestWorkflow());
    const result = await executor.execute(
      workflow,
      { workdir: '/tmp', env: {}, signal: controller.signal }
    );

    expect(result.status).toBe('cancelled');
  });

  it('should validate workflow', async () => {
    const executor = new WorkflowExecutor({
      logger: new NoopLogger(),
    });

    const workflow = prepareWorkflow(createTestWorkflow());
    const result = await executor.validate(workflow, {
      workdir: '/tmp',
      env: {},
    });

    // Validation returns a result without actually executing
    expect(result.status).toBeDefined();
  });
});
