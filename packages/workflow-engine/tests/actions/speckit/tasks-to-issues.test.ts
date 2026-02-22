/**
 * Tests for parseTasksFile() and executeTasksToIssues() — the task parser and
 * issue creation with idempotency for structured tasks.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseTasksFile, executeTasksToIssues } from '../../../src/actions/builtin/speckit/operations/tasks-to-issues.js';
import type { TasksToIssuesInput, ActionContext } from '../../../src/types/index.js';

// Mock cli-utils
vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: (output: string) => {
    try { return JSON.parse(output); } catch { return null; }
  },
}));

// Mock fs utilities
vi.mock('../../../src/actions/builtin/speckit/lib/fs.js', () => ({
  readFile: vi.fn(),
  exists: vi.fn(),
}));

// Import mocked modules for type-safe access
import { executeCommand } from '../../../src/actions/cli-utils.js';
import { readFile, exists } from '../../../src/actions/builtin/speckit/lib/fs.js';

const mockedExecuteCommand = vi.mocked(executeCommand);
const mockedReadFile = vi.mocked(readFile);
const mockedExists = vi.mocked(exists);

describe('parseTasksFile', () => {
  describe('empty / invalid input', () => {
    it('returns empty array for empty string', () => {
      expect(parseTasksFile('')).toEqual([]);
    });

    it('returns empty array for whitespace-only string', () => {
      expect(parseTasksFile('   \n  \n  ')).toEqual([]);
    });

    it('returns empty array for content with no task headings', () => {
      const content = `# Tasks

Some introductory text without any task headings.

## Phase 1: Setup

General phase description, but no actual tasks.
`;
      expect(parseTasksFile(content)).toEqual([]);
    });
  });

  describe('structured format with YAML frontmatter', () => {
    it('parses a single task with full frontmatter', () => {
      const content = `## Task 1
---
title: Implement user authentication
type: feature
labels: [auth, security]
---

Description of the authentication task...
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        task_id: 'T001',
        title: 'Implement user authentication',
        type: 'feature',
        labels: ['auth', 'security'],
        description: 'Description of the authentication task...',
      });
    });

    it('parses multiple tasks with frontmatter', () => {
      const content = `## Task 1
---
title: Implement user authentication
type: feature
labels: [auth, security]
---

Description of the authentication task...

## Task 2
---
title: Fix login redirect bug
type: bugfix
labels: [auth]
---

Description of the bug fix...
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(2);
      expect(result[0]!.task_id).toBe('T001');
      expect(result[0]!.title).toBe('Implement user authentication');
      expect(result[0]!.type).toBe('feature');
      expect(result[0]!.labels).toEqual(['auth', 'security']);

      expect(result[1]!.task_id).toBe('T002');
      expect(result[1]!.title).toBe('Fix login redirect bug');
      expect(result[1]!.type).toBe('bugfix');
      expect(result[1]!.labels).toEqual(['auth']);
    });

    it('parses task with only required title in frontmatter', () => {
      const content = `## Task 1
---
title: Simple task
---

A simple description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        task_id: 'T001',
        title: 'Simple task',
        description: 'A simple description.',
      });
      expect(result[0]!.type).toBeUndefined();
      expect(result[0]!.labels).toBeUndefined();
    });

    it('handles multiline description after frontmatter', () => {
      const content = `## Task 1
---
title: Complex task
type: feature
---

First paragraph of description.

Second paragraph with more details.

- Bullet point 1
- Bullet point 2
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.description).toBe(
        'First paragraph of description.\n\nSecond paragraph with more details.\n\n- Bullet point 1\n- Bullet point 2'
      );
    });

    it('handles ### TXXX heading format with frontmatter', () => {
      const content = `### T007 Define types for tasks-to-issues action
---
title: Define types
type: feature
labels: [types]
---

Add input/output types for the new action.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.task_id).toBe('T007');
      expect(result[0]!.title).toBe('Define types');
      expect(result[0]!.type).toBe('feature');
    });
  });

  describe('fallback format (no frontmatter)', () => {
    it('uses heading text as title when no frontmatter', () => {
      const content = `### T001 Implement user authentication

Description of the authentication task.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        task_id: 'T001',
        title: 'Implement user authentication',
        description: 'Description of the authentication task.',
      });
    });

    it('uses heading text as title for ## Task N format', () => {
      const content = `## Task 1 Setup database

Configure the database connection.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.task_id).toBe('T001');
      expect(result[0]!.title).toBe('Setup database');
    });

    it('parses multiple tasks without frontmatter', () => {
      const content = `### T001 First task

First task description.

### T002 Second task

Second task description.

### T003 Third task

Third task description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(3);
      expect(result[0]!.task_id).toBe('T001');
      expect(result[1]!.task_id).toBe('T002');
      expect(result[2]!.task_id).toBe('T003');
    });

    it('strips [DONE] and [P] markers from heading text', () => {
      const content = `### T001 [DONE] [P] Implement parser

Description text.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Implement parser');
    });

    it('generates fallback title when heading has no text', () => {
      const content = `### T001

Some description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Task T001');
    });
  });

  describe('malformed frontmatter', () => {
    it('falls back to heading text when frontmatter YAML is invalid', () => {
      const content = `## Task 1 Setup database
---
title: [invalid yaml: {{{{
---

Description text.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      // Should fall back to heading text
      expect(result[0]!.task_id).toBe('T001');
      expect(result[0]!.title).toBe('Setup database');
    });

    it('falls back when frontmatter has no closing delimiter', () => {
      const content = `### T001 My task
---
title: Incomplete frontmatter

Description continues here.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      // No closing ---, so no frontmatter detected
      expect(result[0]!.title).toBe('My task');
    });

    it('falls back when frontmatter title is missing', () => {
      const content = `## Task 1 Fallback title
---
type: feature
labels: [auth]
---

Description text.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Fallback title');
      // When fallback is used, frontmatter type/labels are not applied
      expect(result[0]!.type).toBeUndefined();
    });

    it('falls back when frontmatter title is empty string', () => {
      const content = `## Task 1 Heading title
---
title: ""
---

Description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Heading title');
    });

    it('ignores non-string labels in frontmatter', () => {
      const content = `## Task 1
---
title: My task
labels: [valid, 123, true]
---

Description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.labels).toEqual(['valid']);
    });
  });

  describe('mixed content with preamble', () => {
    it('ignores preamble text before first task', () => {
      const content = `# Tasks: Epic Processing Support

**Input**: Design documents from feature directory
**Status**: Ready

---

## Task 1
---
title: First task
---

Description of first task.

## Task 2
---
title: Second task
---

Description of second task.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(2);
      expect(result[0]!.task_id).toBe('T001');
      expect(result[1]!.task_id).toBe('T002');
    });

    it('handles tasks under phase headings', () => {
      const content = `# Tasks

## Phase 1: Setup

### T001 Setup project

Setup description.

### T002 Configure database

Database description.

## Phase 2: Implementation

### T003 Implement feature

Feature description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(3);
      expect(result[0]!.task_id).toBe('T001');
      expect(result[1]!.task_id).toBe('T002');
      expect(result[2]!.task_id).toBe('T003');
    });

    it('handles body with File markers and subtask lists', () => {
      const content = `### T008 Implement task parser for structured tasks.md
**File**: \`packages/workflow-engine/src/actions/builtin/speckit/operations/tasks-to-issues.ts\` (new)
- Implement \`parseTasksFile(content: string): ParsedTask[]\`
- Support structured format
- Parse \`title\` (required), \`type\` (optional), \`labels\` (optional)
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.task_id).toBe('T008');
      expect(result[0]!.title).toBe('Implement task parser for structured tasks.md');
      expect(result[0]!.description).toContain('parseTasksFile');
    });
  });

  describe('edge cases', () => {
    it('handles task with empty description', () => {
      const content = `## Task 1
---
title: Task with no description
---
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Task with no description');
      expect(result[0]!.description).toBe('');
    });

    it('handles body text between heading and frontmatter delimiter', () => {
      const content = `### T001 Fallback title
Some text before the delimiter that prevents frontmatter detection
---
title: Should not be parsed as frontmatter
---

Description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      // Text before --- means no frontmatter, falls back
      expect(result[0]!.title).toBe('Fallback title');
    });

    it('handles large task IDs', () => {
      const content = `### T1234 Large task ID

Description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(1);
      expect(result[0]!.task_id).toBe('T1234');
    });

    it('correctly separates description between consecutive tasks', () => {
      const content = `### T001 First task

First description line 1.
First description line 2.

### T002 Second task

Second description.
`;
      const result = parseTasksFile(content);

      expect(result).toHaveLength(2);
      expect(result[0]!.description).toBe('First description line 1.\nFirst description line 2.');
      expect(result[1]!.description).toBe('Second description.');
    });
  });
});

// =============================================================================
// executeTasksToIssues tests
// =============================================================================

function createMockContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    workflow: {} as ActionContext['workflow'],
    phase: {} as ActionContext['phase'],
    step: {} as ActionContext['step'],
    inputs: {},
    stepOutputs: new Map(),
    env: {},
    workdir: '/test/repo',
    signal: new AbortController().signal,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

function createInput(overrides?: Partial<TasksToIssuesInput>): TasksToIssuesInput {
  return {
    feature_dir: '/test/repo/specs/100-my-epic',
    epic_issue_number: 42,
    epic_branch: '42-my-epic',
    ...overrides,
  };
}

describe('executeTasksToIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('file handling', () => {
    it('returns empty result when tasks.md does not exist', async () => {
      mockedExists.mockResolvedValue(false);
      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      expect(result).toEqual({
        created_issues: [],
        skipped_issues: [],
        failed_tasks: [],
        total_tasks: 0,
      });
      expect(context.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tasks.md not found'),
      );
    });

    it('returns empty result when tasks.md has no parseable tasks', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue('# Tasks\n\nNo actual task headings here.\n');
      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      expect(result).toEqual({
        created_issues: [],
        skipped_issues: [],
        failed_tasks: [],
        total_tasks: 0,
      });
      expect(context.logger.info).toHaveBeenCalledWith('No tasks found in tasks.md');
    });
  });

  describe('issue creation', () => {
    it('creates issues with correct labels and body', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`### T001 Implement authentication

Add user login flow.

### T002 Add API routes

Create REST endpoints.
`);
      // Mock search: no existing issues found
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          // Extract title to determine which issue
          const titleIdx = args.indexOf('--title');
          const title = titleIdx >= 0 ? args[titleIdx + 1] : '';
          const issueNum = title === 'Implement authentication' ? 101 : 102;
          return {
            exitCode: 0,
            stdout: `https://github.com/owner/repo/issues/${issueNum}\n`,
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected call' };
      });

      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      expect(result.total_tasks).toBe(2);
      expect(result.created_issues).toHaveLength(2);
      expect(result.created_issues[0]).toEqual({
        issue_number: 101,
        title: 'Implement authentication',
        task_id: 'T001',
      });
      expect(result.created_issues[1]).toEqual({
        issue_number: 102,
        title: 'Add API routes',
        task_id: 'T002',
      });
      expect(result.skipped_issues).toHaveLength(0);
      expect(result.failed_tasks).toHaveLength(0);

      // Verify gh issue create calls include correct labels
      const createCalls = mockedExecuteCommand.mock.calls.filter(
        ([, args]) => args[0] === 'issue' && args[1] === 'create',
      );
      expect(createCalls).toHaveLength(2);

      // Check first create call includes epic-child and trigger label
      const firstCreateArgs = createCalls[0]![1];
      expect(firstCreateArgs).toContain('--label');
      expect(firstCreateArgs).toContain('epic-child');
      expect(firstCreateArgs).toContain('process:speckit-feature');

      // Check body contains epic-parent marker
      const bodyIdx = firstCreateArgs.indexOf('--body');
      const body = firstCreateArgs[bodyIdx + 1] as string;
      expect(body).toContain('epic-parent: #42');
      expect(body).toContain('task: T001');
      expect(body).toContain('epic-branch: 42-my-epic');
    });

    it('uses custom trigger label when provided', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`### T001 My task

Description.
`);
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/o/r/issues/50\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      const context = createMockContext();
      const input = createInput({ trigger_label: 'process:speckit-bugfix' });

      await executeTasksToIssues(input, context);

      const createCalls = mockedExecuteCommand.mock.calls.filter(
        ([, args]) => args[0] === 'issue' && args[1] === 'create',
      );
      expect(createCalls).toHaveLength(1);
      const createArgs = createCalls[0]![1];
      expect(createArgs).toContain('process:speckit-bugfix');
      expect(createArgs).not.toContain('process:speckit-feature');
    });

    it('includes task-specific type and labels', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`## Task 1
---
title: Auth feature
type: feature
labels: [auth, security]
---

Description.
`);
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/o/r/issues/60\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      const context = createMockContext();
      const input = createInput();

      await executeTasksToIssues(input, context);

      const createCalls = mockedExecuteCommand.mock.calls.filter(
        ([, args]) => args[0] === 'issue' && args[1] === 'create',
      );
      const createArgs = createCalls[0]![1];
      expect(createArgs).toContain('epic-child');
      expect(createArgs).toContain('process:speckit-feature');
      expect(createArgs).toContain('type:feature');
      expect(createArgs).toContain('auth');
      expect(createArgs).toContain('security');
    });
  });

  describe('idempotency', () => {
    it('skips tasks that already have existing child issues', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`### T001 Already exists

Description.

### T002 New task

Description.
`);
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          const searchArg = args.find((a: string) => typeof a === 'string' && a.includes('task: T001'));
          if (searchArg) {
            // T001 already exists
            return {
              exitCode: 0,
              stdout: JSON.stringify([{ number: 99, title: 'Already exists' }]),
              stderr: '',
            };
          }
          // T002 doesn't exist
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/o/r/issues/100\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      expect(result.total_tasks).toBe(2);
      expect(result.skipped_issues).toHaveLength(1);
      expect(result.skipped_issues[0]).toEqual({
        issue_number: 99,
        title: 'Already exists',
        task_id: 'T001',
      });
      expect(result.created_issues).toHaveLength(1);
      expect(result.created_issues[0]!.task_id).toBe('T002');
    });

    it('skips all tasks when all already exist', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`### T001 First

Desc.

### T002 Second

Desc.
`);
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          const searchArg = args.find((a: string) => typeof a === 'string' && a.includes('task: T001'));
          if (searchArg) {
            return { exitCode: 0, stdout: JSON.stringify([{ number: 10, title: 'First' }]), stderr: '' };
          }
          return { exitCode: 0, stdout: JSON.stringify([{ number: 11, title: 'Second' }]), stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'should not be called' };
      });

      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      expect(result.total_tasks).toBe(2);
      expect(result.skipped_issues).toHaveLength(2);
      expect(result.created_issues).toHaveLength(0);
      expect(result.failed_tasks).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('reports failed tasks without stopping other task processing', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`### T001 Will fail

Desc.

### T002 Will succeed

Desc.

### T003 Will also fail

Desc.
`);
      let createCallCount = 0;
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          createCallCount++;
          if (createCallCount === 1) {
            return { exitCode: 1, stdout: '', stderr: 'rate limit exceeded' };
          }
          if (createCallCount === 2) {
            return { exitCode: 0, stdout: 'https://github.com/o/r/issues/200\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'server error' };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      expect(result.total_tasks).toBe(3);
      expect(result.created_issues).toHaveLength(1);
      expect(result.created_issues[0]!.task_id).toBe('T002');
      expect(result.failed_tasks).toHaveLength(2);
      expect(result.failed_tasks[0]!.task_id).toBe('T001');
      expect(result.failed_tasks[0]!.reason).toContain('rate limit exceeded');
      expect(result.failed_tasks[1]!.task_id).toBe('T003');
      expect(result.failed_tasks[1]!.reason).toContain('server error');
    });

    it('handles search failure gracefully and attempts creation', async () => {
      mockedExists.mockResolvedValue(true);
      mockedReadFile.mockResolvedValue(`### T001 My task

Description.
`);
      mockedExecuteCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          // Search fails — should not prevent creation attempt
          return { exitCode: 1, stdout: '', stderr: 'search failed' };
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/o/r/issues/300\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      const context = createMockContext();
      const input = createInput();

      const result = await executeTasksToIssues(input, context);

      // When search fails (returns null), it should proceed to create
      expect(result.created_issues).toHaveLength(1);
      expect(result.created_issues[0]!.issue_number).toBe(300);
    });
  });
});
