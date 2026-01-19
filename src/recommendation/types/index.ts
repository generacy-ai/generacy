/**
 * Protégé Recommendation Engine Types
 *
 * Re-exports all type definitions for the recommendation engine.
 */

// Decision request types (interim)
export type {
  DecisionRequest,
  DecisionOption,
  Constraint,
} from './decision-request.js';

// Baseline recommendation types (interim)
export type { BaselineRecommendation, BaselineFactor } from './baseline.js';

// Knowledge store types (interim)
export type {
  IndividualKnowledge,
  Philosophy,
  Value,
  Belief,
  Boundary,
  Principle,
  Pattern,
  UserContext,
  Goal,
  ContextConstraint,
} from './knowledge.js';

// Recommendation output types
export type {
  ProtegeRecommendation,
  RecommendationMeta,
  ReasoningStep,
  PrincipleReference,
  AppliedPrinciple,
  ContextInfluenceRecord,
  RecommendationWarning,
} from './recommendation.js';

// Engine interface types
export type {
  ProtegeRecommendationEngine,
  RecommendationOptions,
  DifferenceExplanation,
  DifferenceComparison,
  PrincipleMatcherService,
  ContextIntegratorService,
  ContextIntegrationResult,
  PhilosophyApplierService,
  PhilosophyApplicationResult,
  ReasoningGeneratorService,
} from './engine.js';
