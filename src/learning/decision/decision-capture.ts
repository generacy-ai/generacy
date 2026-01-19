/**
 * Decision Capture
 *
 * Captures decisions and stores them with metadata linking.
 * Builds evidence trails for principles based on decisions.
 */

import type {
  CapturedDecision,
  LearningEvent,
  PrincipleReinforcedPayload,
  PrincipleContradictedPayload,
} from '../types.js';
import type { DecisionRepository } from './decision-repository.js';
import type { DecisionRequest, BaselineRecommendation } from '../../baseline/types.js';
import type { ProtegeRecommendation, AppliedPrinciple } from '../../recommendation/types/recommendation.js';
import type { CoachingData } from '../types.js';

/**
 * Input for capturing a decision
 */
export interface DecisionCaptureInput {
  /** Unique identifier for this decision */
  id: string;

  /** User who made the decision */
  userId: string;

  /** Original decision request */
  request: DecisionRequest;

  /** Baseline recommendation */
  baseline: BaselineRecommendation;

  /** Protégé recommendation */
  protege: ProtegeRecommendation;

  /** What the human actually chose */
  finalChoice: string;

  /** Coaching data if this was an override */
  coaching?: CoachingData;
}

/**
 * Result of capturing a decision
 */
export interface DecisionCaptureResult {
  /** The captured decision */
  decision: CapturedDecision;

  /** Learning events generated */
  learningEvents: LearningEvent[];
}

/**
 * Service for capturing decisions and generating learning events.
 */
export class DecisionCapture {
  constructor(private readonly repository: DecisionRepository) {}

  /**
   * Capture a decision and generate associated learning events.
   * @param input - The decision to capture
   * @returns The captured decision with learning events
   */
  async capture(input: DecisionCaptureInput): Promise<DecisionCaptureResult> {
    const wasOverride = input.protege.optionId !== input.finalChoice;

    // Generate learning events based on the decision
    const learningEvents = this.generateLearningEvents(input, wasOverride);

    // Create the captured decision
    const decision: CapturedDecision = {
      id: input.id,
      userId: input.userId,
      timestamp: new Date(),
      request: input.request,
      baseline: input.baseline,
      protege: input.protege,
      finalChoice: input.finalChoice,
      wasOverride,
      coaching: wasOverride ? input.coaching : undefined,
      learningEvents,
      generatedUpdates: [],
    };

    // Store the decision
    await this.repository.save(decision);

    return { decision, learningEvents };
  }

  /**
   * Link a knowledge update to a decision (evidence trail).
   * @param decisionId - The decision ID
   * @param updateId - The update ID to link
   */
  async linkUpdate(decisionId: string, updateId: string): Promise<void> {
    const decision = await this.repository.getById(decisionId);
    if (!decision) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

    if (!decision.generatedUpdates.includes(updateId)) {
      decision.generatedUpdates.push(updateId);
      await this.repository.save(decision);
    }
  }

  /**
   * Get decisions that serve as evidence for a principle.
   * @param userId - The user ID
   * @param principleId - The principle ID
   * @returns Decisions where the principle was applied
   */
  async getEvidenceForPrinciple(userId: string, principleId: string): Promise<CapturedDecision[]> {
    const allDecisions = await this.repository.getByUserId(userId);
    return allDecisions.filter(decision =>
      decision.learningEvents.some(event =>
        (event.payload.type === 'principle_reinforced' ||
          event.payload.type === 'principle_contradicted') &&
        event.payload.principleId === principleId
      )
    );
  }

  /**
   * Get all decisions that generated a specific update.
   * @param updateId - The update ID
   * @returns Decisions that contributed to this update
   */
  async getDecisionsForUpdate(userId: string, updateId: string): Promise<CapturedDecision[]> {
    const allDecisions = await this.repository.getByUserId(userId);
    return allDecisions.filter(decision =>
      decision.generatedUpdates.includes(updateId)
    );
  }

  /**
   * Generate learning events from a decision.
   */
  private generateLearningEvents(
    input: DecisionCaptureInput,
    wasOverride: boolean
  ): LearningEvent[] {
    const events: LearningEvent[] = [];
    const timestamp = new Date();

    // Process applied principles
    for (const principle of input.protege.appliedPrinciples) {
      if (wasOverride) {
        // The recommendation was overridden - principles were contradicted
        events.push(this.createPrincipleContradictedEvent(
          input.id,
          input.userId,
          principle,
          input.coaching,
          timestamp
        ));
      } else {
        // The recommendation was followed - principles were reinforced
        events.push(this.createPrincipleReinforcedEvent(
          input.id,
          input.userId,
          principle,
          timestamp
        ));
      }
    }

    return events;
  }

  /**
   * Create a principle reinforced learning event.
   */
  private createPrincipleReinforcedEvent(
    decisionId: string,
    userId: string,
    principle: AppliedPrinciple,
    timestamp: Date
  ): LearningEvent {
    const payload: PrincipleReinforcedPayload = {
      type: 'principle_reinforced',
      principleId: principle.principleId,
      strength: principle.strength,
    };

    return {
      id: `event-${decisionId}-${principle.principleId}-reinforced`,
      type: 'principle_reinforced',
      timestamp,
      decisionId,
      userId,
      payload,
    };
  }

  /**
   * Create a principle contradicted learning event.
   */
  private createPrincipleContradictedEvent(
    decisionId: string,
    userId: string,
    principle: AppliedPrinciple,
    coaching: CoachingData | undefined,
    timestamp: Date
  ): LearningEvent {
    const payload: PrincipleContradictedPayload = {
      type: 'principle_contradicted',
      principleId: principle.principleId,
      overrideReason: coaching?.overrideReason ?? 'exception_case',
      explanation: coaching?.explanation,
    };

    return {
      id: `event-${decisionId}-${principle.principleId}-contradicted`,
      type: 'principle_contradicted',
      timestamp,
      decisionId,
      userId,
      payload,
    };
  }
}
