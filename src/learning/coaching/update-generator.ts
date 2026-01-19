/**
 * Update Generator
 *
 * Generates KnowledgeUpdate objects from coaching data.
 * Maps override reasons to appropriate update types.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  KnowledgeUpdate,
  CoachingData,
  KnowledgeUpdateType,
  PrincipleRefinementPayload,
  ContextUpdatePayload,
  PriorityUpdatePayload,
  ExceptionNotePayload,
  NewPrinciplePayload,
} from '../types.js';

/**
 * Configuration for update generation
 */
export interface UpdateGeneratorConfig {
  /** Default confidence for generated updates */
  defaultConfidence: number;
}

const DEFAULT_CONFIG: UpdateGeneratorConfig = {
  defaultConfidence: 0.7,
};

/**
 * Service for generating knowledge updates from coaching data.
 */
export class UpdateGenerator {
  private readonly config: UpdateGeneratorConfig;

  constructor(config: Partial<UpdateGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a principle refinement update when reasoning was incorrect.
   */
  createPrincipleRefinement(
    userId: string,
    sourceDecisionId: string,
    coaching: CoachingData,
    principleId: string
  ): KnowledgeUpdate {
    const payload: PrincipleRefinementPayload = {
      type: 'principle_refinement',
      principleId,
      refinementType: 'add_exception',
      change: coaching.explanation,
    };

    return this.createUpdate({
      userId,
      type: 'principle_refinement',
      sourceDecisionId,
      confidence: this.config.defaultConfidence,
      reasoning: `Principle was applied incorrectly: ${coaching.explanation}`,
      payload,
    });
  }

  /**
   * Create a context update when missing context was the issue.
   */
  createContextUpdate(
    userId: string,
    sourceDecisionId: string,
    coaching: CoachingData
  ): KnowledgeUpdate {
    const payload: ContextUpdatePayload = {
      type: 'context_update',
      field: 'constraints',
      previousValue: null,
      newValue: coaching.missingContext,
    };

    return this.createUpdate({
      userId,
      type: 'context_update',
      sourceDecisionId,
      confidence: this.config.defaultConfidence,
      reasoning: `Missing context identified: ${coaching.missingContext}`,
      payload,
    });
  }

  /**
   * Create a new principle update from missing context that should become a principle.
   */
  createNewPrincipleFromContext(
    userId: string,
    sourceDecisionId: string,
    coaching: CoachingData,
    domains: string[] = []
  ): KnowledgeUpdate {
    const payload: NewPrinciplePayload = {
      type: 'new_principle',
      principle: {
        name: `Learned: ${coaching.missingContext?.slice(0, 50) ?? 'New insight'}`,
        content: coaching.explanation,
        domains,
        suggestedWeight: 5,
        source: 'learned',
      },
      evidenceDecisions: [sourceDecisionId],
    };

    return this.createUpdate({
      userId,
      type: 'new_principle',
      sourceDecisionId,
      confidence: this.config.defaultConfidence * 0.8, // Lower confidence for new principles
      reasoning: `New principle suggested from coaching: ${coaching.explanation}`,
      payload,
    });
  }

  /**
   * Create a priority update when priorities changed.
   */
  createPriorityUpdate(
    userId: string,
    sourceDecisionId: string,
    coaching: CoachingData,
    previousPriorities: string[] = []
  ): KnowledgeUpdate {
    const payload: PriorityUpdatePayload = {
      type: 'priority_update',
      previousPriorities,
      newPriorities: coaching.updatedPriorities ?? [],
    };

    return this.createUpdate({
      userId,
      type: 'priority_update',
      sourceDecisionId,
      confidence: 0.9, // Higher confidence - user explicitly stated priorities
      reasoning: `User updated priorities: ${(coaching.updatedPriorities ?? []).join(', ')}`,
      payload,
    });
  }

  /**
   * Create an exception note for one-time deviations.
   */
  createExceptionNote(
    userId: string,
    sourceDecisionId: string,
    coaching: CoachingData,
    relatedPrinciples: string[] = []
  ): KnowledgeUpdate {
    const payload: ExceptionNotePayload = {
      type: 'exception_note',
      note: coaching.explanation,
      relatedPrinciples,
      occurrence: 'single',
    };

    return this.createUpdate({
      userId,
      type: 'exception_note',
      sourceDecisionId,
      confidence: 1.0, // Exception notes don't need approval
      reasoning: `Exception noted: ${coaching.explanation}`,
      payload,
    });
  }

  /**
   * Create a base update with common fields.
   */
  private createUpdate(params: {
    userId: string;
    type: KnowledgeUpdateType;
    sourceDecisionId: string;
    confidence: number;
    reasoning: string;
    payload: KnowledgeUpdate['payload'];
  }): KnowledgeUpdate {
    const now = new Date();

    return {
      id: uuidv4(),
      userId: params.userId,
      type: params.type,
      generatedAt: now,
      sourceDecisionId: params.sourceDecisionId,
      confidence: params.confidence,
      reasoning: params.reasoning,
      payload: params.payload,
      status: 'pending',
      statusUpdatedAt: now,
    };
  }
}
