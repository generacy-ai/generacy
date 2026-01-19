/**
 * In-Memory Storage Adapter
 *
 * In-memory implementation for testing and development.
 */

import type { StorageAdapter } from '../types/StorageAdapter.js';
import type { WorkflowState, WorkflowFilter, WorkflowStatus } from '../types/WorkflowState.js';

/**
 * In-memory storage adapter for workflow state.
 * Useful for testing and development scenarios.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private workflows: Map<string, WorkflowState> = new Map();
  private initialized: boolean = false;

  async initialize(): Promise<void> {
    this.workflows = new Map();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.workflows.clear();
    this.initialized = false;
  }

  async create(state: WorkflowState): Promise<void> {
    this.ensureInitialized();

    if (this.workflows.has(state.id)) {
      throw new Error(`Workflow with ID ${state.id} already exists`);
    }

    this.workflows.set(state.id, structuredClone(state));
  }

  async update(state: WorkflowState): Promise<void> {
    this.ensureInitialized();

    if (!this.workflows.has(state.id)) {
      throw new Error(`Workflow with ID ${state.id} does not exist`);
    }

    this.workflows.set(state.id, structuredClone(state));
  }

  async get(id: string): Promise<WorkflowState | undefined> {
    this.ensureInitialized();

    const state = this.workflows.get(id);
    return state ? structuredClone(state) : undefined;
  }

  async list(filter?: WorkflowFilter): Promise<WorkflowState[]> {
    this.ensureInitialized();

    let results = Array.from(this.workflows.values());

    if (filter) {
      results = this.applyFilter(results, filter);
    }

    // Apply pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;
    results = results.slice(offset, offset + limit);

    return results.map((state) => structuredClone(state));
  }

  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();
    return this.workflows.delete(id);
  }

  async exists(id: string): Promise<boolean> {
    this.ensureInitialized();
    return this.workflows.has(id);
  }

  async count(filter?: WorkflowFilter): Promise<number> {
    this.ensureInitialized();

    let results = Array.from(this.workflows.values());

    if (filter) {
      // Don't apply pagination for count
      const filterWithoutPagination = { ...filter, limit: undefined, offset: undefined };
      results = this.applyFilter(results, filterWithoutPagination);
    }

    return results.length;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized. Call initialize() first.');
    }
  }

  private applyFilter(states: WorkflowState[], filter: WorkflowFilter): WorkflowState[] {
    let results = states;

    // Filter by status
    if (filter.status) {
      const statusArray: WorkflowStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter((state) => statusArray.includes(state.status));
    }

    // Filter by definition name
    if (filter.definitionName) {
      results = results.filter((state) => state.definitionName === filter.definitionName);
    }

    // Filter by definition version
    if (filter.definitionVersion) {
      results = results.filter((state) => state.definitionVersion === filter.definitionVersion);
    }

    // Filter by created date range
    if (filter.createdAfter) {
      results = results.filter((state) => state.createdAt >= filter.createdAfter!);
    }

    if (filter.createdBefore) {
      results = results.filter((state) => state.createdAt <= filter.createdBefore!);
    }

    return results;
  }
}
