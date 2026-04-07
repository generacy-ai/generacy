/**
 * Unit tests for the implement operation's increment counter logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActionContext, Logger, StepDefinition, PhaseDefinition, ExecutableWorkflow } from '../../../src/types/index.js';

// Mock CLI utilities
vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  extractJSON: vi.fn(),
}));

// Mock fs module
vi.mock('../../../src/actions/builtin/speckit/lib/fs.js', () => ({
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock stream-batcher (used internally by implement)
vi.mock('../../../src/actions/builtin/speckit/lib/stream-batcher.js', () => ({
  StreamBatcher: vi.fn().mockImplementation((cb: (s: string) => void) => ({
    append: vi.fn(),
    flush: vi.fn(),
  })),
}));

/** Build a simple tasks.md with N pending tasks */
function buildTasksMd(taskCount: number, completedCount = 0): string {
  const lines = ['# Tasks\n'];
  for (let i = 1; i <= taskCount; i++) {
    const done = i <= completedCount ? 'X' : ' ';
    lines.push(`- [${done}] T${String(i).padStart(3, '0')} [US1] Task number ${i}`);
  }
  return lines.join('\n');
}

describe('executeImplement — increment boundary logic', () => {
  let mockContext: ActionContext;
  let mockLogger: Logger;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;

    const mockStep: StepDefinition = { name: 'test-step', action: 'speckit.implement' };
    const mockPhase: PhaseDefinition = { name: 'test-phase', steps: [mockStep] };
    const mockWorkflow: ExecutableWorkflow = { name: 'test-workflow', phases: [mockPhase] };

    mockContext = {
      workflow: mockWorkflow,
      phase: mockPhase,
      step: mockStep,
      inputs: {},
      stepOutputs: new Map(),
      env: {},
      workdir: '/repo',
      signal: new AbortController().signal,
      logger: mockLogger,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns partial: true when increment limit is reached before all tasks complete', async () => {
    const { executeCommand } = await import('../../../src/actions/cli-utils.js');
    const { exists, readFile, writeFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

    // 5 tasks, limit of 2 — should complete 2 then return partial
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValue(buildTasksMd(5));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    // git rev-parse returns repo root
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/repo\n', stderr: '' }) // git rev-parse
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }); // all subsequent git/claude calls

    const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

    const result = await executeImplement(
      { feature_dir: '/repo/specs/001-test', max_tasks_per_increment: 2 },
      mockContext,
    );

    expect(result.partial).toBe(true);
    expect(result.tasks_completed).toBe(2);
    expect(result.tasks_remaining).toBe(3);
    expect(result.tasks_total).toBe(5);
    expect(result.success).toBe(true);
  });

  it('does not return partial when all tasks complete within the limit', async () => {
    const { executeCommand } = await import('../../../src/actions/cli-utils.js');
    const { exists, readFile, writeFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

    // 3 tasks, limit of 10 — should complete all without partial
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValue(buildTasksMd(3));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/repo\n', stderr: '' }) // git rev-parse
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

    const result = await executeImplement(
      { feature_dir: '/repo/specs/001-test', max_tasks_per_increment: 10 },
      mockContext,
    );

    expect(result.partial).toBeUndefined();
    expect(result.tasks_completed).toBe(3);
    expect(result.tasks_remaining).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('counter increments per completed task and stops at limit', async () => {
    const { executeCommand } = await import('../../../src/actions/cli-utils.js');
    const { exists, readFile, writeFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

    // 4 tasks, limit of 1 — should complete exactly 1 then return partial
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValue(buildTasksMd(4));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/repo\n', stderr: '' }) // git rev-parse
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

    const result = await executeImplement(
      { feature_dir: '/repo/specs/001-test', max_tasks_per_increment: 1 },
      mockContext,
    );

    expect(result.partial).toBe(true);
    expect(result.tasks_completed).toBe(1);
    expect(result.tasks_remaining).toBe(3);
  });

  it('uses default limit of 10 when max_tasks_per_increment is not specified', async () => {
    const { executeCommand } = await import('../../../src/actions/cli-utils.js');
    const { exists, readFile, writeFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

    // 8 tasks, no limit specified (default 10) — all should complete
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValue(buildTasksMd(8));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/repo\n', stderr: '' })
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

    const result = await executeImplement(
      { feature_dir: '/repo/specs/001-test' },
      mockContext,
    );

    expect(result.partial).toBeUndefined();
    expect(result.tasks_completed).toBe(8);
  });

  it('skips already-completed tasks and counts only newly completed toward limit', async () => {
    const { executeCommand } = await import('../../../src/actions/cli-utils.js');
    const { exists, readFile, writeFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

    // 5 tasks, first 3 already done, limit of 1 — should complete 1 new task then return partial
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValue(buildTasksMd(5, 3));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/repo\n', stderr: '' })
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

    const result = await executeImplement(
      { feature_dir: '/repo/specs/001-test', max_tasks_per_increment: 1 },
      mockContext,
    );

    expect(result.partial).toBe(true);
    expect(result.tasks_completed).toBe(1); // Only newly completed in this increment
    expect(result.tasks_remaining).toBe(1); // 1 task still pending (T005)
    expect(result.tasks_skipped).toBe(3);   // The 3 already-done tasks
  });
});
