/**
 * Local contract interfaces for the baseline recommendation generator.
 * These types define the data structures used for generating baseline recommendations
 * for architectural and technical decisions.
 */

// ============================================================================
// Decision Request Types (T001)
// ============================================================================

/**
 * Represents a single option in a decision request.
 */
export interface DecisionOption {
  /** Unique identifier for the option */
  id: string;
  /** Display name of the option */
  name: string;
  /** Detailed description of what this option entails */
  description: string;
  /** List of advantages for this option */
  pros?: string[];
  /** List of disadvantages for this option */
  cons?: string[];
  /** Additional metadata associated with the option */
  metadata?: Record<string, unknown>;
}

/**
 * Represents the project context in which a decision is being made.
 */
export interface ProjectContext {
  /** Name of the project */
  name: string;
  /** Description of the project */
  description?: string;
  /** Current technology stack in use */
  techStack?: string[];
  /** Number of team members */
  teamSize?: number;
  /** Current phase of the project lifecycle */
  phase?: 'planning' | 'development' | 'maintenance';
  /** Business domain of the project */
  domain?: string;
  /** Any additional context as key-value pairs */
  additionalContext?: Record<string, string>;
}

/**
 * Constraints that must be considered when making a decision.
 */
export interface DecisionConstraints {
  /** Deadline by which the decision must be implemented */
  deadline?: Date;
  /** Budget constraints for the decision */
  budget?: { amount: number; currency: string };
  /** Features that must be supported by the chosen option */
  requiredFeatures?: string[];
  /** Technologies that cannot be used */
  excludedTechnologies?: string[];
}

/**
 * A request for a decision recommendation.
 * Contains all the information needed to generate a baseline recommendation.
 */
export interface DecisionRequest {
  /** Unique identifier for the request */
  id: string;
  /** Description of the decision to be made */
  description: string;
  /** Available options to choose from */
  options: DecisionOption[];
  /** Project context for the decision */
  context: ProjectContext;
  /** Optional constraints to consider */
  constraints?: DecisionConstraints;
  /** Timestamp when the request was created */
  requestedAt: Date;
}

// ============================================================================
// Baseline Recommendation Types (T002)
// ============================================================================

/**
 * A factor that was considered when generating the recommendation.
 */
export interface ConsiderationFactor {
  /** Name of the factor (e.g., "team experience", "scalability") */
  name: string;
  /** Value or assessment of the factor */
  value: string;
  /** Weight of this factor in the decision (0-1) */
  weight: number;
  /** Whether this factor supports, opposes, or is neutral to the recommendation */
  impact: 'supports' | 'opposes' | 'neutral';
  /** Additional explanation of how this factor influenced the decision */
  explanation?: string;
}

/**
 * Analysis of why an alternative option was not chosen.
 */
export interface AlternativeAnalysis {
  /** ID of the alternative option */
  optionId: string;
  /** Explanation of why this option was not recommended */
  whyNotChosen: string;
  /** Confidence score if this option had been chosen (0-100) */
  confidenceIfChosen: number;
  /** Key differences from the recommended option */
  keyDifferences?: string[];
}

/**
 * The generated baseline recommendation.
 * Contains the recommended option along with reasoning and analysis.
 */
export interface BaselineRecommendation {
  /** ID of the recommended option */
  optionId: string;
  /** Confidence in the recommendation (0-100) */
  confidence: number;
  /** List of reasons supporting the recommendation */
  reasoning: string[];
  /** Factors that were considered in making the recommendation */
  factors: ConsiderationFactor[];
  /** Analysis of alternative options that were not chosen */
  alternativeOptionAnalysis: AlternativeAnalysis[];
  /** Timestamp when the recommendation was generated */
  generatedAt: Date;
  /** Snapshot of the configuration used to generate this recommendation */
  configSnapshot: BaselineConfig;
}

// ============================================================================
// Configuration Types (T003)
// ============================================================================

/**
 * Configuration for which factors to consider in the recommendation.
 */
export interface FactorConfig {
  /** Whether to consider the overall project context */
  projectContext: boolean;
  /** Whether to consider domain-specific best practices */
  domainBestPractices: boolean;
  /** Whether to consider team size when making recommendations */
  teamSize: boolean;
  /** Whether to consider the existing technology stack */
  existingStack: boolean;
}

/**
 * Configuration for the baseline recommendation generator.
 */
export interface BaselineConfig {
  /** Configuration for which factors to consider */
  factors: FactorConfig;
  /** Minimum confidence threshold for a recommendation (0-100) */
  confidenceThreshold: number;
  /** Whether reasoning must be provided with recommendations */
  requireReasoning: boolean;
}

/**
 * Default configuration for the baseline recommendation generator.
 * Enables all factors with a 50% confidence threshold and required reasoning.
 */
export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  factors: {
    projectContext: true,
    domainBestPractices: true,
    teamSize: true,
    existingStack: true,
  },
  confidenceThreshold: 50,
  requireReasoning: true,
};
