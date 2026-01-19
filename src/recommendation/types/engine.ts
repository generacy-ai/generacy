/**
 * Protégé Recommendation Engine Interface Types
 *
 * These types define the main engine interface and supporting types
 * for the recommendation generation process.
 */

import type { DecisionRequest } from './decision-request.js';
import type { BaselineRecommendation } from './baseline.js';
import type {
  ProtegeRecommendation,
  AppliedPrinciple,
  ContextInfluenceRecord,
  ReasoningStep,
  RecommendationWarning,
} from './recommendation.js';
import type { IndividualKnowledge } from './knowledge.js';

/**
 * The main Protégé Recommendation Engine interface
 *
 * Generates personalized recommendations by applying a human's
 * wisdom, principles, and philosophy to decision requests.
 */
export interface ProtegeRecommendationEngine {
  /**
   * Generate a personalized recommendation based on the human's knowledge
   *
   * @param request - The decision that needs to be made
   * @param knowledge - The human's individual knowledge store
   * @param baseline - The objective baseline recommendation
   * @param options - Optional configuration for the recommendation process
   * @returns A personalized recommendation with reasoning
   */
  generateRecommendation(
    request: DecisionRequest,
    knowledge: IndividualKnowledge,
    baseline: BaselineRecommendation,
    options?: RecommendationOptions
  ): Promise<ProtegeRecommendation>;

  /**
   * Explain the difference between the protégé and baseline recommendations
   *
   * @param protege - The personalized recommendation
   * @param baseline - The objective baseline recommendation
   * @returns A detailed explanation of the differences
   */
  explainDifference(
    protege: ProtegeRecommendation,
    baseline: BaselineRecommendation
  ): DifferenceExplanation;
}

/**
 * Options for the recommendation generation process
 */
export interface RecommendationOptions {
  /** Override energy level (1-10) */
  energyLevel?: number;

  /** Skip context integration */
  skipContext?: boolean;

  /** Include detailed debugging info in response */
  debug?: boolean;

  /** Maximum number of principles to apply */
  maxPrinciples?: number;

  /** Minimum relevance score for principle inclusion (0-1) */
  minRelevance?: number;
}

/**
 * Explanation of differences between protégé and baseline recommendations
 */
export interface DifferenceExplanation {
  /** Whether they recommend different options */
  differentOption: boolean;

  /** Primary reason for the difference */
  primaryReason: string;

  /** Principles that drove the difference */
  drivingPrinciples: AppliedPrinciple[];

  /** Context factors that drove the difference */
  drivingContext: ContextInfluenceRecord[];

  /** Structured comparison of aspects */
  comparison: DifferenceComparison[];
}

/**
 * A single aspect comparison between baseline and protégé
 */
export interface DifferenceComparison {
  /** Aspect being compared */
  aspect: string;

  /** Baseline's position on this aspect */
  baseline: string;

  /** Protégé's position on this aspect */
  protege: string;
}

/**
 * Service interface for matching principles to decisions
 */
export interface PrincipleMatcherService {
  /**
   * Match principles to a decision request
   *
   * @param request - The decision request
   * @param principles - Available principles to match
   * @returns Matched and ranked principles
   */
  match(
    request: DecisionRequest,
    principles: import('./knowledge.js').Principle[]
  ): AppliedPrinciple[];
}

/**
 * Service interface for integrating context into recommendations
 */
export interface ContextIntegratorService {
  /**
   * Integrate context into the recommendation process
   *
   * @param request - The decision request
   * @param context - The user's current context
   * @param principles - Principles already matched
   * @returns Adjusted principles and context influence records
   */
  integrate(
    request: DecisionRequest,
    context: import('./knowledge.js').UserContext,
    principles: AppliedPrinciple[]
  ): ContextIntegrationResult;
}

/**
 * Result of context integration
 */
export interface ContextIntegrationResult {
  /** Principles adjusted for context */
  adjustedPrinciples: AppliedPrinciple[];

  /** Records of how context influenced the recommendation */
  influence: ContextInfluenceRecord[];

  /** Warnings generated during context integration */
  warnings: RecommendationWarning[];
}

/**
 * Service interface for applying philosophy to recommendations
 */
export interface PhilosophyApplierService {
  /**
   * Apply philosophy to determine the recommended option
   *
   * @param request - The decision request
   * @param philosophy - The human's philosophy
   * @param candidates - Candidate principles to consider
   * @returns The recommended option and reasoning
   */
  apply(
    request: DecisionRequest,
    philosophy: import('./knowledge.js').Philosophy,
    candidates: AppliedPrinciple[]
  ): PhilosophyApplicationResult;
}

/**
 * Result of philosophy application
 */
export interface PhilosophyApplicationResult {
  /** Recommended option ID */
  recommendation: string;

  /** Reasoning steps that led to this recommendation */
  reasoning: ReasoningStep[];

  /** Whether any boundaries were considered */
  boundariesConsidered: boolean;

  /** Warnings from philosophy application */
  warnings: RecommendationWarning[];
}

/**
 * Service interface for generating reasoning explanations
 */
export interface ReasoningGeneratorService {
  /**
   * Generate reasoning steps for a recommendation
   *
   * @param request - The decision request
   * @param appliedPrinciples - Principles that were applied
   * @param contextInfluence - Context influence records
   * @param selectedOption - The selected option ID
   * @returns Array of reasoning steps
   */
  generate(
    request: DecisionRequest,
    appliedPrinciples: AppliedPrinciple[],
    contextInfluence: ContextInfluenceRecord[],
    selectedOption: string
  ): ReasoningStep[];
}
