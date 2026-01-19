/**
 * Persistence Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { SQLiteStorageAdapter } from '../../src/storage/SQLiteStorageAdapter.js';
import { InMemoryStorageAdapter } from '../../src/storage/InMemoryStorageAdapter.js';
import { simpleWorkflow, humanReviewWorkflow } from '../fixtures/workflows.js';
import { createTestInput } from '../fixtures/contexts.js';

describe('Persistence Integration', () => {
  describe('InMemory Persistence', () => {
    let engine: WorkflowEngine;

    beforeEach(async () => {
      engine = new WorkflowEngine({
        storage: new InMemoryStorageAdapter(),
      });
      await engine.initialize();
    });

    afterEach(async () => {
      await engine.shutdown();
    });

    it('persists workflow state', async () => {
      const id = await engine.runWorkflow(simpleWorkflow, createTestInput());

      const state = await engine.getWorkflow(id);
      expect(state).toBeDefined();
      expect(state?.id).toBe(id);
      expect(state?.status).toBe('completed');
    });

    it('persists step results', async () => {
      const id = await engine.runWorkflow(simpleWorkflow, createTestInput());

      const state = await engine.getWorkflow(id);
      expect(Object.keys(state?.stepResults ?? {})).toHaveLength(2);
      expect(state?.stepResults['step-1']?.success).toBe(true);
      expect(state?.stepResults['step-2']?.success).toBe(true);
    });

    it('persists context changes', async () => {
      const input = createTestInput({ input: { testValue: 42 } });
      const id = await engine.runWorkflow(humanReviewWorkflow, input);

      // Provide input
      await engine.provideInput(id, { decision: 'approved' });

      const state = await engine.getWorkflow(id);
      expect(state?.context.input.testValue).toBe(42);
      expect(state?.context.outputs['review']).toEqual({ decision: 'approved' });
    });
  });

  describe('SQLite Persistence', () => {
    let engine: WorkflowEngine;
    let storage: SQLiteStorageAdapter;

    beforeEach(async () => {
      storage = new SQLiteStorageAdapter({ filename: ':memory:' });
      engine = new WorkflowEngine({ storage });
      await engine.initialize();
    });

    afterEach(async () => {
      await engine.shutdown();
    });

    it('persists workflow to SQLite', async () => {
      const id = await engine.runWorkflow(simpleWorkflow, createTestInput());

      const state = await engine.getWorkflow(id);
      expect(state).toBeDefined();
      expect(state?.status).toBe('completed');
    });

    it('recovers workflow state from SQLite', async () => {
      const id = await engine.runWorkflow(humanReviewWorkflow, createTestInput());

      // Get state directly from storage
      const recoveredState = await storage.get(id);

      expect(recoveredState).toBeDefined();
      expect(recoveredState?.id).toBe(id);
      expect(recoveredState?.status).toBe('waiting');
      expect(recoveredState?.currentStepId).toBe('review');
    });

    it('preserves complex context in SQLite', async () => {
      const input = createTestInput({
        input: {
          nested: {
            value: 123,
            array: [1, 2, 3],
          },
          flag: true,
        },
      });

      const id = await engine.runWorkflow(simpleWorkflow, input);

      const state = await storage.get(id);
      expect(state?.context.input.nested).toEqual({ value: 123, array: [1, 2, 3] });
      expect(state?.context.input.flag).toBe(true);
    });

    it('handles multiple workflows', async () => {
      const id1 = await engine.runWorkflow(simpleWorkflow, createTestInput());
      const id2 = await engine.runWorkflow(simpleWorkflow, createTestInput());
      const id3 = await engine.runWorkflow(humanReviewWorkflow, createTestInput());

      const all = await engine.listWorkflows();
      expect(all.length).toBe(3);

      const completed = await engine.listWorkflows({ status: 'completed' });
      expect(completed.length).toBe(2);

      const waiting = await engine.listWorkflows({ status: 'waiting' });
      expect(waiting.length).toBe(1);
    });

    it('filters workflows by definition', async () => {
      await engine.runWorkflow(simpleWorkflow, createTestInput());
      await engine.runWorkflow(humanReviewWorkflow, createTestInput());

      const simpleWorkflows = await engine.listWorkflows({
        definitionName: 'simple-workflow',
      });

      expect(simpleWorkflows.length).toBe(1);
      expect(simpleWorkflows[0]?.definitionName).toBe('simple-workflow');
    });
  });

  describe('Recovery Scenarios', () => {
    it('recovers paused workflow', async () => {
      // Use SQLite file-based storage for true persistence across engine restarts
      const dbPath = `/tmp/test-recovery-paused-${Date.now()}.db`;
      let storage = new SQLiteStorageAdapter({ filename: dbPath });
      let engine = new WorkflowEngine({ storage });
      await engine.initialize();

      const id = await engine.startWorkflow(simpleWorkflow, createTestInput());
      await engine.pauseWorkflow(id);

      // Simulate engine restart - close and reopen with new adapter instance
      await engine.shutdown();
      storage = new SQLiteStorageAdapter({ filename: dbPath });
      engine = new WorkflowEngine({ storage });
      await engine.initialize();

      const state = await engine.getWorkflow(id);
      expect(state?.status).toBe('paused');

      // Resume should work
      await engine.resumeAndRunWorkflow(id);
      const finalState = await engine.getWorkflow(id);
      expect(finalState?.status).toBe('completed');

      await engine.shutdown();
    });

    it('recovers waiting workflow', async () => {
      // Use SQLite file-based storage for true persistence across engine restarts
      const dbPath = `/tmp/test-recovery-waiting-${Date.now()}.db`;
      let storage = new SQLiteStorageAdapter({ filename: dbPath });
      let engine = new WorkflowEngine({ storage });
      await engine.initialize();

      const id = await engine.runWorkflow(humanReviewWorkflow, createTestInput());

      // Simulate engine restart - close and reopen with new adapter instance
      await engine.shutdown();
      storage = new SQLiteStorageAdapter({ filename: dbPath });
      engine = new WorkflowEngine({ storage });
      await engine.initialize();

      const state = await engine.getWorkflow(id);
      expect(state?.status).toBe('waiting');
      expect(state?.currentStepId).toBe('review');

      // Provide input should work
      await engine.provideInputAndRun(id, { approved: true });
      const finalState = await engine.getWorkflow(id);
      expect(finalState?.status).toBe('completed');

      await engine.shutdown();
    });
  });

  describe('Data Integrity', () => {
    it('preserves all workflow state fields', async () => {
      const storage = new SQLiteStorageAdapter({ filename: ':memory:' });
      const engine = new WorkflowEngine({ storage });
      await engine.initialize();

      const id = await engine.runWorkflow(simpleWorkflow, createTestInput({
        input: { key: 'value' },
        metadata: { correlationId: 'test-123' },
      }));

      const state = await storage.get(id);

      // Verify all fields are present
      expect(state?.id).toBe(id);
      expect(state?.definitionName).toBe('simple-workflow');
      expect(state?.definitionVersion).toBe('1.0.0');
      expect(state?.definition).toEqual(simpleWorkflow);
      expect(state?.status).toBe('completed');
      expect(state?.currentStepId).toBeNull();
      expect(state?.context.input.key).toBe('value');
      expect(state?.context.metadata.correlationId).toBe('test-123');
      expect(state?.stepResults).toBeDefined();
      expect(state?.stepAttempts).toBeDefined();
      expect(state?.createdAt).toBeDefined();
      expect(state?.updatedAt).toBeDefined();
      expect(state?.startedAt).toBeDefined();
      expect(state?.completedAt).toBeDefined();

      await engine.shutdown();
    });

    it('preserves step result details', async () => {
      const storage = new SQLiteStorageAdapter({ filename: ':memory:' });
      const engine = new WorkflowEngine({ storage });
      await engine.initialize();

      const id = await engine.runWorkflow(simpleWorkflow, createTestInput());

      const state = await storage.get(id);
      const stepResult = state?.stepResults['step-1'];

      expect(stepResult?.stepId).toBe('step-1');
      expect(stepResult?.success).toBe(true);
      expect(stepResult?.startedAt).toBeDefined();
      expect(stepResult?.completedAt).toBeDefined();
      expect(stepResult?.durationMs).toBeGreaterThanOrEqual(0);

      await engine.shutdown();
    });
  });
});
