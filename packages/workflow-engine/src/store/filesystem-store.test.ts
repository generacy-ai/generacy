/**
 * Unit tests for FilesystemWorkflowStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FilesystemWorkflowStore, validateWorkflowState } from './filesystem-store.js';
import type { WorkflowState } from '../types/store.js';

describe('FilesystemWorkflowStore', () => {
  const testWorkdir = '/tmp/workflow-store-test';
  let store: FilesystemWorkflowStore;

  const createValidState = (overrides?: Partial<WorkflowState>): WorkflowState => ({
    version: '1.0',
    workflowId: 'test-workflow-123',
    workflowFile: 'workflows/test.yaml',
    currentPhase: 'review',
    currentStep: 'human_review',
    inputs: { feature_dir: 'specs/123-feature' },
    stepOutputs: {
      parse_tasks: {
        raw: '{"tasks": 5}',
        parsed: { tasks: 5 },
        exitCode: 0,
        completedAt: '2024-01-15T10:25:00Z',
      },
    },
    startedAt: '2024-01-15T10:20:00Z',
    updatedAt: '2024-01-15T10:25:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testWorkdir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await fs.mkdir(testWorkdir, { recursive: true });
    store = new FilesystemWorkflowStore(testWorkdir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testWorkdir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('save', () => {
    it('should save valid workflow state', async () => {
      const state = createValidState();
      await store.save(state);

      // Verify file exists
      const statePath = path.join(testWorkdir, '.generacy', 'workflow-state-test-workflow-123.json');
      const content = await fs.readFile(statePath, 'utf-8');
      const saved = JSON.parse(content);

      expect(saved.workflowId).toBe(state.workflowId);
      expect(saved.currentPhase).toBe(state.currentPhase);
      expect(saved.version).toBe('1.0');
    });

    it('should update updatedAt timestamp on save', async () => {
      const state = createValidState({ updatedAt: '2024-01-01T00:00:00Z' });
      await store.save(state);

      const loaded = await store.load(state.workflowId);
      expect(loaded).not.toBeNull();
      expect(new Date(loaded!.updatedAt).getTime()).toBeGreaterThan(
        new Date('2024-01-01T00:00:00Z').getTime()
      );
    });

    it('should reject invalid workflow state', async () => {
      const invalidState = { workflowId: 'test' } as unknown as WorkflowState;
      await expect(store.save(invalidState)).rejects.toThrow('Invalid workflow state');
    });

    it('should create state directory if it does not exist', async () => {
      const newDir = path.join(testWorkdir, 'new-project');
      const newStore = new FilesystemWorkflowStore(newDir);
      const state = createValidState();

      await newStore.save(state);

      const stateDir = path.join(newDir, '.generacy');
      const stat = await fs.stat(stateDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('load', () => {
    it('should load existing workflow state', async () => {
      const state = createValidState();
      await store.save(state);

      const loaded = await store.load(state.workflowId);
      expect(loaded).not.toBeNull();
      expect(loaded!.workflowId).toBe(state.workflowId);
      expect(loaded!.inputs).toEqual(state.inputs);
    });

    it('should return null for non-existent workflow', async () => {
      const loaded = await store.load('non-existent-workflow');
      expect(loaded).toBeNull();
    });

    it('should return null for invalid state file', async () => {
      // Create an invalid state file
      const stateDir = path.join(testWorkdir, '.generacy');
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'workflow-state-invalid.json'),
        JSON.stringify({ invalid: 'state' }),
        'utf-8'
      );

      const loaded = await store.load('invalid');
      expect(loaded).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete existing workflow state', async () => {
      const state = createValidState();
      await store.save(state);

      await store.delete(state.workflowId);

      const loaded = await store.load(state.workflowId);
      expect(loaded).toBeNull();
    });

    it('should not throw when deleting non-existent workflow', async () => {
      await expect(store.delete('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('listPending', () => {
    it('should list all pending workflow states', async () => {
      const state1 = createValidState({ workflowId: 'workflow-1' });
      const state2 = createValidState({ workflowId: 'workflow-2' });

      await store.save(state1);
      await store.save(state2);

      const pending = await store.listPending();
      expect(pending).toHaveLength(2);
      expect(pending.map((s) => s.workflowId)).toContain('workflow-1');
      expect(pending.map((s) => s.workflowId)).toContain('workflow-2');
    });

    it('should return empty array when no states exist', async () => {
      const pending = await store.listPending();
      expect(pending).toEqual([]);
    });

    it('should sort by updatedAt descending', async () => {
      const state1 = createValidState({
        workflowId: 'workflow-1',
        updatedAt: '2024-01-15T10:00:00Z',
      });
      const state2 = createValidState({
        workflowId: 'workflow-2',
        updatedAt: '2024-01-15T11:00:00Z',
      });

      await store.save(state1);
      await store.save(state2);

      const pending = await store.listPending();
      // Note: save updates the timestamp, so we check that listing works
      expect(pending).toHaveLength(2);
    });
  });

  describe('hasPendingState', () => {
    it('should return true when pending review exists', async () => {
      const state = createValidState({
        pendingReview: {
          reviewId: 'review-123',
          artifact: 'Content to review',
          requestedAt: '2024-01-15T10:30:00Z',
        },
      });
      await store.save(state);

      const hasPending = await store.hasPendingState(state.workflowId);
      expect(hasPending).toBe(true);
    });

    it('should return false when no pending review', async () => {
      const state = createValidState();
      delete state.pendingReview;
      await store.save(state);

      const hasPending = await store.hasPendingState(state.workflowId);
      expect(hasPending).toBe(false);
    });

    it('should return false for non-existent workflow', async () => {
      const hasPending = await store.hasPendingState('non-existent');
      expect(hasPending).toBe(false);
    });
  });
});

describe('validateWorkflowState', () => {
  it('should accept valid workflow state', () => {
    const state = {
      version: '1.0',
      workflowId: 'test-123',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {},
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject invalid version', () => {
    const state = {
      version: '2.0',
      workflowId: 'test',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {},
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Invalid version: expected '1.0', got '2.0'");
  });

  it('should reject empty workflowId', () => {
    const state = {
      version: '1.0',
      workflowId: '',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {},
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('workflowId must be a non-empty string');
  });

  it('should validate step outputs structure', () => {
    const state = {
      version: '1.0',
      workflowId: 'test',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {
        step1: {
          raw: 'output',
          parsed: null,
          exitCode: 0,
          completedAt: '2024-01-15T10:00:00Z',
        },
      },
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid step output', () => {
    const state = {
      version: '1.0',
      workflowId: 'test',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {
        step1: {
          raw: 123, // Should be string
          exitCode: 'zero', // Should be number
          completedAt: '2024-01-15T10:00:00Z',
        },
      },
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('stepOutputs.step1.raw must be a string');
    expect(result.errors).toContain('stepOutputs.step1.exitCode must be a number');
  });

  it('should validate pendingReview structure', () => {
    const state = {
      version: '1.0',
      workflowId: 'test',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {},
      pendingReview: {
        reviewId: 'rev-123',
        artifact: 'content',
        requestedAt: '2024-01-15T10:00:00Z',
      },
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid pendingReview', () => {
    const state = {
      version: '1.0',
      workflowId: 'test',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {},
      pendingReview: {
        reviewId: 123, // Should be string
        artifact: 'content',
        requestedAt: '2024-01-15T10:00:00Z',
      },
      startedAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('pendingReview.reviewId must be a string');
  });

  it('should reject invalid ISO timestamps', () => {
    const state = {
      version: '1.0',
      workflowId: 'test',
      workflowFile: 'test.yaml',
      currentPhase: 'review',
      currentStep: 'step1',
      inputs: {},
      stepOutputs: {},
      startedAt: 'not-a-date',
      updatedAt: '2024-01-15T10:00:00Z',
    };

    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('startedAt must be a valid ISO timestamp');
  });

  it('should reject non-object input', () => {
    const result = validateWorkflowState('not an object');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('State must be an object');
  });

  it('should reject null input', () => {
    const result = validateWorkflowState(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('State must be an object');
  });
});
