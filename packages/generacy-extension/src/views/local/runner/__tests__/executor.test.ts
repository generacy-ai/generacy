/**
 * Integration tests for workflow execution engine
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecutableWorkflow, WorkflowStep, ExecutionOptions } from '../types';

// Mock VS Code API
vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };

  const mockTerminal = {
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    window: {
      createOutputChannel: vi.fn(() => mockOutputChannel),
      createTerminal: vi.fn(() => mockTerminal),
      onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    tasks: {
      executeTask: vi.fn(() => Promise.resolve()),
      onDidEndTaskProcess: vi.fn(() => ({ dispose: vi.fn() })),
    },
    Task: vi.fn(),
    ShellExecution: vi.fn(),
    TaskScope: { Workspace: 1 },
    TaskRevealKind: { Always: 1, Silent: 2 },
    TaskPanelKind: { Shared: 1 },
    CancellationTokenSource: vi.fn(() => ({
      token: {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
      },
      cancel: vi.fn(),
      dispose: vi.fn(),
    })),
    Disposable: vi.fn(),
  };
});

// Import after mocking
import { WorkflowExecutor } from '../executor';
import {
  registerActionHandler,
  clearActionRegistry,
  type ActionHandler,
  type ActionContext,
  type ActionResult,
} from '../actions';

// Helper to create a mock action handler
function createMockHandler(
  type: string,
  executeImpl?: (step: WorkflowStep, context: ActionContext) => Promise<ActionResult>
): ActionHandler {
  return {
    type: type as any,
    canHandle: (step) => step.action === type || step.uses === type,
    execute: executeImpl ?? vi.fn().mockResolvedValue({
      success: true,
      output: { result: 'success' },
      duration: 100,
    }),
  };
}

describe('WorkflowExecutor Integration', () => {
  let executor: WorkflowExecutor;

  beforeEach(() => {
    WorkflowExecutor.resetInstance();
    clearActionRegistry();
    executor = WorkflowExecutor.getInstance();
  });

  afterEach(() => {
    WorkflowExecutor.resetInstance();
    clearActionRegistry();
  });

  describe('Basic Workflow Execution', () => {
    it('should execute a simple workflow', async () => {
      // Register a test handler
      const handler = createMockHandler('test-action');
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'test-workflow',
        phases: [
          {
            name: 'test-phase',
            steps: [
              { name: 'step1', action: 'test-action' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.phaseResults).toHaveLength(1);
      expect(result.phaseResults[0]?.stepResults).toHaveLength(1);
      expect(result.phaseResults[0]?.stepResults[0]?.status).toBe('completed');
    });

    it('should execute multiple phases', async () => {
      const handler = createMockHandler('test-action');
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'multi-phase-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [{ name: 'step1', action: 'test-action' }],
          },
          {
            name: 'phase2',
            steps: [{ name: 'step2', action: 'test-action' }],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.phaseResults).toHaveLength(2);
    });

    it('should execute multiple steps in a phase', async () => {
      const handler = createMockHandler('test-action');
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'multi-step-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'test-action' },
              { name: 'step2', action: 'test-action' },
              { name: 'step3', action: 'test-action' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.phaseResults[0]?.stepResults).toHaveLength(3);
    });
  });

  describe('Variable Interpolation', () => {
    it('should interpolate workflow inputs', async () => {
      let capturedInput: unknown;
      const handler = createMockHandler('test-action', async (step) => {
        capturedInput = step.with?.['value'];
        return {
          success: true,
          output: { received: capturedInput },
          duration: 100,
        };
      });
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'interpolation-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              {
                name: 'step1',
                action: 'test-action',
                with: { value: '${inputs.myInput}' },
              } as WorkflowStep,
            ],
          },
        ],
      };

      await executor.execute(workflow, { mode: 'normal' }, { myInput: 'hello world' });

      expect(capturedInput).toBe('hello world');
    });

    it('should interpolate step outputs', async () => {
      let step2Input: unknown;
      const handler = createMockHandler('test-action', async (step, context) => {
        if (step.name === 'step1') {
          return {
            success: true,
            output: { version: '1.0.0' },
            duration: 100,
          };
        }
        step2Input = step.with?.['version'];
        return {
          success: true,
          output: { received: step2Input },
          duration: 100,
        };
      });
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'step-output-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'test-action' },
              {
                name: 'step2',
                action: 'test-action',
                with: { version: '${steps.step1.output.version}' },
              } as WorkflowStep,
            ],
          },
        ],
      };

      await executor.execute(workflow);

      expect(step2Input).toBe('1.0.0');
    });
  });

  describe('Error Handling', () => {
    it('should handle step failure', async () => {
      const handler = createMockHandler('failing-action', async () => ({
        success: false,
        output: null,
        error: 'Action failed',
        duration: 100,
      }));
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'failing-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'failing-action' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.phaseResults[0]?.stepResults[0]?.status).toBe('failed');
    });

    it('should continue on error when continueOnError is true', async () => {
      let stepExecutions: string[] = [];
      const handler = createMockHandler('test-action', async (step) => {
        stepExecutions.push(step.name);
        if (step.name === 'step1') {
          return {
            success: false,
            output: null,
            error: 'Step 1 failed',
            duration: 100,
          };
        }
        return {
          success: true,
          output: 'success',
          duration: 100,
        };
      });
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'continue-on-error-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'test-action', continueOnError: true },
              { name: 'step2', action: 'test-action' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(stepExecutions).toContain('step2');
      expect(result.phaseResults[0]?.stepResults).toHaveLength(2);
    });

    it('should stop execution on failure when continueOnError is false', async () => {
      let stepExecutions: string[] = [];
      const handler = createMockHandler('test-action', async (step) => {
        stepExecutions.push(step.name);
        if (step.name === 'step1') {
          return {
            success: false,
            output: null,
            error: 'Step 1 failed',
            duration: 100,
          };
        }
        return {
          success: true,
          output: 'success',
          duration: 100,
        };
      });
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'stop-on-error-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'test-action' },
              { name: 'step2', action: 'test-action' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(stepExecutions).toEqual(['step1']);
      expect(result.status).toBe('failed');
    });
  });

  describe('Retry Logic', () => {
    it('should retry failed actions', async () => {
      let attempts = 0;
      const handler = createMockHandler('retry-action', async () => {
        attempts++;
        if (attempts < 3) {
          return {
            success: false,
            output: null,
            error: `Attempt ${attempts} failed`,
            duration: 100,
          };
        }
        return {
          success: true,
          output: 'success on attempt 3',
          duration: 100,
        };
      });
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'retry-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              {
                name: 'step1',
                action: 'retry-action',
                retry: {
                  maxAttempts: 3,
                  delay: 10,
                  backoff: 'constant',
                },
              },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(attempts).toBe(3);
      expect(result.status).toBe('completed');
    });
  });

  describe('Event Emission', () => {
    it('should emit execution events', async () => {
      const handler = createMockHandler('test-action');
      registerActionHandler(handler);

      const events: string[] = [];
      executor.addEventListener((event) => {
        events.push(event.type);
      });

      const workflow: ExecutableWorkflow = {
        name: 'events-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [{ name: 'step1', action: 'test-action' }],
          },
        ],
      };

      await executor.execute(workflow);

      expect(events).toContain('execution:start');
      expect(events).toContain('phase:start');
      expect(events).toContain('step:start');
      expect(events).toContain('action:start');
      expect(events).toContain('action:complete');
      expect(events).toContain('step:complete');
      expect(events).toContain('phase:complete');
      expect(events).toContain('execution:complete');
    });
  });

  describe('Dry Run Mode', () => {
    it('should not execute actions in dry-run mode', async () => {
      let executed = false;
      const handler = createMockHandler('test-action', async () => {
        executed = true;
        return {
          success: true,
          output: 'success',
          duration: 100,
        };
      });
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'dry-run-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [{ name: 'step1', action: 'test-action' }],
          },
        ],
      };

      const result = await executor.execute(workflow, { mode: 'dry-run' });

      expect(executed).toBe(false);
      expect(result.status).toBe('completed');
      expect(result.phaseResults[0]?.stepResults[0]?.output).toContain('DRY-RUN');
    });
  });

  describe('Condition Evaluation', () => {
    it('should skip step when condition is false', async () => {
      const handler = createMockHandler('test-action');
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'condition-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'test-action', condition: 'false' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(result.phaseResults[0]?.stepResults[0]?.status).toBe('skipped');
    });

    it('should execute step when condition is true', async () => {
      const handler = createMockHandler('test-action');
      registerActionHandler(handler);

      const workflow: ExecutableWorkflow = {
        name: 'condition-workflow',
        phases: [
          {
            name: 'phase1',
            steps: [
              { name: 'step1', action: 'test-action', condition: 'true' },
            ],
          },
        ],
      };

      const result = await executor.execute(workflow);

      expect(result.phaseResults[0]?.stepResults[0]?.status).toBe('completed');
    });
  });
});
