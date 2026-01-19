/**
 * Learning Loop Processor
 *
 * The main orchestrator that processes human decisions and coaching
 * into knowledge updates. This is the primary entry point for the
 * learning system.
 */

import type {
  CapturedDecision,
  LearningResult,
  KnowledgeUpdate,
  CoachingData,
  MetricsImpact,
  LearningEvent,
  UpdateProposedPayload,
} from './types.js';
import type { DecisionCaptureInput, DecisionCaptureResult } from './decision/decision-capture.js';
import { DecisionCapture } from './decision/decision-capture.js';
import { InMemoryDecisionRepository, type DecisionRepository } from './decision/decision-repository.js';
import { CoachingProcessor, type CoachingProcessorConfig } from './coaching/coaching-processor.js';
import { UpdateGenerator, type UpdateGeneratorConfig } from './coaching/update-generator.js';
import { ApprovalClassifier, type ApprovalThresholds } from './updates/approval-classifier.js';
import { UpdateQueue, type QueuedUpdate } from './updates/update-queue.js';
import type { Principle, Pattern, IndividualKnowledge } from '../recommendation/types/knowledge.js';

/**
 * Interface for the knowledge store client.
 * This allows the learning loop to interact with the knowledge store
 * without coupling to a specific implementation.
 */
export interface KnowledgeStoreClient {
  /**
   * Apply a knowledge update to the store.
   */
  applyUpdate(update: KnowledgeUpdate): Promise<ApplyResult>;

  /**
   * Get a principle by ID.
   */
  getPrinciple(id: string): Promise<Principle | null>;

  /**
   * Get a pattern by ID.
   */
  getPattern(id: string): Promise<Pattern | null>;

  /**
   * Get a user's complete knowledge profile.
   */
  getUserKnowledge(userId: string): Promise<IndividualKnowledge | null>;
}

/**
 * Result of applying an update.
 */
export interface ApplyResult {
  success: boolean;
  error?: string;
}

/**
 * Configuration for the learning loop processor.
 */
export interface LearningLoopConfig {
  /** Configuration for update generation */
  updateGenerator?: Partial<UpdateGeneratorConfig>;

  /** Configuration for coaching processing */
  coachingProcessor?: Partial<CoachingProcessorConfig>;

  /** Configuration for approval classification */
  approvalThresholds?: Partial<ApprovalThresholds>;
}

/**
 * Result of processing coaching data.
 */
export interface ProcessCoachingResult {
  /** Updates generated from coaching */
  updates: KnowledgeUpdate[];

  /** Queued updates with classification info */
  queuedUpdates: QueuedUpdate[];

  /** Auto-approved updates that were applied */
  appliedUpdates: KnowledgeUpdate[];
}

/**
 * The main Learning Loop Processor.
 *
 * Orchestrates:
 * - Decision capture
 * - Coaching processing
 * - Update generation
 * - Approval classification
 * - Knowledge store updates
 */
export class LearningLoopProcessor {
  private readonly decisionCapture: DecisionCapture;
  private readonly coachingProcessor: CoachingProcessor;
  private readonly approvalClassifier: ApprovalClassifier;
  private readonly updateQueue: UpdateQueue;
  private readonly repository: DecisionRepository;

  constructor(
    private readonly knowledgeStoreClient?: KnowledgeStoreClient,
    config: LearningLoopConfig = {}
  ) {
    this.repository = new InMemoryDecisionRepository();
    this.decisionCapture = new DecisionCapture(this.repository);

    const updateGenerator = new UpdateGenerator(config.updateGenerator);
    this.coachingProcessor = new CoachingProcessor(updateGenerator, config.coachingProcessor);
    this.approvalClassifier = new ApprovalClassifier(config.approvalThresholds);
    this.updateQueue = new UpdateQueue(this.approvalClassifier);
  }

  /**
   * Process a complete decision through the learning loop.
   *
   * This is the main entry point that:
   * 1. Captures the decision
   * 2. Generates learning events
   * 3. Processes coaching (if override)
   * 4. Generates and queues updates
   * 5. Applies auto-approved updates
   */
  async processDecision(input: DecisionCaptureInput): Promise<LearningResult> {
    // Step 1: Capture the decision
    const captureResult = await this.decisionCapture.capture(input);
    const { decision, learningEvents } = captureResult;

    // Step 2: Process coaching if this was an override
    let suggestedUpdates: KnowledgeUpdate[] = [];
    let appliedUpdates: KnowledgeUpdate[] = [];
    const allLearningEvents = [...learningEvents];

    if (decision.wasOverride && decision.coaching) {
      const coachingResult = this.coachingProcessor.processCoaching(decision);

      // Add coaching events
      allLearningEvents.push(...coachingResult.learningEvents);

      // Queue updates for approval
      for (const update of coachingResult.updates) {
        const queued = this.updateQueue.enqueue(update);
        suggestedUpdates.push(queued.update);

        // Generate update_proposed event
        const proposedEvent = this.createUpdateProposedEvent(decision, queued);
        allLearningEvents.push(proposedEvent);

        // Link update to decision
        await this.decisionCapture.linkUpdate(decision.id, update.id);
      }

      // Apply auto-approved updates to knowledge store
      appliedUpdates = await this.applyAutoApprovedUpdates(input.userId);
    }

    // Calculate metrics impact
    const metricsImpact = this.calculateMetricsImpact(decision, allLearningEvents);

    // Extract principle IDs
    const principlesReinforced = this.extractPrincipleIds(allLearningEvents, 'principle_reinforced');
    const principlesContradicted = this.extractPrincipleIds(allLearningEvents, 'principle_contradicted');

    return {
      decisionId: decision.id,
      learningEvents: allLearningEvents,
      principlesReinforced,
      principlesContradicted,
      suggestedUpdates,
      metricsImpact,
    };
  }

  /**
   * Process coaching data directly (without a full decision).
   * Useful for processing coaching that arrives separately.
   */
  async processCoaching(
    userId: string,
    decisionId: string,
    coaching: CoachingData
  ): Promise<ProcessCoachingResult> {
    // Get the decision
    const decision = await this.repository.getById(decisionId);
    if (!decision) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

    // Update the decision with coaching
    decision.coaching = coaching;
    await this.repository.save(decision);

    // Process the coaching
    const result = this.coachingProcessor.processCoaching(decision);

    // Queue updates
    const queuedUpdates: QueuedUpdate[] = [];
    for (const update of result.updates) {
      const queued = this.updateQueue.enqueue(update);
      queuedUpdates.push(queued);
      await this.decisionCapture.linkUpdate(decisionId, update.id);
    }

    // Apply auto-approved
    const appliedUpdates = await this.applyAutoApprovedUpdates(userId);

    return {
      updates: result.updates,
      queuedUpdates,
      appliedUpdates,
    };
  }

  /**
   * Apply an approved update to the knowledge store.
   */
  async applyUpdate(update: KnowledgeUpdate): Promise<ApplyResult> {
    if (!this.knowledgeStoreClient) {
      // No client - just mark as applied in queue
      this.updateQueue.markApplied(update.id);
      return { success: true };
    }

    const result = await this.knowledgeStoreClient.applyUpdate(update);

    if (result.success) {
      this.updateQueue.markApplied(update.id);
    }

    return result;
  }

  /**
   * Get pending updates requiring manual approval.
   */
  getPendingUpdates(userId: string): QueuedUpdate[] {
    return this.updateQueue.getPendingForApproval(userId);
  }

  /**
   * Approve a pending update.
   */
  approveUpdate(updateId: string): KnowledgeUpdate | null {
    const result = this.updateQueue.approve(updateId);
    return result.success ? result.update! : null;
  }

  /**
   * Reject a pending update.
   */
  rejectUpdate(updateId: string, reason: string): KnowledgeUpdate | null {
    const result = this.updateQueue.reject(updateId, reason);
    return result.success ? result.update! : null;
  }

  /**
   * Get decision repository for querying decisions.
   */
  getDecisionRepository(): DecisionRepository {
    return this.repository;
  }

  /**
   * Get update queue for queue management.
   */
  getUpdateQueue(): UpdateQueue {
    return this.updateQueue;
  }

  /**
   * Apply all auto-approved updates for a user.
   */
  private async applyAutoApprovedUpdates(userId: string): Promise<KnowledgeUpdate[]> {
    const autoApproved = this.updateQueue.getAutoApproved(userId);
    const applied: KnowledgeUpdate[] = [];

    for (const queued of autoApproved) {
      const result = await this.applyUpdate(queued.update);
      if (result.success) {
        applied.push(queued.update);
      }
    }

    return applied;
  }

  /**
   * Create an update_proposed learning event.
   */
  private createUpdateProposedEvent(
    decision: CapturedDecision,
    queued: QueuedUpdate
  ): LearningEvent {
    const payload: UpdateProposedPayload = {
      type: 'update_proposed',
      updateId: queued.update.id,
      updateType: queued.update.type,
      requiresApproval: !queued.classification.autoApprove,
    };

    return {
      id: `event-${decision.id}-update-${queued.update.id}`,
      type: 'update_proposed',
      timestamp: new Date(),
      decisionId: decision.id,
      userId: decision.userId,
      payload,
    };
  }

  /**
   * Extract principle IDs from learning events by type.
   */
  private extractPrincipleIds(events: LearningEvent[], type: string): string[] {
    return events
      .filter(e => e.type === type)
      .map(e => {
        if (e.payload.type === 'principle_reinforced' || e.payload.type === 'principle_contradicted') {
          return e.payload.principleId;
        }
        return null;
      })
      .filter((id): id is string => id !== null);
  }

  /**
   * Calculate estimated metrics impact from a decision.
   */
  private calculateMetricsImpact(
    decision: CapturedDecision,
    events: LearningEvent[]
  ): MetricsImpact {
    // Base impact calculation
    let interventionRateChange = 0;
    let confidenceChange = 0;

    if (decision.wasOverride) {
      // Overrides indicate the protégé was wrong
      interventionRateChange = 0.01; // Small increase in intervention rate
      confidenceChange = -0.02; // Small decrease in confidence

      // Count contradicted principles
      const contradictions = events.filter(e => e.type === 'principle_contradicted').length;
      confidenceChange -= contradictions * 0.01;
    } else {
      // Following recommendation reinforces learning
      interventionRateChange = -0.005; // Slight decrease in intervention rate
      confidenceChange = 0.01; // Slight increase in confidence

      // Count reinforced principles
      const reinforcements = events.filter(e => e.type === 'principle_reinforced').length;
      confidenceChange += reinforcements * 0.005;
    }

    return {
      interventionRateChange,
      confidenceChange,
    };
  }
}
