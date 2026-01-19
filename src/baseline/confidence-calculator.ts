/**
 * Confidence calculator for hybrid confidence scoring.
 * Combines factor analysis (algorithmic) with LLM adjustments.
 */

import type { ConsiderationFactor } from './types.js';

/**
 * Calculates hybrid confidence scores based on factor analysis and LLM adjustment.
 * Provides methods for computing base confidence from weighted factors,
 * applying LLM-suggested adjustments, and analyzing factor agreement.
 */
export class ConfidenceCalculator {
  /**
   * Calculate base confidence from factor analysis (algorithmic component).
   * Uses the weights and impacts of factors to compute an initial score.
   *
   * Logic:
   * 1. Sum up weighted impacts: supporting factors add, opposing subtract
   * 2. Normalize to 0-100 scale
   * 3. More supporting factors with high weight = higher confidence
   * 4. Conflicting factors (some support, some oppose) = lower confidence
   *
   * @param factors - Array of consideration factors with weights and impacts
   * @returns Base confidence score (0-100)
   */
  calculateBaseConfidence(factors: ConsiderationFactor[]): number {
    // If no factors, return neutral confidence
    if (factors.length === 0) {
      return 50;
    }

    let supportingWeight = 0;
    let totalWeight = 0;

    for (const factor of factors) {
      // Skip factors with zero or negative weight
      if (factor.weight <= 0) {
        continue;
      }

      totalWeight += factor.weight;

      if (factor.impact === 'supports') {
        supportingWeight += factor.weight;
      } else if (factor.impact === 'opposes') {
        // Opposing factors don't add to supporting weight
        // They are counted in total but not in supporting
      }
      // Neutral factors contribute to total but neither support nor oppose
    }

    // If all weights were zero or negative, return neutral
    if (totalWeight === 0) {
      return 50;
    }

    // Calculate ratio of supporting weight to total weight
    // This gives us a value between 0 and 1
    const ratio = supportingWeight / totalWeight;

    // Scale to 0-100 range
    const confidence = ratio * 100;

    // Clamp to 0-100 range (should already be in range, but defensive)
    return this.clamp(confidence, 0, 100);
  }

  /**
   * Apply LLM confidence adjustment to the base score.
   * The LLM may adjust confidence based on nuances not captured in factor weights.
   *
   * @param baseConfidence - Algorithmic base confidence (0-100)
   * @param llmConfidence - Confidence suggested by the LLM (0-100)
   * @param maxAdjustment - Maximum adjustment allowed (default: 20 points)
   * @returns Final hybrid confidence score (0-100)
   */
  applyLLMAdjustment(
    baseConfidence: number,
    llmConfidence: number,
    maxAdjustment: number = 20
  ): number {
    // Validate inputs - clamp to valid ranges
    const validBaseConfidence = this.clamp(baseConfidence, 0, 100);
    const validLlmConfidence = this.clamp(llmConfidence, 0, 100);
    const validMaxAdjustment = Math.max(0, maxAdjustment);

    // Calculate the difference between LLM suggestion and base
    const difference = validLlmConfidence - validBaseConfidence;

    // Clamp the adjustment to the maximum allowed
    const clampedAdjustment = this.clamp(
      difference,
      -validMaxAdjustment,
      validMaxAdjustment
    );

    // Apply adjustment and ensure result is in valid range
    const finalConfidence = validBaseConfidence + clampedAdjustment;

    return this.clamp(finalConfidence, 0, 100);
  }

  /**
   * Calculate factor agreement ratio.
   * Measures how much factors agree (all support or all oppose) vs conflict.
   *
   * @param factors - Array of consideration factors
   * @returns Agreement ratio (0-1), where 1 = perfect agreement, 0 = maximum conflict
   */
  calculateFactorAgreement(factors: ConsiderationFactor[]): number {
    // If no factors, return perfect agreement (no conflict possible)
    if (factors.length === 0) {
      return 1;
    }

    let supportingWeight = 0;
    let opposingWeight = 0;
    let totalWeight = 0;

    for (const factor of factors) {
      // Skip factors with zero or negative weight
      if (factor.weight <= 0) {
        continue;
      }

      totalWeight += factor.weight;

      if (factor.impact === 'supports') {
        supportingWeight += factor.weight;
      } else if (factor.impact === 'opposes') {
        opposingWeight += factor.weight;
      }
      // Neutral factors don't contribute to agreement calculation
    }

    // If all weights were zero/negative or all neutral, return perfect agreement
    if (totalWeight === 0 || (supportingWeight === 0 && opposingWeight === 0)) {
      return 1;
    }

    // Calculate the dominant direction weight
    const dominantWeight = Math.max(supportingWeight, opposingWeight);
    const nonNeutralWeight = supportingWeight + opposingWeight;

    // If no non-neutral factors, perfect agreement
    if (nonNeutralWeight === 0) {
      return 1;
    }

    // Agreement is the ratio of dominant weight to total non-neutral weight
    // If all factors point the same direction, this is 1
    // If split 50/50, this would be 0.5, but we want that to represent low agreement
    // So we transform: agreement = 2 * (dominantRatio - 0.5) when dominantRatio > 0.5
    const dominantRatio = dominantWeight / nonNeutralWeight;

    // Transform from [0.5, 1] to [0, 1]
    // dominantRatio of 0.5 (50/50 split) -> agreement of 0
    // dominantRatio of 1 (all one direction) -> agreement of 1
    const agreement = 2 * (dominantRatio - 0.5);

    return this.clamp(agreement, 0, 1);
  }

  /**
   * Calculate confidence for an alternative option.
   * Used to generate confidenceIfChosen values for non-recommended options.
   *
   * @param baseConfidence - Confidence of the chosen option
   * @param differenceFactors - Factors that distinguish this option from chosen
   * @returns Estimated confidence if this alternative had been chosen
   */
  calculateAlternativeConfidence(
    baseConfidence: number,
    differenceFactors: ConsiderationFactor[]
  ): number {
    // Validate base confidence
    const validBaseConfidence = this.clamp(baseConfidence, 0, 100);

    // If no difference factors, the alternative is essentially the same
    if (differenceFactors.length === 0) {
      return validBaseConfidence;
    }

    // Calculate how the difference factors would affect confidence
    // Opposing factors in the difference reduce confidence
    // Supporting factors in the difference increase confidence
    let weightedImpact = 0;
    let totalWeight = 0;

    for (const factor of differenceFactors) {
      if (factor.weight <= 0) {
        continue;
      }

      totalWeight += factor.weight;

      if (factor.impact === 'supports') {
        // Supporting factors for the alternative mean it's a better choice
        // relative to the chosen option, so confidence could be higher
        weightedImpact += factor.weight;
      } else if (factor.impact === 'opposes') {
        // Opposing factors mean the alternative is worse
        weightedImpact -= factor.weight;
      }
      // Neutral factors don't affect the calculation
    }

    // If no weighted factors, return a slightly lower confidence
    // (the alternative is similar but was not chosen for some reason)
    if (totalWeight === 0) {
      return Math.max(0, validBaseConfidence - 10);
    }

    // Calculate the adjustment based on weighted impact
    // Normalize to a reasonable range (-50 to +30)
    // Opposing factors can significantly reduce confidence
    // Supporting factors can moderately increase it (but chosen was still preferred)
    const impactRatio = weightedImpact / totalWeight;
    const adjustment = impactRatio * 40; // Scale to -40 to +40 range

    // Apply adjustment but limit upward adjustment
    // (if the alternative were truly better, it would have been chosen)
    const cappedAdjustment = Math.min(adjustment, 20);

    const alternativeConfidence = validBaseConfidence + cappedAdjustment;

    return this.clamp(alternativeConfidence, 0, 100);
  }

  /**
   * Clamp a value to a specified range.
   *
   * @param value - The value to clamp
   * @param min - Minimum allowed value
   * @param max - Maximum allowed value
   * @returns The clamped value
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
