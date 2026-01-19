/**
 * Storage Adapter Interface
 *
 * Pluggable storage interface for workflow state persistence.
 */

import type { WorkflowState, WorkflowFilter } from './WorkflowState.js';

/**
 * Storage adapter interface for workflow persistence.
 *
 * Implementations must handle their own connection management
 * and ensure thread-safety where applicable.
 */
export interface StorageAdapter {
  /**
   * Initialize the storage adapter.
   * Called once when the workflow engine starts.
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the storage adapter.
   * Called once when the workflow engine stops.
   */
  shutdown(): Promise<void>;

  /**
   * Save a new workflow state.
   * @param state The workflow state to save
   * @throws If a workflow with the same ID already exists
   */
  create(state: WorkflowState): Promise<void>;

  /**
   * Update an existing workflow state.
   * @param state The workflow state to update
   * @throws If the workflow does not exist
   */
  update(state: WorkflowState): Promise<void>;

  /**
   * Get a workflow state by ID.
   * @param id The workflow ID
   * @returns The workflow state, or undefined if not found
   */
  get(id: string): Promise<WorkflowState | undefined>;

  /**
   * List workflow states matching the filter criteria.
   * @param filter Optional filter criteria
   * @returns Array of matching workflow states
   */
  list(filter?: WorkflowFilter): Promise<WorkflowState[]>;

  /**
   * Delete a workflow state by ID.
   * @param id The workflow ID
   * @returns true if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Check if a workflow exists.
   * @param id The workflow ID
   * @returns true if exists, false otherwise
   */
  exists(id: string): Promise<boolean>;

  /**
   * Count workflows matching the filter criteria.
   * @param filter Optional filter criteria
   * @returns Number of matching workflows
   */
  count(filter?: WorkflowFilter): Promise<number>;
}
