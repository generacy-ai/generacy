/**
 * Integration tests for speckit workflow execution.
 * Tests the full flow of speckit actions through the action handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpecKitAction } from '../../../src/actions/builtin/speckit/index.js';
import type {
  ActionContext,
  Logger,
  StepDefinition,
  PhaseDefinition,
  ExecutableWorkflow,
} from '../../../src/types/index.js';

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
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  findRepoRoot: vi.fn(),
  resolveSpecsPath: vi.fn(),
  resolveTemplatesPath: vi.fn(),
  getFilesConfig: vi.fn(),
  isFile: vi.fn(),
  isDirectory: vi.fn(),
}));

// Mock simple-git
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    checkIsRepo: vi.fn().mockResolvedValue(true),
    revparse: vi.fn().mockResolvedValue('feature/001-test-feature'),
    branchLocal: vi.fn().mockResolvedValue({
      all: ['main', 'develop', 'feature/001-test-feature'],
      current: 'feature/001-test-feature',
    }),
    checkoutLocalBranch: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('Speckit Workflow Integration', () => {
  let action: SpecKitAction;
  let mockContext: ActionContext;
  let mockLogger: Logger;

  beforeEach(async () => {
    vi.clearAllMocks();

    action = new SpecKitAction();

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
    const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');
    vi.mocked(fsModule.exists).mockResolvedValue(true);
    vi.mocked(fsModule.readFile).mockResolvedValue('# Test Content');
    vi.mocked(fsModule.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsModule.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsModule.findRepoRoot).mockResolvedValue('/repo');
    vi.mocked(fsModule.resolveSpecsPath).mockResolvedValue('/repo/specs');
    vi.mocked(fsModule.resolveTemplatesPath).mockResolvedValue('/repo/templates');
    vi.mocked(fsModule.getFilesConfig).mockReturnValue({
      specs: 'specs',
      templates: 'templates',
      branchPattern: '{number}-{slug}',
    });
    vi.mocked(fsModule.readDir).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Full Workflow Simulation', () => {
    it('should execute create_feature followed by specify', async () => {
      const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');
      const { executeCommand, extractJSON } = await import('../../../src/actions/cli-utils.js');

      // Mock for create_feature
      vi.mocked(fsModule.exists).mockResolvedValue(false); // No existing branch

      // Step 1: create_feature
      const createFeatureStep: StepDefinition = {
        name: 'create-feature',
        uses: 'speckit.create_feature',
        with: {
          description: 'Test feature implementation',
        },
      };

      const createResult = await action.execute(createFeatureStep, mockContext);

      expect(createResult.success).toBe(true);
      expect(createResult.output).toHaveProperty('feature_dir');
      expect(createResult.output).toHaveProperty('branch_name');

      // Step 2: specify using the feature_dir from create_feature
      vi.mocked(fsModule.exists).mockResolvedValue(true);
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{"summary": "Generated spec"}',
        stderr: '',
      });
      vi.mocked(extractJSON).mockReturnValue({ summary: 'Generated spec' });

      const specifyStep: StepDefinition = {
        name: 'specify',
        uses: 'speckit.specify',
        with: {
          feature_dir: createResult.output.feature_dir,
        },
      };

      const specifyResult = await action.execute(specifyStep, mockContext);

      expect(specifyResult.success).toBe(true);
      expect(specifyResult.output).toHaveProperty('spec_file');
    });

    it('should execute full spec workflow: check_prereqs -> clarify -> plan -> tasks', async () => {
      const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');

      const featureDir = '/repo/specs/001-test';

      // Set up mock returns for the full workflow
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });

      // Set up prereq mocks
      vi.mocked(fsModule.findRepoRoot).mockResolvedValue('/repo');
      vi.mocked(fsModule.resolveSpecsPath).mockResolvedValue('/repo/specs');
      vi.mocked(fsModule.getFilesConfig).mockReturnValue({
        specs: 'specs',
        templates: 'templates',
        branchPattern: '{number}-{slug}',
        spec: 'spec.md',
        plan: 'plan.md',
        tasks: 'tasks.md',
        clarifications: 'clarifications.md',
        research: 'research.md',
        dataModel: 'data-model.md',
      });

      // Step 1: check_prereqs
      // Mock exists to return true for feature dir and spec.md
      vi.mocked(fsModule.exists).mockImplementation(async (path) => {
        if (typeof path === 'string') {
          return path.includes('spec.md') || path === featureDir || path.endsWith('001-test');
        }
        return false;
      });

      // Mock isFile to return true for spec.md
      vi.mocked(fsModule.isFile).mockImplementation(async (path) => {
        if (typeof path === 'string') {
          return path.includes('spec.md');
        }
        return false;
      });

      // Mock isDirectory for available docs check
      vi.mocked(fsModule.isDirectory).mockResolvedValue(false);
      vi.mocked(fsModule.readDir).mockResolvedValue([]);

      const checkPrereqsStep: StepDefinition = {
        name: 'check-prereqs',
        uses: 'speckit.check_prereqs',
        with: {
          branch: '001-test',
          require_spec: true,
        },
      };

      // Update context to use feature dir
      mockContext.workdir = featureDir;

      const prereqsResult = await action.execute(checkPrereqsStep, mockContext);
      expect(prereqsResult.success).toBe(true);

      // Step 2: clarify
      vi.mocked(fsModule.readFile)
        .mockResolvedValueOnce('# Spec content')
        .mockResolvedValueOnce(`
# Clarification Questions

### Q1: Test Topic
**Context**: Test context
**Question**: Test question?
**Answer**:
`);

      const clarifyStep: StepDefinition = {
        name: 'clarify',
        uses: 'speckit.clarify',
        with: {
          feature_dir: featureDir,
        },
      };

      const clarifyResult = await action.execute(clarifyStep, mockContext);
      expect(clarifyResult.success).toBe(true);
      expect(clarifyResult.output).toHaveProperty('questions_count');

      // Step 3: plan
      vi.mocked(fsModule.exists).mockResolvedValue(true);
      vi.mocked(fsModule.readFile)
        .mockResolvedValueOnce('# Spec')
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

      const planStep: StepDefinition = {
        name: 'plan',
        uses: 'speckit.plan',
        with: {
          feature_dir: featureDir,
        },
      };

      const planResult = await action.execute(planStep, mockContext);
      expect(planResult.success).toBe(true);
      expect(planResult.output).toHaveProperty('plan_file');
      expect(planResult.output).toHaveProperty('phases_count');

      // Step 4: tasks
      vi.mocked(fsModule.readFile)
        .mockResolvedValueOnce('# Spec')
        .mockResolvedValueOnce('# Plan')
        .mockResolvedValueOnce(`
# Tasks

## Phase 1: Setup

### T001 Create project structure
### T002 Add dependencies

## Phase 2: Core

### T003 [P] Implement feature A
### T004 [P] Implement feature B
`);

      const tasksStep: StepDefinition = {
        name: 'tasks',
        uses: 'speckit.tasks',
        with: {
          feature_dir: featureDir,
        },
      };

      const tasksResult = await action.execute(tasksStep, mockContext);
      expect(tasksResult.success).toBe(true);
      expect(tasksResult.output).toHaveProperty('task_count');
      expect(tasksResult.output).toHaveProperty('phases');
    });
  });

  describe('Error Handling in Workflow', () => {
    it('should propagate errors from failed operations', async () => {
      const { executeCommand } = await import('../../../src/actions/cli-utils.js');

      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Agent invocation failed',
      });

      const specifyStep: StepDefinition = {
        name: 'specify',
        uses: 'speckit.specify',
        with: {
          feature_dir: '/repo/specs/001-test',
        },
      };

      const result = await action.execute(specifyStep, mockContext);

      expect(result.success).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('Executing speckit.specify');
    });

    it('should handle validation errors before execution', async () => {
      const invalidStep: StepDefinition = {
        name: 'invalid-step',
        uses: 'speckit.specify',
        with: {}, // Missing feature_dir
      };

      const result = await action.execute(invalidStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('feature_dir');
    });
  });

  describe('Step Output Propagation', () => {
    it('should allow chaining step outputs between operations', async () => {
      const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');
      const { executeCommand, extractJSON } = await import('../../../src/actions/cli-utils.js');

      // Mock create_feature to return specific outputs
      vi.mocked(fsModule.exists).mockResolvedValue(false);

      const createStep: StepDefinition = {
        name: 'create-feature',
        uses: 'speckit.create_feature',
        with: {
          description: 'Test feature',
        },
      };

      const createResult = await action.execute(createStep, mockContext);
      expect(createResult.success).toBe(true);

      // Store output in stepOutputs (simulating executor behavior)
      mockContext.stepOutputs.set('create-feature', createResult.output);

      // Now specify should be able to reference the output
      vi.mocked(fsModule.exists).mockResolvedValue(true);
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(extractJSON).mockReturnValue({});

      const specifyStep: StepDefinition = {
        name: 'specify',
        uses: 'speckit.specify',
        with: {
          // In real workflow, this would be ${{ steps.create-feature.output.feature_dir }}
          feature_dir: createResult.output.feature_dir,
        },
      };

      const specifyResult = await action.execute(specifyStep, mockContext);
      expect(specifyResult.success).toBe(true);
    });
  });

  describe('Gate Configuration', () => {
    it('should handle steps with gate configuration', async () => {
      const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');
      const { executeCommand, extractJSON } = await import('../../../src/actions/cli-utils.js');

      vi.mocked(fsModule.exists).mockResolvedValue(true);
      vi.mocked(executeCommand).mockResolvedValue({
        exitCode: 0,
        stdout: '{}',
        stderr: '',
      });
      vi.mocked(extractJSON).mockReturnValue({});

      // Step with gate configuration
      const stepWithGate: StepDefinition = {
        name: 'specify-with-gate',
        uses: 'speckit.specify',
        with: {
          feature_dir: '/repo/specs/001-test',
        },
        gate: 'spec-review', // Gate for human review
      };

      // The action should execute regardless of gate (gate is handled by executor)
      const result = await action.execute(stepWithGate, mockContext);
      expect(result.success).toBe(true);

      // Gate configuration should be preserved on step
      expect(stepWithGate.gate).toBe('spec-review');
    });
  });

  describe('Operation Type Coverage', () => {
    it('should correctly identify all operation types', () => {
      const operations = [
        { uses: 'speckit.create_feature', expected: true },
        { uses: 'speckit.get_paths', expected: true },
        { uses: 'speckit.check_prereqs', expected: true },
        { uses: 'speckit.copy_template', expected: true },
        { uses: 'speckit.specify', expected: true },
        { uses: 'speckit.clarify', expected: true },
        { uses: 'speckit.plan', expected: true },
        { uses: 'speckit.tasks', expected: true },
        { uses: 'speckit.implement', expected: true },
        { uses: 'speckit/create_feature', expected: true }, // Slash notation
        { uses: 'speckit/specify', expected: true },
        { uses: 'agent.invoke', expected: false }, // Not speckit
        { uses: 'shell', expected: false },
        { uses: 'verification.check', expected: false },
      ];

      for (const { uses, expected } of operations) {
        const step: StepDefinition = {
          name: 'test',
          action: 'shell',
          uses,
        };
        expect(action.canHandle(step)).toBe(expected);
      }
    });
  });

  describe('Context Usage', () => {
    it('should use workdir from context when cwd not provided', async () => {
      const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      mockContext.workdir = '/custom/workdir';
      vi.mocked(fsModule.exists).mockResolvedValue(true);

      const getPathsStep: StepDefinition = {
        name: 'get-paths',
        uses: 'speckit.get_paths',
        // No cwd provided
      };

      await action.execute(getPathsStep, mockContext);

      // Verify that findRepoRoot was called with workdir context
      expect(fsModule.findRepoRoot).toHaveBeenCalled();
    });

    it('should pass logger to operation handlers', async () => {
      const fsModule = await import('../../../src/actions/builtin/speckit/lib/fs.js');

      vi.mocked(fsModule.exists).mockResolvedValue(true);

      const getPathsStep: StepDefinition = {
        name: 'get-paths',
        uses: 'speckit.get_paths',
      };

      await action.execute(getPathsStep, mockContext);

      // Logger should be used for operation logging
      expect(mockLogger.info).toHaveBeenCalled();
    });
  });
});
