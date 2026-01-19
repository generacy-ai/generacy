/**
 * Protégé Recommendation Engine
 *
 * Generates personalized recommendations based on a human's wisdom,
 * principles, and philosophy - answering "What would THIS human decide?"
 * rather than "What is objectively best?"
 *
 * ## Quick Start
 *
 * ```typescript
 * import {
 *   ProtegeRecommendationEngine,
 *   type DecisionRequest,
 *   type IndividualKnowledge,
 *   type BaselineRecommendation,
 * } from '@generacy/recommendation';
 *
 * const engine = new ProtegeRecommendationEngine();
 *
 * const recommendation = await engine.generateRecommendation(
 *   request,
 *   knowledge,
 *   baseline
 * );
 * ```
 */

// Type exports
export * from './types/index.js';

// Engine exports
export {
  ProtegeRecommendationEngine,
  PrincipleMatcherService,
  ContextIntegratorService,
  PhilosophyApplierService,
  ReasoningGeneratorService,
} from './engine/index.js';

// Utility exports
export {
  calculateConfidence,
  isLowConfidence,
  calculateConfidenceDetailed,
  hasDifference,
  explainDifference,
  generateDifferenceSummary,
  type ConfidenceOptions,
} from './utils/index.js';
