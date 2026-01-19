/**
 * Confidence Calculator Utility
 *
 * Calculates confidence scores for recommendations based on:
 * - Applied principle weights and relevance
 * - Coverage factor (matched vs expected principles)
 * - Context modifier (energy, conflicts, etc.)
 *
 * Formula: confidence = Σ(weight × relevance) / max_possible_weight × coverage × context
 */

import type { AppliedPrinciple } from '../types/index.js';

/**
 * Extended applied principle with test-compatible properties
 */
interface ExtendedAppliedPrinciple {
  id?: string;
  principleId?: string;
  name?: string;
  principleText?: string;
  weight: number;
  relevanceScore?: number;
  strength?: number;
  domain?: string;
  relevance?: string;
  favorsOption?: string;
}

/**
 * Options for confidence calculation
 */
export interface ConfidenceOptions {
  /** Expected number of principles for this domain */
  expectedPrinciplesForDomain: number;

  /** Context modifier (1.0 = normal, <1.0 = reduced due to conflicts/energy) */
  contextModifier: number;
}

/**
 * Low confidence threshold
 */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Calculate confidence score for a recommendation
 *
 * @param principles - Applied principles with weights and relevance
 * @param options - Calculation options including coverage and context
 * @returns Confidence score between 0 and 1
 */
export function calculateConfidence(
  principles: ExtendedAppliedPrinciple[] | AppliedPrinciple[],
  options: ConfidenceOptions
): number {
  if (!principles || principles.length === 0) {
    return 0;
  }

  const { expectedPrinciplesForDomain, contextModifier } = options;

  // Calculate weighted sum: Σ(weight × relevance)
  let weightedSum = 0;
  let totalWeight = 0;

  for (const principle of principles) {
    const weight = principle.weight;
    const relevance = getRelevanceScore(principle);

    weightedSum += weight * relevance;
    totalWeight += weight;
  }

  // Avoid division by zero
  if (totalWeight === 0) {
    return 0;
  }

  // Calculate base confidence: weightedSum / totalWeight
  const baseConfidence = weightedSum / totalWeight;

  // Calculate coverage factor: matched / expected
  const coverageFactor = Math.min(1, principles.length / expectedPrinciplesForDomain);

  // Apply context modifier
  const confidence = baseConfidence * coverageFactor * contextModifier;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Get relevance score from a principle (supports multiple property names)
 */
function getRelevanceScore(principle: ExtendedAppliedPrinciple | AppliedPrinciple): number {
  // Check for relevanceScore (test interface)
  if ('relevanceScore' in principle && typeof principle.relevanceScore === 'number') {
    return principle.relevanceScore;
  }

  // Check for strength (production interface)
  if ('strength' in principle && typeof principle.strength === 'number') {
    return principle.strength;
  }

  // Default to 0.5 if no relevance metric available
  return 0.5;
}

/**
 * Check if a confidence score is considered low
 *
 * @param confidence - Confidence score to check
 * @returns True if confidence is below threshold
 */
export function isLowConfidence(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_THRESHOLD;
}

/**
 * Calculate confidence with detailed breakdown
 *
 * @param principles - Applied principles
 * @param options - Calculation options
 * @returns Confidence score and breakdown details
 */
export function calculateConfidenceDetailed(
  principles: AppliedPrinciple[],
  options: ConfidenceOptions
): {
  confidence: number;
  isLow: boolean;
  breakdown: {
    baseConfidence: number;
    coverageFactor: number;
    contextModifier: number;
    principleCount: number;
    expectedCount: number;
  };
} {
  if (!principles || principles.length === 0) {
    return {
      confidence: 0,
      isLow: true,
      breakdown: {
        baseConfidence: 0,
        coverageFactor: 0,
        contextModifier: options.contextModifier,
        principleCount: 0,
        expectedCount: options.expectedPrinciplesForDomain,
      },
    };
  }

  const { expectedPrinciplesForDomain, contextModifier } = options;

  // Calculate weighted sum
  let weightedSum = 0;
  let totalWeight = 0;

  for (const principle of principles) {
    const weight = principle.weight;
    const relevance = principle.strength;

    weightedSum += weight * relevance;
    totalWeight += weight;
  }

  const baseConfidence = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const coverageFactor = Math.min(1, principles.length / expectedPrinciplesForDomain);
  const confidence = Math.max(0, Math.min(1, baseConfidence * coverageFactor * contextModifier));

  return {
    confidence,
    isLow: isLowConfidence(confidence),
    breakdown: {
      baseConfidence,
      coverageFactor,
      contextModifier,
      principleCount: principles.length,
      expectedCount: expectedPrinciplesForDomain,
    },
  };
}
