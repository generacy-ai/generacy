/**
 * Baseline Recommendation Types
 * Interim types until generacy-ai/contracts package provides canonical versions
 *
 * The baseline recommendation represents the "objectively optimal" recommendation
 * from the first layer of the three-layer decision model.
 */

/**
 * The baseline (objective) recommendation for a decision
 */
export interface BaselineRecommendation {
  /** Recommended option ID */
  optionId: string;

  /** Plain language reasoning for the recommendation */
  reasoning: string;

  /** Confidence in this recommendation (0-1) */
  confidence: number;

  /** Factors that contributed to this recommendation */
  factors: BaselineFactor[];
}

/**
 * A factor that contributed to the baseline recommendation
 */
export interface BaselineFactor {
  /** Factor name (e.g., "cost efficiency", "time to completion") */
  name: string;

  /** How much this factor contributed (-1 to 1, negative = against) */
  contribution: number;

  /** Human-readable explanation of this factor's influence */
  explanation: string;
}
