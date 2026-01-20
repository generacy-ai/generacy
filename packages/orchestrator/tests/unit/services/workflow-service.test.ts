import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkflowService,
  InMemoryWorkflowStore,
} from '../../../src/services/workflow-service.js';
import type { CreateWorkflowRequest } from '../../../src/types/index.js';

describe('WorkflowService', () => {
  let store: InMemoryWorkflowStore;
  let service: WorkflowService;

  beforeEach(() => {
    store = new InMemoryWorkflowStore();
    service = new WorkflowService(store);
  });

  describe('create', () => {
    it('should create a new workflow', async () => {
      const request: CreateWorkflowRequest = {
        context: { projectId: '123' },
        metadata: {
          name: 'Test Workflow',
          tags: ['test'],
        },
      };

      const workflow = await service.create(request);

      expect(workflow.id).toBeDefined();
      expect(workflow.status).toBe('created');
      expect(workflow.context).toEqual({ projectId: '123' });
      expect(workflow.metadata.name).toBe('Test Workflow');
      expect(workflow.metadata.tags).toEqual(['test']);
      expect(workflow.currentStep).toBeNull();
      expect(workflow.createdAt).toBeDefined();
      expect(workflow.updatedAt).toBeDefined();
    });

    it('should create workflow without metadata', async () => {
      const request: CreateWorkflowRequest = {
        context: { projectId: '123' },
      };

      const workflow = await service.create(request);

      expect(workflow.id).toBeDefined();
      expect(workflow.metadata.name).toBeUndefined();
      expect(workflow.metadata.tags).toEqual([]);
    });
  });

  describe('get', () => {
    it('should get workflow by ID', async () => {
      const request: CreateWorkflowRequest = {
        context: { projectId: '123' },
      };
      const created = await service.create(request);

      const workflow = await service.get(created.id);

      expect(workflow.id).toBe(created.id);
    });

    it('should throw error for non-existent workflow', async () => {
      await expect(service.get('non-existent-id')).rejects.toThrow('not found');
    });
  });

  describe('list', () => {
    it('should list all workflows', async () => {
      await service.create({ context: { id: 1 } });
      await service.create({ context: { id: 2 } });
      await service.create({ context: { id: 3 } });

      const result = await service.list();

      expect(result.workflows).toHaveLength(3);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.page).toBe(1);
    });

    it('should paginate results', async () => {
      for (let i = 0; i < 25; i++) {
        await service.create({ context: { id: i } });
      }

      const page1 = await service.list({ page: 1, pageSize: 10 });
      const page2 = await service.list({ page: 2, pageSize: 10 });
      const page3 = await service.list({ page: 3, pageSize: 10 });

      expect(page1.workflows).toHaveLength(10);
      expect(page1.pagination.hasMore).toBe(true);
      expect(page2.workflows).toHaveLength(10);
      expect(page2.pagination.hasMore).toBe(true);
      expect(page3.workflows).toHaveLength(5);
      expect(page3.pagination.hasMore).toBe(false);
    });

    it('should filter by status', async () => {
      const w1 = await service.create({ context: { id: 1 } });
      await service.create({ context: { id: 2 } });

      // Wait for workflow to start running
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Pause the first workflow
      await service.pause(w1.id);

      const pausedWorkflows = await service.list({ status: 'paused' });

      expect(pausedWorkflows.workflows).toHaveLength(1);
      expect(pausedWorkflows.workflows[0]?.id).toBe(w1.id);
    });
  });

  describe('pause', () => {
    it('should pause a running workflow', async () => {
      const created = await service.create({ context: {} });

      // Wait for workflow to start running
      await new Promise((resolve) => setTimeout(resolve, 150));

      const paused = await service.pause(created.id);

      expect(paused.status).toBe('paused');
    });

    it('should throw error for non-running workflow', async () => {
      const created = await service.create({ context: {} });

      // Don't wait for it to start running
      await expect(service.pause(created.id)).rejects.toThrow('not running');
    });
  });

  describe('resume', () => {
    it('should resume a paused workflow', async () => {
      const created = await service.create({ context: {} });

      // Wait for workflow to start running, then pause it
      await new Promise((resolve) => setTimeout(resolve, 150));
      await service.pause(created.id);

      const resumed = await service.resume(created.id);

      expect(resumed.status).toBe('running');
    });

    it('should throw error for non-paused workflow', async () => {
      const created = await service.create({ context: {} });

      await expect(service.resume(created.id)).rejects.toThrow('not paused');
    });
  });

  describe('cancel', () => {
    it('should cancel a running workflow', async () => {
      const created = await service.create({ context: {} });

      // Wait for workflow to start running
      await new Promise((resolve) => setTimeout(resolve, 150));

      await service.cancel(created.id);

      const workflow = await service.get(created.id);
      expect(workflow.status).toBe('cancelled');
      expect(workflow.completedAt).toBeDefined();
    });

    it('should cancel a created workflow', async () => {
      const created = await service.create({ context: {} });

      // Don't wait for it to start
      await service.cancel(created.id);

      const workflow = await service.get(created.id);
      expect(workflow.status).toBe('cancelled');
    });

    it('should throw error for already cancelled workflow', async () => {
      const created = await service.create({ context: {} });
      await service.cancel(created.id);

      await expect(service.cancel(created.id)).rejects.toThrow('cannot be cancelled');
    });
  });
});

describe('InMemoryWorkflowStore', () => {
  let store: InMemoryWorkflowStore;

  beforeEach(() => {
    store = new InMemoryWorkflowStore();
  });

  it('should clear all workflows', async () => {
    await store.create({ context: {} });
    await store.create({ context: {} });

    expect(store.count()).toBe(2);

    store.clear();

    expect(store.count()).toBe(0);
  });
});
