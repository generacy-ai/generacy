import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowExecutor, resetActionsRegistration } from '../index.js';
import { registerActionHandler } from '../../actions/index.js';
import type {
  ActionHandler,
  StepDefinition,
  ActionContext,
  ActionResult,
  ValidationResult,
  ExecutableWorkflow,
} from '../../types/index.js';
import { NoopLogger } from '../../types/logger.js';

/** Captures the ActionContext passed to execute() for inspection. */
class ContextCapturingAction implements ActionHandler {
  readonly type = 'test.capture_context';
  lastContext: ActionContext | undefined;

  canHandle(step: StepDefinition): boolean {
    return step.action === 'test.capture_context';
  }

  validate(_step: StepDefinition): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(_step: StepDefinition, context: ActionContext): Promise<ActionResult> {
    this.lastContext = context;
    return { success: true, output: {}, duration: 0 };
  }
}

const makeWorkflow = (): ExecutableWorkflow => ({
  name: 'test-sibling-workdirs',
  phases: [
    {
      name: 'test-phase',
      steps: [
        {
          name: 'capture-step',
          action: 'test.capture_context',
        } as StepDefinition,
      ],
    },
  ],
});

describe('siblingWorkdirs threading', () => {
  let captureAction: ContextCapturingAction;

  beforeEach(() => {
    resetActionsRegistration();
    captureAction = new ContextCapturingAction();
    registerActionHandler(captureAction);
  });

  it('threads siblingWorkdirs from ExecutionOptions to ActionContext', async () => {
    const executor = new WorkflowExecutor({ logger: new NoopLogger() });
    const siblings = { generacy: '/workspaces/generacy', contracts: '/workspaces/contracts' };

    await executor.execute(makeWorkflow(), {
      mode: 'normal',
      siblingWorkdirs: siblings,
    });

    expect(captureAction.lastContext).toBeDefined();
    expect(captureAction.lastContext!.siblingWorkdirs).toEqual(siblings);
  });

  it('defaults to empty object when siblingWorkdirs not provided', async () => {
    const executor = new WorkflowExecutor({ logger: new NoopLogger() });

    await executor.execute(makeWorkflow(), { mode: 'normal' });

    expect(captureAction.lastContext).toBeDefined();
    expect(captureAction.lastContext!.siblingWorkdirs).toEqual({});
  });
});
