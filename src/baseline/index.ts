/**
 * Baseline Recommendation Generator module.
 *
 * This module provides the BaselineRecommendationGenerator - a component that produces
 * objective AI recommendations without human wisdom for the three-layer decision model.
 *
 * @packageDocumentation
 */

// Types
export type {
  DecisionRequest,
  DecisionOption,
  ProjectContext,
  DecisionConstraints,
  BaselineRecommendation,
  ConsiderationFactor,
  AlternativeAnalysis,
  BaselineConfig,
  FactorConfig,
} from './types.js';

// Default config
export { DEFAULT_BASELINE_CONFIG } from './types.js';

// Main generator class
export {
  BaselineRecommendationGenerator,
  RecommendationGenerationError,
  AIResponseParseError,
} from './baseline-generator.js';

// Supporting classes
export { PromptBuilder } from './prompt-builder.js';
export { ConfidenceCalculator } from './confidence-calculator.js';
