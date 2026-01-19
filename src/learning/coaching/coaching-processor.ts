/**
 * Coaching Processor
 *
 * Processes coaching data from overridden decisions and generates
 * appropriate knowledge updates based on the override reason.
 */

import type { CoachingData, KnowledgeUpdate, CapturedDecision, LearningEvent, CoachingReceivedPayload } from '../types.js';
import type { AppliedPrinciple } from '../../recommendation/types/recommendation.js';
import { UpdateGenerator } from './update-generator.js';

/**
 * Result of processing coaching data
 */
export interface CoachingProcessResult {
  /** Generated knowledge updates */
  updates: KnowledgeUpdate[];

  /** Learning events generated */
  learningEvents: LearningEvent[];
}

/**
 * Configuration for coaching processor
 */
export interface CoachingProcessorConfig {
  /** Whether to generate new principles from missing context */
  createPrinciplesFromContext: boolean;
}

const DEFAULT_CONFIG: CoachingProcessorConfig = {
  createPrinciplesFromContext: true,
};

/**
 * Service for processing coaching data into knowledge updates.
 */
export class CoachingProcessor {
  private readonly config: CoachingProcessorConfig;
  private readonly updateGenerator: UpdateGenerator;

  constructor(
    updateGenerator?: UpdateGenerator,
    config: Partial<CoachingProcessorConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.updateGenerator = updateGenerator ?? new UpdateGenerator();
  }

  /**
   * Process coaching data from a captured decision.
   * @param decision - The captured decision containing coaching data
   * @returns Updates and learning events generated
   */
  processCoaching(decision: CapturedDecision): CoachingProcessResult {
    if (!decision.wasOverride || !decision.coaching) {
      return { updates: [], learningEvents: [] };
    }

    const coaching = decision.coaching;
    const updates = this.generateUpdatesForReason(
      decision.userId,
      decision.id,
      coaching,
      decision.protege.appliedPrinciples
    );

    const learningEvents = this.generateCoachingEvent(decision, updates);

    return { updates, learningEvents };
  }

  /**
   * Generate updates based on the override reason.
   */
  private generateUpdatesForReason(
    userId: string,
    decisionId: string,
    coaching: CoachingData,
    appliedPrinciples: AppliedPrinciple[]
  ): KnowledgeUpdate[] {
    const updates: KnowledgeUpdate[] = [];

    switch (coaching.overrideReason) {
      case 'reasoning_incorrect':
        // Protégé applied principles wrongly → refine principle applicability
        updates.push(...this.handleReasoningIncorrect(userId, decisionId, coaching, appliedPrinciples));
        break;

      case 'missing_context':
        // Protégé didn't know something → update context or add new principle
        updates.push(...this.handleMissingContext(userId, decisionId, coaching, appliedPrinciples));
        break;

      case 'priorities_changed':
        // Situation changed → update current context priorities
        updates.push(...this.handlePrioritiesChanged(userId, decisionId, coaching));
        break;

      case 'exception_case':
        // One-time deviation → note but don't update principles (unless pattern emerges)
        updates.push(...this.handleExceptionCase(userId, decisionId, coaching, appliedPrinciples));
        break;
    }

    return updates;
  }

  /**
   * Handle reasoning_incorrect override reason.
   * Create refinements for principles that were applied wrongly.
   */
  private handleReasoningIncorrect(
    userId: string,
    decisionId: string,
    coaching: CoachingData,
    appliedPrinciples: AppliedPrinciple[]
  ): KnowledgeUpdate[] {
    const updates: KnowledgeUpdate[] = [];

    // If specific principles were marked as incorrect, refine those
    if (coaching.incorrectPrinciples && coaching.incorrectPrinciples.length > 0) {
      for (const principleId of coaching.incorrectPrinciples) {
        updates.push(
          this.updateGenerator.createPrincipleRefinement(
            userId,
            decisionId,
            coaching,
            principleId
          )
        );
      }
    } else {
      // Otherwise, refine all applied principles
      for (const principle of appliedPrinciples) {
        updates.push(
          this.updateGenerator.createPrincipleRefinement(
            userId,
            decisionId,
            coaching,
            principle.principleId
          )
        );
      }
    }

    return updates;
  }

  /**
   * Handle missing_context override reason.
   * Create context update or new principle depending on configuration.
   */
  private handleMissingContext(
    userId: string,
    decisionId: string,
    coaching: CoachingData,
    appliedPrinciples: AppliedPrinciple[]
  ): KnowledgeUpdate[] {
    const updates: KnowledgeUpdate[] = [];

    // Always create a context update
    updates.push(
      this.updateGenerator.createContextUpdate(userId, decisionId, coaching)
    );

    // Optionally create a new principle if configured and should be remembered
    if (this.config.createPrinciplesFromContext && coaching.shouldRemember) {
      // Extract domains from applied principles
      const domains = [...new Set(appliedPrinciples.flatMap(p => {
        // AppliedPrinciple doesn't have domains, so we use empty array
        return [];
      }))];

      updates.push(
        this.updateGenerator.createNewPrincipleFromContext(
          userId,
          decisionId,
          coaching,
          domains
        )
      );
    }

    return updates;
  }

  /**
   * Handle priorities_changed override reason.
   * Create a priority update to reflect new priorities.
   */
  private handlePrioritiesChanged(
    userId: string,
    decisionId: string,
    coaching: CoachingData
  ): KnowledgeUpdate[] {
    // Get previous priorities would require access to knowledge store
    // For now, we pass empty array - the update queue can enrich this
    return [
      this.updateGenerator.createPriorityUpdate(
        userId,
        decisionId,
        coaching,
        [] // Previous priorities - would need knowledge store access
      ),
    ];
  }

  /**
   * Handle exception_case override reason.
   * Note the exception without updating principles.
   */
  private handleExceptionCase(
    userId: string,
    decisionId: string,
    coaching: CoachingData,
    appliedPrinciples: AppliedPrinciple[]
  ): KnowledgeUpdate[] {
    const relatedPrinciples = appliedPrinciples.map(p => p.principleId);

    return [
      this.updateGenerator.createExceptionNote(
        userId,
        decisionId,
        coaching,
        relatedPrinciples
      ),
    ];
  }

  /**
   * Generate a coaching received learning event.
   */
  private generateCoachingEvent(
    decision: CapturedDecision,
    updates: KnowledgeUpdate[]
  ): LearningEvent[] {
    if (!decision.coaching) {
      return [];
    }

    const payload: CoachingReceivedPayload = {
      type: 'coaching_received',
      coachingData: decision.coaching,
      sourceDecisionId: decision.id,
    };

    const event: LearningEvent = {
      id: `event-${decision.id}-coaching`,
      type: 'coaching_received',
      timestamp: new Date(),
      decisionId: decision.id,
      userId: decision.userId,
      payload,
    };

    return [event];
  }
}
