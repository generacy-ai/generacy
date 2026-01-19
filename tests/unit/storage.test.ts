/**
 * Storage Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryStorageAdapter } from '../../src/storage/InMemoryStorageAdapter.js';
import { SQLiteStorageAdapter } from '../../src/storage/SQLiteStorageAdapter.js';
import type { StorageAdapter } from '../../src/types/StorageAdapter.js';
import type { WorkflowState } from '../../src/types/WorkflowState.js';

// Test both storage adapters with the same tests
describe.each([
  ['InMemoryStorageAdapter', () => new InMemoryStorageAdapter()],
  ['SQLiteStorageAdapter', () => new SQLiteStorageAdapter({ filename: ':memory:' })],
])('%s', (name, createAdapter) => {
  let adapter: StorageAdapter;

  const createTestState = (id: string, overrides: Partial<WorkflowState> = {}): WorkflowState => ({
    id,
    definitionName: 'test-workflow',
    definitionVersion: '1.0.0',
    definition: {
      name: 'test-workflow',
      version: '1.0.0',
      steps: [],
    },
    status: 'created',
    currentStepId: null,
    context: {
      input: {},
      outputs: {},
      data: {},
      metadata: {},
    },
    stepResults: {},
    stepAttempts: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    adapter = createAdapter();
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  describe('initialize/shutdown', () => {
    it('initializes without error', async () => {
      // Already initialized in beforeEach
      expect(true).toBe(true);
    });

    it('throws when not initialized', async () => {
      const uninitializedAdapter = createAdapter();
      await expect(uninitializedAdapter.get('test')).rejects.toThrow('not initialized');
    });
  });

  describe('create', () => {
    it('creates a new workflow state', async () => {
      const state = createTestState('wf-1');
      await adapter.create(state);

      const retrieved = await adapter.get('wf-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('wf-1');
    });

    it('throws when creating duplicate ID', async () => {
      const state = createTestState('wf-1');
      await adapter.create(state);

      await expect(adapter.create(state)).rejects.toThrow('already exists');
    });

    it('preserves all state properties', async () => {
      const state = createTestState('wf-1', {
        status: 'running',
        currentStepId: 'step-1',
        context: {
          input: { foo: 'bar' },
          outputs: { result: 42 },
          data: { temp: true },
          metadata: { initiator: 'test' },
        },
        stepResults: {
          'step-0': {
            stepId: 'step-0',
            success: true,
            output: 'done',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 100,
          },
        },
        stepAttempts: { 'step-1': 2 },
      });

      await adapter.create(state);
      const retrieved = await adapter.get('wf-1');

      expect(retrieved?.status).toBe('running');
      expect(retrieved?.currentStepId).toBe('step-1');
      expect(retrieved?.context.input).toEqual({ foo: 'bar' });
      expect(retrieved?.stepResults['step-0']?.success).toBe(true);
      expect(retrieved?.stepAttempts['step-1']).toBe(2);
    });
  });

  describe('update', () => {
    it('updates an existing workflow state', async () => {
      const state = createTestState('wf-1');
      await adapter.create(state);

      const updated = { ...state, status: 'running' as const, currentStepId: 'step-1' };
      await adapter.update(updated);

      const retrieved = await adapter.get('wf-1');
      expect(retrieved?.status).toBe('running');
      expect(retrieved?.currentStepId).toBe('step-1');
    });

    it('throws when updating non-existent workflow', async () => {
      const state = createTestState('wf-nonexistent');
      await expect(adapter.update(state)).rejects.toThrow('does not exist');
    });
  });

  describe('get', () => {
    it('returns undefined for non-existent workflow', async () => {
      const result = await adapter.get('nonexistent');
      expect(result).toBeUndefined();
    });

    it('returns the workflow state', async () => {
      const state = createTestState('wf-1');
      await adapter.create(state);

      const result = await adapter.get('wf-1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('wf-1');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Create test data
      await adapter.create(createTestState('wf-1', { status: 'created', definitionName: 'workflow-a' }));
      await adapter.create(createTestState('wf-2', { status: 'running', definitionName: 'workflow-a' }));
      await adapter.create(createTestState('wf-3', { status: 'completed', definitionName: 'workflow-b' }));
    });

    it('lists all workflows without filter', async () => {
      const results = await adapter.list();
      expect(results.length).toBe(3);
    });

    it('filters by single status', async () => {
      const results = await adapter.list({ status: 'running' });
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe('wf-2');
    });

    it('filters by multiple statuses', async () => {
      const results = await adapter.list({ status: ['created', 'running'] });
      expect(results.length).toBe(2);
    });

    it('filters by definition name', async () => {
      const results = await adapter.list({ definitionName: 'workflow-a' });
      expect(results.length).toBe(2);
    });

    it('applies pagination limit', async () => {
      const results = await adapter.list({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it('applies pagination offset', async () => {
      const results = await adapter.list({ limit: 1, offset: 1 });
      expect(results.length).toBe(1);
    });
  });

  describe('delete', () => {
    it('deletes an existing workflow', async () => {
      const state = createTestState('wf-1');
      await adapter.create(state);

      const deleted = await adapter.delete('wf-1');
      expect(deleted).toBe(true);

      const result = await adapter.get('wf-1');
      expect(result).toBeUndefined();
    });

    it('returns false for non-existent workflow', async () => {
      const deleted = await adapter.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true for existing workflow', async () => {
      const state = createTestState('wf-1');
      await adapter.create(state);

      const exists = await adapter.exists('wf-1');
      expect(exists).toBe(true);
    });

    it('returns false for non-existent workflow', async () => {
      const exists = await adapter.exists('nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('count', () => {
    beforeEach(async () => {
      await adapter.create(createTestState('wf-1', { status: 'running' }));
      await adapter.create(createTestState('wf-2', { status: 'running' }));
      await adapter.create(createTestState('wf-3', { status: 'completed' }));
    });

    it('counts all workflows', async () => {
      const count = await adapter.count();
      expect(count).toBe(3);
    });

    it('counts with filter', async () => {
      const count = await adapter.count({ status: 'running' });
      expect(count).toBe(2);
    });
  });
});
