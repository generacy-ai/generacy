/**
 * Unit tests for executor branch validation after setup phase.
 *
 * Verifies that:
 * - Workflow aborts when still on default branch after setup phase
 * - Workflow continues when on a feature branch after setup
 * - Validation is skipped when cwd is not provided
 * - Validation is skipped when setup phase failed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimpleGit } from 'simple-git';
import type { ExecutableWorkflow, StepDefinition, ActionHandler, ActionContext } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGit, mockGetDefaultBranch } = vi.hoisted(() => {
  const mockGit = {
    revparse: vi.fn(),
  };
  const mockGetDefaultBranch = vi.fn();
  return { mockGit, mockGetDefaultBranch };
});

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGit),
}));

vi.mock('../../actions/builtin/speckit/lib/feature.js', () => ({
  getDefaultBranch: mockGetDefaultBranch,
}));

// Mock the action registry so we can inject a simple handler for setup steps
const mockHandler: ActionHandler = {
  type: 'shell',
  canHandle: (step: StepDefinition) => step.action === 'shell',
  execute: vi.fn(async () => ({
    success: true,
    output: 'ok',
    duration: 0,
  })),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
};

vi.mock('../../actions/index.js', () => ({
  registerBuiltinActions: vi.fn(),
  getActionHandler: vi.fn(() => mockHandler),
}));

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------

import { WorkflowExecutor } from '../index.js';
import { NoopLogger } from '../../types/logger.js';
import { simpleGit } from 'simple-git';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal workflow with a setup phase and an optional second phase */
function createTestWorkflow(opts?: {
  setupSteps?: StepDefinition[];
  extraPhases?: { name: string; steps: StepDefinition[] }[];
}): ExecutableWorkflow {
  const setupSteps = opts?.setupSteps ?? [
    { name: 'create-feature', action: 'shell', command: 'echo setup' },
  ];

  const phases = [
    { name: 'setup', steps: setupSteps },
    ...(opts?.extraPhases ?? [
      {
        name: 'specification',
        steps: [{ name: 'write-spec', action: 'shell', command: 'echo spec' }],
      },
    ]),
  ];

  return {
    name: 'test-workflow',
    phases,
    env: {},
  };
}

/** In-memory noop store */
const noopStore = {
  save: vi.fn(),
  load: vi.fn().mockResolvedValue(null),
  delete: vi.fn(),
  listPending: vi.fn().mockResolvedValue([]),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Executor branch validation after setup phase', () => {
  let executor: WorkflowExecutor;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: on a feature branch (happy path)
    mockGit.revparse.mockResolvedValue('042-my-feature');
    mockGetDefaultBranch.mockResolvedValue('develop');

    // Reset the mock handler
    (mockHandler.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      output: 'ok',
      duration: 0,
    });

    executor = new WorkflowExecutor({
      logger: new NoopLogger(),
      store: noopStore as any,
    });
  });

  afterEach(() => {
    executor.dispose();
  });

  // -----------------------------------------------------------------------
  // Test: aborts when on default branch after setup
  // -----------------------------------------------------------------------
  it('aborts workflow when still on default branch after setup phase', async () => {
    // Simulate: still on default branch after setup
    mockGit.revparse.mockResolvedValue('develop');
    mockGetDefaultBranch.mockResolvedValue('develop');

    const workflow = createTestWorkflow();

    const result = await executor.execute(
      workflow,
      { mode: 'normal', cwd: '/repo' },
    );

    expect(result.status).toBe('failed');

    // The setup phase itself should have completed
    expect(result.phaseResults).toHaveLength(1);
    expect(result.phaseResults[0]!.phaseName).toBe('setup');
    expect(result.phaseResults[0]!.status).toBe('completed');

    // simpleGit should have been called with the cwd
    expect(simpleGit).toHaveBeenCalledWith('/repo');

    // The specification phase should NOT have executed
    const specPhase = result.phaseResults.find(p => p.phaseName === 'specification');
    expect(specPhase).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test: continues when on feature branch
  // -----------------------------------------------------------------------
  it('continues normally when on a feature branch after setup', async () => {
    // Simulate: on feature branch after setup
    mockGit.revparse.mockResolvedValue('042-my-feature');
    mockGetDefaultBranch.mockResolvedValue('develop');

    const workflow = createTestWorkflow();

    const result = await executor.execute(
      workflow,
      { mode: 'normal', cwd: '/repo' },
    );

    expect(result.status).toBe('completed');
    expect(result.phaseResults).toHaveLength(2);
    expect(result.phaseResults[0]!.phaseName).toBe('setup');
    expect(result.phaseResults[1]!.phaseName).toBe('specification');
  });

  // -----------------------------------------------------------------------
  // Test: skips validation when cwd not provided
  // -----------------------------------------------------------------------
  it('skips validation when cwd is not provided', async () => {
    const workflow = createTestWorkflow();

    const result = await executor.execute(
      workflow,
      { mode: 'normal' }, // no cwd
    );

    expect(result.status).toBe('completed');

    // simpleGit should NOT have been called
    expect(simpleGit).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test: skips validation when setup phase failed
  // -----------------------------------------------------------------------
  it('skips validation when setup phase failed', async () => {
    // Make the setup step fail
    (mockHandler.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      output: 'setup failed',
      error: 'branch creation failed',
      duration: 0,
    });

    const workflow = createTestWorkflow();

    const result = await executor.execute(
      workflow,
      { mode: 'normal', cwd: '/repo' },
    );

    expect(result.status).toBe('failed');

    // simpleGit should NOT have been called (validation skipped)
    expect(simpleGit).not.toHaveBeenCalled();

    // Only setup phase should have executed (and failed)
    expect(result.phaseResults).toHaveLength(1);
    expect(result.phaseResults[0]!.status).toBe('failed');
  });

  // -----------------------------------------------------------------------
  // Test: error message contains useful context
  // -----------------------------------------------------------------------
  it('includes descriptive error message when branch validation fails', async () => {
    mockGit.revparse.mockResolvedValue('develop');
    mockGetDefaultBranch.mockResolvedValue('develop');

    const workflow = createTestWorkflow();
    const events: { type: string; message?: string }[] = [];

    executor.addEventListener((event) => {
      events.push({ type: event.type, message: event.message });
    });

    await executor.execute(
      workflow,
      { mode: 'normal', cwd: '/repo' },
    );

    // Check that an error event was emitted with the validation message
    const errorEvent = events.find(e => e.type === 'execution:error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain('Branch validation failed');
    expect(errorEvent!.message).toContain('develop');
  });

  // -----------------------------------------------------------------------
  // Test: non-setup phases don't trigger validation
  // -----------------------------------------------------------------------
  it('does not validate branch for non-setup phases', async () => {
    const workflow: ExecutableWorkflow = {
      name: 'test-workflow',
      phases: [
        {
          name: 'build',
          steps: [{ name: 'compile', action: 'shell', command: 'echo build' }],
        },
      ],
      env: {},
    };

    const result = await executor.execute(
      workflow,
      { mode: 'normal', cwd: '/repo' },
    );

    expect(result.status).toBe('completed');

    // simpleGit should NOT have been called (no setup phase)
    expect(simpleGit).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test: validation with 'main' as default branch
  // -----------------------------------------------------------------------
  it('aborts when on main branch (alternate default)', async () => {
    mockGit.revparse.mockResolvedValue('main');
    mockGetDefaultBranch.mockResolvedValue('main');

    const workflow = createTestWorkflow();

    const result = await executor.execute(
      workflow,
      { mode: 'normal', cwd: '/repo' },
    );

    expect(result.status).toBe('failed');
  });
});
