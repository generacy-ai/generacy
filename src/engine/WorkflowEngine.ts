/**
 * Workflow Engine
 *
 * Main orchestration class for managing multiple workflow instances.
 */

import type {
  WorkflowDefinition,
} from '../types/WorkflowDefinition.js';
import type {
  WorkflowState,
  WorkflowFilter,
} from '../types/WorkflowState.js';
import type { WorkflowInput } from '../types/WorkflowContext.js';
import { createWorkflowContext } from '../types/WorkflowContext.js';
import type { StorageAdapter } from '../types/StorageAdapter.js';
import type { WorkflowEventHandler, WorkflowEvent } from '../types/WorkflowEvent.js';
import type { ErrorHandler } from '../types/ErrorHandler.js';
import { InMemoryStorageAdapter } from '../storage/InMemoryStorageAdapter.js';
import { WorkflowEventEmitter } from '../events/WorkflowEventEmitter.js';
import { WorkflowRuntime, type StepExecutor, type WorkflowRuntimeOptions } from './WorkflowRuntime.js';
import { generateWorkflowId } from '../utils/IdGenerator.js';

/**
 * Options for configuring the workflow engine.
 */
export interface WorkflowEngineOptions {
  /** Storage adapter for persistence (default: InMemoryStorageAdapter) */
  storage?: StorageAdapter;

  /** Error handler for workflow failures */
  errorHandler?: ErrorHandler;

  /** Custom step executor */
  stepExecutor?: StepExecutor;

  /** Default timeout for workflows in milliseconds */
  defaultTimeout?: number;
}

/**
 * Main workflow engine class.
 * Manages workflow lifecycle, persistence, and event emission.
 */
export class WorkflowEngine {
  private storage: StorageAdapter;
  private eventEmitter: WorkflowEventEmitter;
  private runtimes: Map<string, WorkflowRuntime> = new Map();
  private errorHandler: ErrorHandler | undefined;
  private stepExecutor: StepExecutor | undefined;
  private defaultTimeout: number;
  private initialized: boolean = false;

  constructor(options: WorkflowEngineOptions = {}) {
    this.storage = options.storage ?? new InMemoryStorageAdapter();
    this.eventEmitter = new WorkflowEventEmitter();
    this.errorHandler = options.errorHandler;
    this.stepExecutor = options.stepExecutor;
    this.defaultTimeout = options.defaultTimeout ?? 3600000; // 1 hour
  }

  /**
   * Initialize the workflow engine.
   * Must be called before using the engine.
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();
    this.initialized = true;
  }

  /**
   * Shutdown the workflow engine.
   * Persists all active workflows and closes storage.
   */
  async shutdown(): Promise<void> {
    this.ensureInitialized();

    // Persist all active runtimes
    for (const [id, runtime] of this.runtimes) {
      try {
        await this.storage.update(runtime.getState());
      } catch (error) {
        console.error(`Failed to persist workflow ${id}:`, error);
      }
    }

    this.runtimes.clear();
    await this.storage.shutdown();
    this.eventEmitter.clear();
    this.initialized = false;
  }

  /**
   * Start a new workflow.
   * @param definition The workflow definition
   * @param input Initial workflow input
   * @returns The workflow ID
   */
  async startWorkflow(
    definition: WorkflowDefinition,
    input: WorkflowInput = {}
  ): Promise<string> {
    this.ensureInitialized();
    this.validateDefinition(definition);

    const id = generateWorkflowId();
    const now = new Date().toISOString();
    const context = createWorkflowContext(input);

    const state: WorkflowState = {
      id,
      definitionName: definition.name,
      definitionVersion: definition.version,
      definition,
      status: 'created',
      currentStepId: null,
      context,
      stepResults: {},
      stepAttempts: {},
      createdAt: now,
      updatedAt: now,
    };

    await this.storage.create(state);

    this.eventEmitter.emitEvent('workflow:created', id, definition.name, {
      definitionName: definition.name,
      definitionVersion: definition.version,
    });

    // Create and start runtime
    const runtime = this.createRuntime(state);
    this.runtimes.set(id, runtime);

    await runtime.start();
    await this.persistRuntime(runtime);

    return id;
  }

  /**
   * Run a workflow to completion or waiting state.
   * @param definition The workflow definition
   * @param input Initial workflow input
   * @returns The workflow ID
   */
  async runWorkflow(
    definition: WorkflowDefinition,
    input: WorkflowInput = {}
  ): Promise<string> {
    const id = await this.startWorkflow(definition, input);
    const runtime = this.runtimes.get(id);

    if (runtime) {
      await runtime.run();
      await this.persistRuntime(runtime);
    }

    return id;
  }

  /**
   * Pause a running workflow.
   * @param id The workflow ID
   */
  async pauseWorkflow(id: string): Promise<void> {
    this.ensureInitialized();

    const runtime = await this.getOrLoadRuntime(id);
    await runtime.pause();
    await this.persistRuntime(runtime);
  }

  /**
   * Resume a paused or waiting workflow.
   * @param id The workflow ID
   */
  async resumeWorkflow(id: string): Promise<void> {
    this.ensureInitialized();

    const runtime = await this.getOrLoadRuntime(id);
    await runtime.resume();
    await this.persistRuntime(runtime);
  }

  /**
   * Resume and continue running a workflow.
   * @param id The workflow ID
   */
  async resumeAndRunWorkflow(id: string): Promise<void> {
    this.ensureInitialized();

    const runtime = await this.getOrLoadRuntime(id);
    await runtime.resume();
    await runtime.run();
    await this.persistRuntime(runtime);
  }

  /**
   * Cancel a workflow.
   * @param id The workflow ID
   * @param reason Optional cancellation reason
   */
  async cancelWorkflow(id: string, reason?: string): Promise<void> {
    this.ensureInitialized();

    const runtime = await this.getOrLoadRuntime(id);
    await runtime.cancel(reason);
    await this.persistRuntime(runtime);
    this.runtimes.delete(id);
  }

  /**
   * Provide input to a waiting workflow.
   * @param id The workflow ID
   * @param input The input data
   */
  async provideInput(id: string, input: unknown): Promise<void> {
    this.ensureInitialized();

    const runtime = await this.getOrLoadRuntime(id);
    await runtime.provideInput(input);
    await this.persistRuntime(runtime);
  }

  /**
   * Provide input and continue running the workflow.
   * @param id The workflow ID
   * @param input The input data
   */
  async provideInputAndRun(id: string, input: unknown): Promise<void> {
    this.ensureInitialized();

    const runtime = await this.getOrLoadRuntime(id);
    await runtime.provideInput(input);
    await runtime.run();
    await this.persistRuntime(runtime);
  }

  /**
   * Get a workflow state by ID.
   * @param id The workflow ID
   * @returns The workflow state, or undefined if not found
   */
  async getWorkflow(id: string): Promise<WorkflowState | undefined> {
    this.ensureInitialized();

    // Check active runtimes first
    const runtime = this.runtimes.get(id);
    if (runtime) {
      return runtime.getState();
    }

    // Load from storage
    return this.storage.get(id);
  }

  /**
   * List workflows matching the filter criteria.
   * @param filter Optional filter criteria
   * @returns Array of workflow states
   */
  async listWorkflows(filter?: WorkflowFilter): Promise<WorkflowState[]> {
    this.ensureInitialized();
    return this.storage.list(filter);
  }

  /**
   * Count workflows matching the filter criteria.
   * @param filter Optional filter criteria
   * @returns Number of matching workflows
   */
  async countWorkflows(filter?: WorkflowFilter): Promise<number> {
    this.ensureInitialized();
    return this.storage.count(filter);
  }

  /**
   * Delete a workflow by ID.
   * @param id The workflow ID
   * @returns true if deleted, false if not found
   */
  async deleteWorkflow(id: string): Promise<boolean> {
    this.ensureInitialized();

    this.runtimes.delete(id);
    return this.storage.delete(id);
  }

  /**
   * Subscribe to workflow events.
   * @param callback Event handler callback
   * @returns Unsubscribe function
   */
  onWorkflowEvent(callback: WorkflowEventHandler): () => void {
    return this.eventEmitter.onEvent(callback);
  }

  /**
   * Subscribe to specific workflow event types.
   * @param type Event type
   * @param callback Event handler callback
   * @returns Unsubscribe function
   */
  on(type: WorkflowEvent['type'], callback: WorkflowEventHandler): () => void {
    return this.eventEmitter.on(type, callback);
  }

  /**
   * Get the storage adapter.
   */
  getStorage(): StorageAdapter {
    return this.storage;
  }

  /**
   * Get the event emitter.
   */
  getEventEmitter(): WorkflowEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Create a runtime for a workflow state.
   */
  private createRuntime(state: WorkflowState): WorkflowRuntime {
    const options: WorkflowRuntimeOptions = {
      eventEmitter: this.eventEmitter,
      defaultStepTimeout: this.defaultTimeout,
    };
    if (this.errorHandler !== undefined) {
      options.errorHandler = this.errorHandler;
    }
    if (this.stepExecutor !== undefined) {
      options.stepExecutor = this.stepExecutor;
    }
    return new WorkflowRuntime(state, options);
  }

  /**
   * Get an existing runtime or load from storage.
   */
  private async getOrLoadRuntime(id: string): Promise<WorkflowRuntime> {
    let runtime = this.runtimes.get(id);
    if (runtime) {
      return runtime;
    }

    const state = await this.storage.get(id);
    if (!state) {
      throw new Error(`Workflow ${id} not found`);
    }

    runtime = this.createRuntime(state);
    this.runtimes.set(id, runtime);
    return runtime;
  }

  /**
   * Persist a runtime's state to storage.
   */
  private async persistRuntime(runtime: WorkflowRuntime): Promise<void> {
    await this.storage.update(runtime.getState());
  }

  /**
   * Validate a workflow definition.
   */
  private validateDefinition(definition: WorkflowDefinition): void {
    if (!definition.name) {
      throw new Error('Workflow definition must have a name');
    }

    if (!definition.version) {
      throw new Error('Workflow definition must have a version');
    }

    if (!definition.steps || definition.steps.length === 0) {
      throw new Error('Workflow definition must have at least one step');
    }

    // Validate step IDs are unique
    const stepIds = new Set<string>();
    for (const step of definition.steps) {
      if (!step.id) {
        throw new Error('All workflow steps must have an ID');
      }
      if (stepIds.has(step.id)) {
        throw new Error(`Duplicate step ID: ${step.id}`);
      }
      stepIds.add(step.id);
    }

    // Validate step references
    for (const step of definition.steps) {
      if (typeof step.next === 'string' && !stepIds.has(step.next)) {
        throw new Error(`Step ${step.id} references non-existent step: ${step.next}`);
      }
      if (Array.isArray(step.next)) {
        for (const conditional of step.next) {
          if (!stepIds.has(conditional.stepId)) {
            throw new Error(`Step ${step.id} references non-existent step: ${conditional.stepId}`);
          }
        }
      }
    }
  }

  /**
   * Ensure the engine is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Workflow engine not initialized. Call initialize() first.');
    }
  }
}
