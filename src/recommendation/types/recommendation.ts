/**
 * Protégé Recommendation Output Types
 *
 * These types represent the personalized recommendation output
 * based on a human's individual knowledge.
 */

/**
 * The personalized recommendation based on the human's knowledge
 */
export interface ProtegeRecommendation {
  /** Recommended option ID */
  optionId: string;

  /** Confidence in this recommendation (0-1) */
  confidence: number;

  /** Step-by-step reasoning in human's terms */
  reasoning: ReasoningStep[];

  /** Principles that were applied */
  appliedPrinciples: AppliedPrinciple[];

  /** How context influenced the recommendation */
  contextInfluence: ContextInfluenceRecord[];

  /** Whether this differs from baseline recommendation */
  differsFromBaseline: boolean;

  /** Explanation of why it differs (if applicable) */
  differenceExplanation?: string;

  /** Warnings or caveats */
  warnings?: RecommendationWarning[];

  /** Metadata about the recommendation process */
  meta: RecommendationMeta;
}

/**
 * Metadata about the recommendation process
 */
export interface RecommendationMeta {
  /** Time taken to generate recommendation (ms) */
  processingTimeMs: number;

  /** Number of principles evaluated */
  principlesEvaluated: number;

  /** Number of principles that matched */
  principlesMatched: number;

  /** Whether any conflicts were resolved */
  hadConflicts: boolean;

  /** Version of the recommendation engine */
  engineVersion: string;
}

/**
 * A single step in the recommendation reasoning
 */
export interface ReasoningStep {
  /** Step number (1-indexed) */
  step: number;

  /** Principle applied in this step (if any) */
  principle?: PrincipleReference;

  /** The logical reasoning for this step */
  logic: string;

  /** Type of reasoning in this step */
  type: 'principle_application' | 'conflict_resolution' | 'context_override' | 'philosophy_application' | 'conclusion';
}

/**
 * Reference to a principle used in reasoning
 */
export interface PrincipleReference {
  /** ID of the principle */
  principleId: string;

  /** Full text of the principle */
  principleText: string;
}

/**
 * A principle that was applied to generate the recommendation
 */
export interface AppliedPrinciple {
  /** ID of the principle */
  principleId: string;

  /** Full text of the principle */
  principleText: string;

  /** Why this principle is relevant to this decision */
  relevance: string;

  /** Weight of this principle (from knowledge store, 0-10 scale) */
  weight: number;

  /** How strongly this principle applied (0-1) */
  strength: number;

  /** Which option this principle favors (if any) */
  favorsOption?: string;
}

/**
 * Record of how context influenced the recommendation
 */
export interface ContextInfluenceRecord {
  /** The context factor (e.g., "current priorities", "energy level") */
  factor: string;

  /** How it affected the recommendation */
  effect: string;

  /** Magnitude of the effect */
  magnitude: 'low' | 'medium' | 'high';
}

/**
 * Warning or caveat about the recommendation
 */
export interface RecommendationWarning {
  /** Type of warning */
  type: 'low_confidence' | 'energy_warning' | 'missing_context' | 'conflict_resolved' | 'boundary_close';

  /** Warning message */
  message: string;

  /** Severity level */
  severity: 'info' | 'warning' | 'critical';
}
