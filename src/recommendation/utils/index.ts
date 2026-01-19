/**
 * Recommendation Utilities Module
 *
 * Exports utility functions for the Protégé Recommendation system.
 */

// Confidence calculation
export {
  calculateConfidence,
  isLowConfidence,
  calculateConfidenceDetailed,
  type ConfidenceOptions,
} from './confidence-calculator.js';

// Difference explanation
export {
  hasDifference,
  explainDifference,
  generateDifferenceSummary,
} from './difference-explainer.js';
