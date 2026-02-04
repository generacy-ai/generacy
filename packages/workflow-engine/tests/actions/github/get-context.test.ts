/**
 * Tests for github.get_context action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GetContextAction } from '../../../src/actions/github/get-context.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { existsSync, readFileSync, readdirSync } from 'node:fs';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

// Helper to create mock context
function createMockContext(inputs: Record<string, unknown> = {}): ActionContext {
  return {
    workdir: '/test/workdir',
    inputs,
    outputs: {},
    env: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    signal: new AbortController().signal,
    refs: {},
  };
}

// Helper to create step definition
function createStep(inputs: Record<string, unknown> = {}): StepDefinition {
  return {
    name: 'test-step',
    uses: 'github.get_context',
    with: inputs,
  };
}

describe('GetContextAction', () => {
  let action: GetContextAction;

  beforeEach(() => {
    action = new GetContextAction();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.get_context action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.preflight',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires issue_number input', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('returns error when no spec directory found', async () => {
      mockExistsSync.mockReturnValue(false);

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No spec directory found');
    });

    it('loads spec artifacts successfully', async () => {
      // Setup mocks for existing files
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('specs')) return true;
        if (p.includes('123-feature')) return true;
        if (p.endsWith('spec.md')) return true;
        if (p.endsWith('plan.md')) return true;
        if (p.endsWith('tasks.md')) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['123-feature'] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('spec.md')) return '# Spec content';
        if (p.endsWith('plan.md')) return '# Plan content';
        if (p.endsWith('tasks.md')) return '- [ ] Task 1\n- [ ] Task 2';
        return '';
      });

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.spec).toBe('# Spec content');
      expect(output.plan).toBe('# Plan content');
      expect(output.tasks).toContain('Task 1');
      expect(output.phase).toBe('implement');
    });

    it('determines phase as specify when no plan exists', async () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('specs')) return true;
        if (p.includes('123-feature')) return true;
        if (p.endsWith('spec.md')) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['123-feature'] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('spec.md')) return '# Spec content';
        return '';
      });

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect((result.output as Record<string, unknown>).phase).toBe('plan');
    });

    it('determines phase as validate when all tasks complete', async () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('specs')) return true;
        if (p.includes('123-feature')) return true;
        if (p.endsWith('spec.md') || p.endsWith('plan.md') || p.endsWith('tasks.md')) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['123-feature'] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('tasks.md')) return '- [x] Task 1\n- [x] Task 2';
        return '# Content';
      });

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect((result.output as Record<string, unknown>).phase).toBe('validate');
    });

    it('loads epic parent context when parent_epic_number provided', async () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('specs')) return true;
        if (p.includes('456-child') || p.includes('123-epic')) return true;
        if (p.endsWith('spec.md') || p.endsWith('plan.md') || p.endsWith('tasks.md')) return true;
        return false;
      });
      mockReaddirSync.mockImplementation((path: unknown) => {
        return ['123-epic', '456-child'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.includes('123-epic')) {
          if (p.endsWith('spec.md')) return '# Epic Spec';
          if (p.endsWith('plan.md')) return '# Epic Plan';
          if (p.endsWith('tasks.md')) return '# Epic Tasks';
        }
        if (p.includes('456-child')) {
          if (p.endsWith('spec.md')) return '# Child Spec';
          if (p.endsWith('plan.md')) return '# Child Plan';
          if (p.endsWith('tasks.md')) return '- [ ] Child Task';
        }
        return '';
      });

      const step = createStep({
        issue_number: 456,
        parent_epic_number: 123,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.spec).toBe('# Child Spec');
      const epicContext = output.epic_context as Record<string, unknown>;
      expect(epicContext.parent_spec).toBe('# Epic Spec');
      expect(epicContext.parent_plan).toBe('# Epic Plan');
    });

    it('handles missing artifacts gracefully', async () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        // specs directory exists
        if (p.endsWith('specs')) return true;
        // feature directory exists (not ending in .md)
        if (p.includes('123-feature') && !p.endsWith('.md')) return true;
        // Only spec.md exists, not plan.md or tasks.md
        if (p.endsWith('spec.md')) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['123-feature'] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.endsWith('spec.md')) return '# Spec content';
        throw new Error(`ENOENT: no such file or directory`);
      });

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.spec).toBe('# Spec content');
      expect(output.plan).toBeUndefined();
      expect(output.tasks).toBeUndefined();
    });
  });
});
