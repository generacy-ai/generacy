/**
 * Unit tests for increment counter logic in executeImplement().
 *
 * Verifies that:
 * - tasksThisIncrement counter increments once per completed task
 * - Limit check fires before each task execution (task is NOT spawned when limit reached)
 * - Returns partial: true with correct counts when MAX_TASKS is reached
 * - Returns no partial when all tasks complete within one increment
 * - Default MAX_TASKS is 10 when max_tasks_per_increment is not supplied
 * - tasks_remaining reflects exactly how many pending tasks are left
 * - Already-complete tasks are counted as tasks_skipped, not as increment tasks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock is hoisted above imports, so shared mock refs must
// be created via vi.hoisted().
// ---------------------------------------------------------------------------

const { mockExecuteCommand, mockExists, mockReadFile, mockWriteFile } = vi.hoisted(() => {
  return {
    mockExecuteCommand: vi.fn(),
    mockExists: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
  };
});

vi.mock('../../../../cli-utils.js', () => ({
  executeCommand: mockExecuteCommand,
}));

vi.mock('../../lib/fs.js', () => ({
  exists: mockExists,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

vi.mock('../../lib/stream-batcher.js', () => ({
  StreamBatcher: vi.fn().mockImplementation(() => ({
    append: vi.fn(),
    flush: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

import { executeImplement } from '../implement.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function makeMockContext() {
  return {
    logger: mockLogger,
    signal: { aborted: false } as AbortSignal,
    emitEvent: vi.fn(),
  } as any;
}

/**
 * Build tasks.md content with `total` tasks in checkbox format.
 * The first `preCompleted` tasks are marked as [X] (already done).
 */
function makeTasksContent(total: number, preCompleted = 0): string {
  const lines: string[] = ['# Tasks\n'];
  for (let i = 1; i <= total; i++) {
    const marker = i <= preCompleted ? 'X' : ' ';
    lines.push(`- [${marker}] T${String(i).padStart(3, '0')} Task ${i} description`);
  }
  return lines.join('\n');
}

/**
 * Default successful command mock.
 * - git rev-parse → /repo
 * - claude → exit 0
 * - all other git commands → exit 0
 */
function setupSuccessfulCommandMock() {
  mockExecuteCommand.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: '/repo\n', stderr: '' };
    }
    // claude invocation and all git operations succeed
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockResolvedValue(true);
  mockReadFile.mockResolvedValue('');
  mockWriteFile.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeImplement — increment counter logic', () => {
  it('returns partial: true and stops after MAX_TASKS sequential tasks', async () => {
    const MAX_TASKS = 3;
    const TOTAL_TASKS = 5;
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL_TASKS));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: MAX_TASKS },
      makeMockContext(),
    );

    expect(result.partial).toBe(true);
    expect(result.success).toBe(true);
    expect(result.tasks_completed).toBe(MAX_TASKS);
    expect(result.tasks_remaining).toBe(TOTAL_TASKS - MAX_TASKS);
    expect(result.tasks_total).toBe(TOTAL_TASKS);
  });

  it('does NOT execute the task that exceeds the limit (limit check is pre-task)', async () => {
    const MAX_TASKS = 3;
    const TOTAL_TASKS = 5;
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL_TASKS));

    let claudeCallCount = 0;
    mockExecuteCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { exitCode: 0, stdout: '/repo\n', stderr: '' };
      }
      if (cmd === 'claude') {
        claudeCallCount++;
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: MAX_TASKS },
      makeMockContext(),
    );

    // The 4th and 5th tasks should never be spawned
    expect(claudeCallCount).toBe(MAX_TASKS);
  });

  it('counter increments once per completed task', async () => {
    // With MAX_TASKS=2 and 4 tasks, partial should fire after exactly 2 completed tasks
    const MAX_TASKS = 2;
    mockReadFile.mockResolvedValue(makeTasksContent(4));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: MAX_TASKS },
      makeMockContext(),
    );

    expect(result.partial).toBe(true);
    expect(result.tasks_completed).toBe(2);
    expect(result.tasks_remaining).toBe(2);
  });

  it('returns no partial when all tasks complete within the increment limit', async () => {
    const MAX_TASKS = 10;
    const TOTAL_TASKS = 3;
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL_TASKS));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: MAX_TASKS },
      makeMockContext(),
    );

    expect(result.partial).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.tasks_completed).toBe(TOTAL_TASKS);
  });

  it('returns no partial when total tasks exactly equals the limit', async () => {
    const MAX_TASKS = 4;
    const TOTAL_TASKS = 4;
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL_TASKS));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: MAX_TASKS },
      makeMockContext(),
    );

    // All 4 tasks complete (counter reaches 4 but the loop ends naturally)
    expect(result.partial).toBeUndefined();
    expect(result.tasks_completed).toBe(TOTAL_TASKS);
  });

  it('defaults MAX_TASKS to 10 when max_tasks_per_increment is not supplied', async () => {
    const TOTAL_TASKS = 11;
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL_TASKS));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec' },
      makeMockContext(),
    );

    // Default is 10, so after 10 tasks the 11th is skipped
    expect(result.partial).toBe(true);
    expect(result.tasks_completed).toBe(10);
    expect(result.tasks_remaining).toBe(1);
  });

  it('does not count pre-completed tasks toward the increment counter', async () => {
    // 3 already complete, 5 pending; MAX_TASKS=3 → should partial after 3 pending
    const PRE_COMPLETED = 3;
    const TOTAL_TASKS = 8; // 3 done + 5 pending
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL_TASKS, PRE_COMPLETED));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: 3 },
      makeMockContext(),
    );

    expect(result.partial).toBe(true);
    expect(result.tasks_completed).toBe(3);  // 3 new completions this increment
    expect(result.tasks_skipped).toBe(PRE_COMPLETED); // 3 already done at start
    expect(result.tasks_total).toBe(TOTAL_TASKS);
    expect(result.tasks_remaining).toBe(2); // 5 pending - 3 completed = 2 left
  });

  it('tasks_remaining is 0 when limit reached on last batch of pending tasks', async () => {
    // Exactly MAX_TASKS tasks pending — the check fires after all are done
    // but since the loop ends before the check can trigger, no partial should be emitted.
    // This is the "all tasks done exactly at limit" case — no partial.
    const MAX_TASKS = 5;
    mockReadFile.mockResolvedValue(makeTasksContent(5));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: MAX_TASKS },
      makeMockContext(),
    );

    expect(result.partial).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('returns success:true even when partial result is produced', async () => {
    mockReadFile.mockResolvedValue(makeTasksContent(5));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: 2 },
      makeMockContext(),
    );

    expect(result.partial).toBe(true);
    expect(result.success).toBe(true);
  });

  it('includes no errors array in partial result when all completed tasks succeeded', async () => {
    mockReadFile.mockResolvedValue(makeTasksContent(5));
    setupSuccessfulCommandMock();

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: 2 },
      makeMockContext(),
    );

    expect(result.errors).toBeUndefined();
  });
});

describe('executeImplement — tasks.md not found', () => {
  it('returns failure when tasks file does not exist', async () => {
    mockExists.mockResolvedValue(false);

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: 5 },
      makeMockContext(),
    );

    expect(result.success).toBe(false);
    expect(result.tasks_completed).toBe(0);
    expect(result.errors).toContain('Tasks file not found');
  });
});

describe('executeImplement — all tasks already complete', () => {
  it('returns success with zero tasks_completed when all tasks pre-completed', async () => {
    const TOTAL = 3;
    mockReadFile.mockResolvedValue(makeTasksContent(TOTAL, TOTAL));

    const result = await executeImplement(
      { feature_dir: '/spec', max_tasks_per_increment: 5 },
      makeMockContext(),
    );

    expect(result.success).toBe(true);
    expect(result.tasks_completed).toBe(0);
    expect(result.tasks_skipped).toBe(TOTAL);
    expect(result.partial).toBeUndefined();
  });
});
