import type {
  CreateDecisionRequest,
  DecisionQueueItem,
  DecisionResponse,
  DecisionResponseRequest,
  DecisionPriority,
  QueueQuery,
} from '../types/index.js';
import { Errors } from '../middleware/error-handler.js';

/**
 * Message router interface (facade over internal message router)
 * This will be implemented by the actual MessageRouter from #5
 */
export interface MessageRouter {
  getQueue(query?: QueueQuery): Promise<DecisionQueueItem[]>;
  getDecision(id: string): Promise<DecisionQueueItem | null>;
  createDecision(request: CreateDecisionRequest): Promise<DecisionQueueItem>;
  respondToDecision(id: string, response: DecisionResponseRequest, respondedBy: string): Promise<DecisionResponse>;
}

/**
 * In-memory queue store for development/testing
 */
export class InMemoryQueueStore implements MessageRouter {
  private queue: Map<string, DecisionQueueItem> = new Map();
  private responses: Map<string, DecisionResponse> = new Map();

  async getQueue(query?: QueueQuery): Promise<DecisionQueueItem[]> {
    let items = Array.from(this.queue.values());

    // Filter by priority
    if (query?.priority) {
      items = items.filter((item) => item.priority === query.priority);
    }

    // Filter by workflow
    if (query?.workflowId) {
      items = items.filter((item) => item.workflowId === query.workflowId);
    }

    // Sort by priority (blocking_now first) and creation date
    const priorityOrder: Record<DecisionPriority, number> = {
      blocking_now: 0,
      blocking_soon: 1,
      when_available: 2,
    };

    items.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return items;
  }

  async getDecision(id: string): Promise<DecisionQueueItem | null> {
    return this.queue.get(id) ?? null;
  }

  async createDecision(request: CreateDecisionRequest): Promise<DecisionQueueItem> {
    const item: DecisionQueueItem = {
      id: crypto.randomUUID(),
      workflowId: request.workflowId,
      stepId: request.stepId,
      type: request.type,
      prompt: request.prompt,
      options: request.options,
      context: request.context,
      priority: request.priority,
      createdAt: new Date().toISOString(),
      expiresAt: request.expiresAt ?? null,
    };

    this.queue.set(item.id, item);
    return item;
  }

  async respondToDecision(
    id: string,
    request: DecisionResponseRequest,
    respondedBy: string
  ): Promise<DecisionResponse> {
    const decision = this.queue.get(id);
    if (!decision) {
      throw Errors.notFound(`Decision ${id} not found`);
    }

    // Check if already responded
    if (this.responses.has(id)) {
      throw Errors.conflict(`Decision ${id} has already been responded to`);
    }

    // Check expiration
    if (decision.expiresAt && new Date(decision.expiresAt) < new Date()) {
      throw Errors.conflict(`Decision ${id} has expired`);
    }

    const response: DecisionResponse = {
      id,
      response: request.response,
      comment: request.comment,
      respondedBy,
      respondedAt: new Date().toISOString(),
    };

    this.responses.set(id, response);
    this.queue.delete(id);

    return response;
  }

  /**
   * Add a decision to the queue (for testing)
   */
  addDecision(decision: DecisionQueueItem): void {
    this.queue.set(decision.id, decision);
  }

  /**
   * Clear all decisions (for testing)
   */
  clear(): void {
    this.queue.clear();
    this.responses.clear();
  }

  /**
   * Get queue size (for testing)
   */
  size(): number {
    return this.queue.size;
  }
}

/**
 * Queue service - facade over message router
 */
export class QueueService {
  constructor(private router: MessageRouter) {}

  /**
   * Get all pending decisions
   */
  async getQueue(query?: QueueQuery): Promise<DecisionQueueItem[]> {
    return this.router.getQueue(query);
  }

  /**
   * Create a new decision in the queue
   */
  async createDecision(request: CreateDecisionRequest): Promise<DecisionQueueItem> {
    return this.router.createDecision(request);
  }

  /**
   * Get a specific decision by ID
   */
  async getDecision(id: string): Promise<DecisionQueueItem> {
    const decision = await this.router.getDecision(id);
    if (!decision) {
      throw Errors.notFound(`Decision ${id} not found`);
    }
    return decision;
  }

  /**
   * Respond to a decision
   */
  async respond(
    id: string,
    request: DecisionResponseRequest,
    respondedBy: string
  ): Promise<DecisionResponse> {
    return this.router.respondToDecision(id, request, respondedBy);
  }

  /**
   * Get count of pending decisions by priority
   */
  async getQueueStats(): Promise<Record<DecisionPriority, number>> {
    const items = await this.router.getQueue();
    const stats: Record<DecisionPriority, number> = {
      blocking_now: 0,
      blocking_soon: 0,
      when_available: 0,
    };

    for (const item of items) {
      stats[item.priority]++;
    }

    return stats;
  }
}
