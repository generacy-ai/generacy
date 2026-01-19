/**
 * Learning Loop Types
 *
 * Types for the learning loop processor that processes human decisions
 * and coaching into knowledge updates.
 */

import type { DecisionRequest, BaselineRecommendation } from '../baseline/types.js';
import type { ProtegeRecommendation } from '../recommendation/types/recommendation.js';

// ============================================================================
// Override Reasons
// ============================================================================

/**
 * Reasons why a human might override a protégé recommendation
 */
export type OverrideReason =
  | 'reasoning_incorrect'   // Protégé applied principles wrongly
  | 'missing_context'       // Protégé didn't know something
  | 'priorities_changed'    // Situation changed
  | 'exception_case';       // One-time deviation

// ============================================================================
// Coaching Data
// ============================================================================

/**
 * Data provided when a human overrides a recommendation
 */
export interface CoachingData {
  /** Why the human overrode the recommendation */
  overrideReason: OverrideReason;

  /** Human's explanation in their own words */
  explanation: string;

  /** Specific principles that were wrong (if reasoning_incorrect) */
  incorrectPrinciples?: string[];

  /** Missing context that wasn't considered (if missing_context) */
  missingContext?: string;

  /** Updated priorities (if priorities_changed) */
  updatedPriorities?: string[];

  /** Whether this should be remembered for future decisions */
  shouldRemember: boolean;
}

// ============================================================================
// Captured Decision
// ============================================================================

/**
 * A decision that has been captured for learning
 */
export interface CapturedDecision {
  /** Unique identifier */
  id: string;

  /** User who made the decision */
  userId: string;

  /** When the decision was captured */
  timestamp: Date;

  /** Original decision request */
  request: DecisionRequest;

  /** Baseline recommendation received */
  baseline: BaselineRecommendation;

  /** Protégé recommendation received */
  protege: ProtegeRecommendation;

  /** What the human actually chose */
  finalChoice: string;

  /** Whether this was an override of the protégé recommendation */
  wasOverride: boolean;

  /** Coaching data if this was an override */
  coaching?: CoachingData;

  /** Learning events generated from this decision */
  learningEvents: LearningEvent[];

  /** Link to any knowledge updates generated */
  generatedUpdates: string[];  // Update IDs
}

// ============================================================================
// Learning Events
// ============================================================================

/**
 * Type of learning event
 */
export type LearningEventType =
  | 'principle_reinforced'    // Principle was followed
  | 'principle_contradicted'  // Principle was overridden
  | 'coaching_received'       // Human provided feedback
  | 'update_proposed';        // Update generated for approval

/**
 * Payload for principle reinforced event
 */
export interface PrincipleReinforcedPayload {
  type: 'principle_reinforced';
  principleId: string;
  strength: number;  // How strongly it was applied (0-1)
}

/**
 * Payload for principle contradicted event
 */
export interface PrincipleContradictedPayload {
  type: 'principle_contradicted';
  principleId: string;
  overrideReason: OverrideReason;
  explanation?: string;
}

/**
 * Payload for coaching received event
 */
export interface CoachingReceivedPayload {
  type: 'coaching_received';
  coachingData: CoachingData;
  sourceDecisionId: string;
}

/**
 * Payload for update proposed event
 */
export interface UpdateProposedPayload {
  type: 'update_proposed';
  updateId: string;
  updateType: KnowledgeUpdateType;
  requiresApproval: boolean;
}

/**
 * Union of all learning event payloads
 */
export type LearningEventPayload =
  | PrincipleReinforcedPayload
  | PrincipleContradictedPayload
  | CoachingReceivedPayload
  | UpdateProposedPayload;

/**
 * A discrete learning event from a decision
 */
export interface LearningEvent {
  /** Unique identifier */
  id: string;

  /** Type of learning event */
  type: LearningEventType;

  /** When this event occurred */
  timestamp: Date;

  /** Decision that generated this event */
  decisionId: string;

  /** User this event belongs to */
  userId: string;

  /** Event-specific payload */
  payload: LearningEventPayload;
}

// ============================================================================
// Knowledge Update Types
// ============================================================================

/**
 * Type of knowledge update
 */
export type KnowledgeUpdateType =
  | 'principle_reinforcement'  // Increase principle weight
  | 'principle_weakening'      // Decrease principle weight
  | 'principle_refinement'     // Add exception or modify applicability
  | 'new_principle'            // Create new principle
  | 'context_update'           // Update user context
  | 'priority_update'          // Update priorities
  | 'exception_note';          // Note exception without update

/**
 * Status of a knowledge update
 */
export type UpdateStatus =
  | 'pending'      // Waiting for approval
  | 'approved'     // Approved (auto or manual)
  | 'rejected'     // Rejected by user
  | 'applied';     // Applied to knowledge store

// ============================================================================
// Update Payloads
// ============================================================================

/**
 * Payload for principle reinforcement update
 */
export interface PrincipleReinforcementPayload {
  type: 'principle_reinforcement';
  principleId: string;
  currentWeight: number;
  newWeight: number;
  delta: number;
}

/**
 * Payload for principle weakening update
 */
export interface PrincipleWeakeningPayload {
  type: 'principle_weakening';
  principleId: string;
  currentWeight: number;
  newWeight: number;
  delta: number;
  contradictionCount: number;
}

/**
 * Payload for principle refinement update
 */
export interface PrincipleRefinementPayload {
  type: 'principle_refinement';
  principleId: string;
  refinementType: 'add_exception' | 'narrow_applicability' | 'broaden_applicability';
  change: string;  // Description of the change
}

/**
 * Payload for new principle update
 */
export interface NewPrinciplePayload {
  type: 'new_principle';
  principle: {
    name: string;
    content: string;
    domains: string[];
    suggestedWeight: number;
    source: 'learned';
  };
  evidenceDecisions: string[];  // Decision IDs that support this
}

/**
 * Payload for context update
 */
export interface ContextUpdatePayload {
  type: 'context_update';
  field: 'constraints' | 'priorities' | 'goals';
  previousValue: unknown;
  newValue: unknown;
}

/**
 * Payload for priority update
 */
export interface PriorityUpdatePayload {
  type: 'priority_update';
  previousPriorities: string[];
  newPriorities: string[];
}

/**
 * Payload for exception note
 */
export interface ExceptionNotePayload {
  type: 'exception_note';
  note: string;
  relatedPrinciples: string[];
  occurrence: 'single' | 'potential_pattern';
}

/**
 * Union of all update payloads
 */
export type UpdatePayload =
  | PrincipleReinforcementPayload
  | PrincipleWeakeningPayload
  | PrincipleRefinementPayload
  | NewPrinciplePayload
  | ContextUpdatePayload
  | PriorityUpdatePayload
  | ExceptionNotePayload;

// ============================================================================
// Knowledge Update
// ============================================================================

/**
 * An update to be applied to the knowledge store
 */
export interface KnowledgeUpdate {
  /** Unique identifier */
  id: string;

  /** User whose knowledge this updates */
  userId: string;

  /** Type of update */
  type: KnowledgeUpdateType;

  /** When this update was generated */
  generatedAt: Date;

  /** Decision that triggered this update */
  sourceDecisionId: string;

  /** Confidence in this update (0-1) */
  confidence: number;

  /** Human-readable reasoning for this update */
  reasoning: string;

  /** Update-specific payload */
  payload: UpdatePayload;

  /** Approval status */
  status: UpdateStatus;

  /** When status last changed */
  statusUpdatedAt: Date;
}

// ============================================================================
// Learning Result
// ============================================================================

/**
 * Metrics impact estimate from processing a decision
 */
export interface MetricsImpact {
  /** Estimated change to intervention rate */
  interventionRateChange: number;

  /** Estimated change to protégé confidence */
  confidenceChange: number;
}

/**
 * Result of processing a decision through the learning loop
 */
export interface LearningResult {
  /** Decision that was processed */
  decisionId: string;

  /** Learning events generated */
  learningEvents: LearningEvent[];

  /** Principles that were reinforced (IDs) */
  principlesReinforced: string[];

  /** Principles that were contradicted (IDs) */
  principlesContradicted: string[];

  /** Knowledge updates suggested */
  suggestedUpdates: KnowledgeUpdate[];

  /** Metrics impact estimate */
  metricsImpact: MetricsImpact;
}

// ============================================================================
// Repository Query Options
// ============================================================================

/**
 * Query options for decision repository
 */
export interface DecisionQueryOptions {
  /** Maximum number of results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Sort order */
  orderBy?: 'timestamp' | 'userId';

  /** Sort direction */
  direction?: 'asc' | 'desc';

  /** Filter by date range */
  dateRange?: {
    from?: Date;
    to?: Date;
  };
}
