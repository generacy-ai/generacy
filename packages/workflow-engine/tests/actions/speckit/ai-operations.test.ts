/**
 * Tests for AI-dependent speckit operations (agent delegation)
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
  readDir: vi.fn(),
}));

describe('AI-Dependent Operations', () => {
  let mockContext: ActionContext;
  let mockLogger: Logger;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const mockStep: StepDefinition = {
      name: 'test-step',
      action: 'speckit.specify',
    };

    const mockPhase: PhaseDefinition = {
      name: 'test-phase',
      steps: [mockStep],
    };

    const mockWorkflow: ExecutableWorkflow = {
      name: 'test-workflow',
      phases: [mockPhase],
    };

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

    // Set up default mocks
    const { exists, readFile, writeFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValue('# Test Spec\n\n## Summary\nTest summary\n\n### US1: Test Story\n\n**As a** user\n\n| ID | Requirement |\n| FR-001 | Test |');
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeSpecify', () => {
    it('should invoke agent and generate spec', async () => {
      const { executeCommand, extractJSON } = await import('../../../src/actions/cli-utils.js');
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{"summary": "Spec generated"}',
        stderr: '',
      });
      vi.mocked(extractJSON).mockReturnValue({ summary: 'Spec generated' });

      const { executeSpecify } = await import('../../../src/actions/builtin/speckit/operations/specify.js');

      const result = await executeSpecify(
        {
          feature_dir: '/repo/specs/001-test',
          timeout: 60,
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.spec_file).toBe('/repo/specs/001-test/spec.md');
      expect(executeCommand).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', expect.any(String)]),
        expect.any(Object)
      );
    });

    it('should fail when agent returns non-zero exit code', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Error',
      });

      const { executeSpecify } = await import('../../../src/actions/builtin/speckit/operations/specify.js');

      const result = await executeSpecify(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.success).toBe(false);
    });

    it('should extract issue context when issue_url provided', async () => {
      const { executeCommand, extractJSON } = await import('../../../src/actions/cli-utils.js');
      vi.mocked(executeCommand)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '{"title": "Test Issue", "body": "Issue body"}',
          stderr: '',
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '{}',
          stderr: '',
        });
      vi.mocked(extractJSON)
        .mockReturnValueOnce({ title: 'Test Issue', body: 'Issue body' })
        .mockReturnValueOnce({});

      const { executeSpecify } = await import('../../../src/actions/builtin/speckit/operations/specify.js');

      await executeSpecify(
        {
          feature_dir: '/repo/specs/001-test',
          issue_url: 'https://github.com/owner/repo/issues/1',
        },
        mockContext
      );

      // Should call gh first to get issue context
      expect(executeCommand).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['issue', 'view']),
        expect.any(Object)
      );
    });
  });

  describe('executeClarify', () => {
    it('should generate clarification questions', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(readFile).mockResolvedValueOnce('# Spec content').mockResolvedValueOnce(`
# Clarification Questions

### Q1: Authentication Method
**Context**: Need to choose auth approach
**Question**: Which authentication method?
**Options**:
- A) OAuth: Use OAuth2
- B) JWT: Use JWT tokens
**Answer**:
`);

      const { executeClarify } = await import('../../../src/actions/builtin/speckit/operations/clarify.js');

      const result = await executeClarify(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.questions_count).toBe(1);
      expect(result.questions[0].topic).toBe('Authentication Method');
    });

    it('should post questions to GitHub issue when issue_number provided', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(readFile).mockResolvedValueOnce('# Spec content').mockResolvedValueOnce(`
# Clarification Questions

### Q1: Test Question
**Context**: Test context
**Question**: Test?
**Answer**:
`);

      const { executeClarify } = await import('../../../src/actions/builtin/speckit/operations/clarify.js');

      const result = await executeClarify(
        {
          feature_dir: '/repo/specs/001-test',
          issue_number: 123,
        },
        mockContext
      );

      expect(result.posted_to_issue).toBe(true);
      expect(executeCommand).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['issue', 'comment', '123']),
        expect.any(Object)
      );
    });
  });

  describe('executePlan', () => {
    it('should generate implementation plan', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile, readDir } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(readFile)
        .mockResolvedValueOnce('# Spec content')
        .mockResolvedValueOnce('# Clarifications')
        .mockResolvedValueOnce(`
# Implementation Plan

## Phase 1: Setup
## Phase 2: Core
## Phase 3: Testing

## Technologies
- TypeScript
- React
`);
      vi.mocked(readDir).mockResolvedValue([]);

      const { executePlan } = await import('../../../src/actions/builtin/speckit/operations/plan.js');

      const result = await executePlan(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.plan_file).toBe('/repo/specs/001-test/plan.md');
      expect(result.phases_count).toBe(3);
      expect(result.technologies).toContain('typescript');
    });
  });

  describe('executeTasks', () => {
    it('should generate task list', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(readFile)
        .mockResolvedValueOnce('# Spec content')
        .mockResolvedValueOnce('# Plan content')
        .mockResolvedValueOnce(`
# Tasks

## Phase 1: Setup

### T001 Create project structure
### T002 Add dependencies

## Phase 2: Core

### T003 [P] Implement feature A
### T004 [P] Implement feature B
`);

      const { executeTasks } = await import('../../../src/actions/builtin/speckit/operations/tasks.js');

      const result = await executeTasks(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.task_count).toBe(4);
      expect(result.phases).toContain('Setup');
      expect(result.phases).toContain('Core');
    });

    it('should estimate complexity based on task count', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(readFile)
        .mockResolvedValueOnce('# Spec')
        .mockResolvedValueOnce('# Plan')
        .mockResolvedValueOnce(`
# Tasks
## Phase 1: Only Phase
### T001 Simple task
### T002 Another task
`);

      const { executeTasks } = await import('../../../src/actions/builtin/speckit/operations/tasks.js');

      const result = await executeTasks(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.estimated_complexity).toBe('simple');
    });
  });

  describe('executeImplement', () => {
    it('should execute tasks and track progress', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile, writeFile, exists } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(readFile)
        .mockResolvedValueOnce(`
# Tasks

### T001 Setup task
**File**: \`src/index.ts\`
- Create file

### T002 Core task
**File**: \`src/core.ts\`
- Implement logic
`)
        .mockResolvedValueOnce('# Spec')
        .mockResolvedValueOnce('# Plan');
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

      const result = await executeImplement(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.tasks_completed).toBe(2);
      expect(result.tasks_total).toBe(2);
      expect(executeCommand).toHaveBeenCalledTimes(2);
    });

    it('should skip already completed tasks', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile, exists } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readFile)
        .mockResolvedValueOnce(`
# Tasks

- [X] T001 Completed task
**File**: \`src/done.ts\`

- [ ] T002 Pending task
**File**: \`src/todo.ts\`
`)
        .mockResolvedValueOnce('# Spec')
        .mockResolvedValueOnce('# Plan');
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });

      const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

      const result = await executeImplement(
        {
          feature_dir: '/repo/specs/001-test',
        },
        mockContext
      );

      expect(result.tasks_skipped).toBe(1);
      expect(result.tasks_completed).toBe(1);
      expect(executeCommand).toHaveBeenCalledTimes(1);
    });

    it('should filter tasks when task_filter provided', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');
      const { readFile, writeFile, exists } = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readFile)
        .mockResolvedValueOnce(`
# Tasks

### T001 Setup task
### T002 Core feature
### T003 Test task
`)
        .mockResolvedValueOnce('# Spec')
        .mockResolvedValueOnce('# Plan');
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(writeFile).mockResolvedValue(undefined);

      const { executeImplement } = await import('../../../src/actions/builtin/speckit/operations/implement.js');

      const result = await executeImplement(
        {
          feature_dir: '/repo/specs/001-test',
          task_filter: 'T00[12]',
        },
        mockContext
      );

      // Should only execute T001 and T002, not T003
      expect(executeCommand).toHaveBeenCalledTimes(2);
    });
  });
});
