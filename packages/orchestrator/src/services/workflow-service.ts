import type {
  CreateWorkflowRequest,
  WorkflowResponse,
  WorkflowListResponse,
  ListWorkflowsQuery,
} from '../types/index.js';
import { Errors } from '../middleware/error-handler.js';

/**
 * Workflow engine interface (facade over internal workflow engine)
 * This will be implemented by the actual WorkflowEngine from #3
 */
export interface WorkflowEngine {
  create(request: CreateWorkflowRequest): Promise<WorkflowResponse>;
  get(id: string): Promise<WorkflowResponse | null>;
  list(query: ListWorkflowsQuery): Promise<WorkflowListResponse>;
  pause(id: string): Promise<WorkflowResponse>;
  resume(id: string): Promise<WorkflowResponse>;
  cancel(id: string): Promise<void>;
}

/**
 * In-memory workflow store for development/testing
 */
export class InMemoryWorkflowStore implements WorkflowEngine {
  private workflows: Map<string, WorkflowResponse> = new Map();

  async create(request: CreateWorkflowRequest): Promise<WorkflowResponse> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const workflow: WorkflowResponse = {
      id,
      status: 'created',
      currentStep: null,
      context: request.context,
      metadata: {
        name: request.metadata?.name,
        tags: request.metadata?.tags ?? [],
      },
      createdAt: now,
      updatedAt: now,
    };

    this.workflows.set(id, workflow);

    // Simulate starting the workflow
    setTimeout(() => {
      const w = this.workflows.get(id);
      if (w && w.status === 'created') {
        w.status = 'running';
        w.currentStep = 'initial';
        w.updatedAt = new Date().toISOString();
      }
    }, 100);

    return workflow;
  }

  async get(id: string): Promise<WorkflowResponse | null> {
    return this.workflows.get(id) ?? null;
  }

  async list(query: ListWorkflowsQuery): Promise<WorkflowListResponse> {
    let workflows = Array.from(this.workflows.values());

    // Filter by status
    if (query.status) {
      workflows = workflows.filter((w) => w.status === query.status);
    }

    // Sort by creation date (newest first)
    workflows.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Pagination
    const total = workflows.length;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedWorkflows = workflows.slice(start, end);

    return {
      workflows: paginatedWorkflows,
      pagination: {
        page,
        pageSize,
        total,
        hasMore: end < total,
      },
    };
  }

  async pause(id: string): Promise<WorkflowResponse> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw Errors.notFound(`Workflow ${id} not found`);
    }

    if (workflow.status !== 'running') {
      throw Errors.conflict(`Workflow ${id} is not running (current status: ${workflow.status})`);
    }

    workflow.status = 'paused';
    workflow.updatedAt = new Date().toISOString();
    return workflow;
  }

  async resume(id: string): Promise<WorkflowResponse> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw Errors.notFound(`Workflow ${id} not found`);
    }

    if (workflow.status !== 'paused') {
      throw Errors.conflict(`Workflow ${id} is not paused (current status: ${workflow.status})`);
    }

    workflow.status = 'running';
    workflow.updatedAt = new Date().toISOString();
    return workflow;
  }

  async cancel(id: string): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw Errors.notFound(`Workflow ${id} not found`);
    }

    if (workflow.status === 'completed' || workflow.status === 'cancelled') {
      throw Errors.conflict(`Workflow ${id} cannot be cancelled (current status: ${workflow.status})`);
    }

    workflow.status = 'cancelled';
    workflow.updatedAt = new Date().toISOString();
    workflow.completedAt = new Date().toISOString();
  }

  /**
   * Clear all workflows (for testing)
   */
  clear(): void {
    this.workflows.clear();
  }

  /**
   * Get workflow count (for testing)
   */
  count(): number {
    return this.workflows.size;
  }
}

/**
 * Workflow service - facade over workflow engine
 */
export class WorkflowService {
  constructor(private engine: WorkflowEngine) {}

  /**
   * Create and start a new workflow
   */
  async create(request: CreateWorkflowRequest): Promise<WorkflowResponse> {
    return this.engine.create(request);
  }

  /**
   * Get workflow by ID
   */
  async get(id: string): Promise<WorkflowResponse> {
    const workflow = await this.engine.get(id);
    if (!workflow) {
      throw Errors.notFound(`Workflow ${id} not found`);
    }
    return workflow;
  }

  /**
   * List workflows with optional filters
   */
  async list(query?: Partial<ListWorkflowsQuery>): Promise<WorkflowListResponse> {
    return this.engine.list({
      page: query?.page ?? 1,
      pageSize: query?.pageSize ?? 20,
      status: query?.status,
    });
  }

  /**
   * Pause a running workflow
   */
  async pause(id: string): Promise<WorkflowResponse> {
    return this.engine.pause(id);
  }

  /**
   * Resume a paused workflow
   */
  async resume(id: string): Promise<WorkflowResponse> {
    return this.engine.resume(id);
  }

  /**
   * Cancel a workflow
   */
  async cancel(id: string): Promise<void> {
    return this.engine.cancel(id);
  }
}
