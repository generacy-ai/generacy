/**
 * Attribution Calculation Engine Types
 *
 * Types for calculating attribution - determining which layer (baseline, protégé, or human)
 * added value in each decision.
 */

// ============================================================================
// Decision and Outcome Types
// ============================================================================

/**
 * Represents a complete decision with all three layer choices.
 */
export interface ThreeLayerDecision {
  /** Unique decision identifier */
  id: string;

  /** Original decision request */
  request: DecisionRequestRef;

  /** Baseline layer recommendation */
  baseline: LayerChoice;

  /** Protégé layer recommendation */
  protege: LayerChoice;

  /** Human's final choice */
  humanChoice: HumanDecision;

  /** Domain of the decision */
  domain?: string;

  /** Timestamp of the final decision */
  decidedAt: Date;
}

/**
 * Reference to a decision request (minimal for attribution purposes)
 */
export interface DecisionRequestRef {
  /** Decision request ID */
  id: string;

  /** Decision description */
  description: string;

  /** Available option IDs */
  optionIds: string[];
}

/**
 * A layer's choice in a decision
 */
export interface LayerChoice {
  /** ID of the chosen option */
  optionId: string;

  /** Confidence in the choice (0-1) */
  confidence: number;
}

/**
 * Human's final decision
 */
export interface HumanDecision {
  /** ID of the chosen option */
  optionId: string;

  /** Whether human overrode the recommendation */
  wasOverride: boolean;

  /** Human's reasoning for override (if any) */
  overrideReason?: string;

  /** User who made the decision */
  userId: string;
}

/**
 * Records what actually happened after a decision was made.
 */
export interface DecisionOutcome {
  /** Links to the decision */
  decisionId: string;

  /** The actual result */
  result: OutcomeResult;

  /** When the outcome was recorded */
  recordedAt: Date;

  /** Evidence supporting the outcome assessment */
  evidence: string[];

  /** Optional notes */
  notes?: string;
}

/**
 * The result of a decision outcome
 */
export type OutcomeResult =
  | { status: 'success'; details: string }
  | { status: 'failure'; details: string; severity: 'minor' | 'major' | 'critical' }
  | { status: 'partial'; successRate: number; details: string }
  | { status: 'unknown'; reason: string };

// ============================================================================
// Attribution Types
// ============================================================================

/**
 * The result of attribution calculation for a single decision.
 */
export interface Attribution {
  /** Links to the decision */
  decisionId: string;

  /** Which layer was correct */
  baselineCorrect: boolean | null;
  protegeCorrect: boolean | null;
  humanCorrect: boolean | null;

  /** Attribution category */
  whoWasRight: AttributionCategory;

  /** Value source */
  valueSource: ValueSource;

  /** Confidence in this attribution (0-1) */
  confidence: number;

  /** Counterfactual analysis */
  counterfactual?: CounterfactualAnalysis;

  /** When attribution was calculated */
  calculatedAt: Date;
}

/**
 * Attribution category - who was right in a decision
 */
export type AttributionCategory =
  | 'all_aligned' // B = P = H, all correct
  | 'human_unique' // B = P ≠ H, human correct
  | 'protege_wisdom' // B ≠ P = H, protégé/human correct
  | 'collaboration' // B ≠ P ≠ H, human correct
  | 'baseline_only' // B ✓, P/H wrong
  | 'protege_wrong' // B ✓, P diverged incorrectly
  | 'human_wrong' // P ✓, H overrode incorrectly
  | 'all_wrong' // Everyone was wrong
  | 'unknown'; // Cannot determine

/**
 * Source of value in a decision
 */
export type ValueSource =
  | 'system' // Baseline/automated was right
  | 'protege_wisdom' // Protégé learned wisdom proved valuable
  | 'human_judgment' // Human unique insight was key
  | 'collaboration' // Combined effort was needed
  | 'none'; // No value source identified

// ============================================================================
// Outcome Assessment Types
// ============================================================================

/**
 * Evaluation of whether a specific choice worked.
 */
export interface OutcomeAssessment {
  /** Whether the choice worked */
  worked: boolean | null;

  /** Confidence in this assessment (0-1) */
  confidence: number;

  /** Evidence supporting the assessment */
  evidence: string[];

  /** Assessment method used */
  method: AssessmentMethod;
}

/**
 * Method used for outcome assessment
 */
export type AssessmentMethod =
  | 'direct_observation' // Outcome directly observed
  | 'proxy_metric' // Inferred from proxy metrics
  | 'expert_review' // Human expert assessment
  | 'automated'; // Automated validation

// ============================================================================
// Counterfactual Analysis Types
// ============================================================================

/**
 * What-if analysis for alternative choices.
 */
export interface CounterfactualAnalysis {
  /** What would baseline have produced? */
  baselineAlternative?: CounterfactualResult;

  /** What would protégé have produced? */
  protegeAlternative?: CounterfactualResult;
}

/**
 * Result of a counterfactual analysis
 */
export interface CounterfactualResult {
  /** The alternative outcome */
  alternativeOutcome: string;

  /** Would it have worked? */
  wouldHaveWorked: boolean | null;

  /** Confidence in this counterfactual (0-1) */
  confidence: number;

  /** Reasoning for the counterfactual assessment */
  reasoning: string;
}

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Aggregated metrics for a user over a period.
 */
export interface IndividualMetrics {
  /** User these metrics are for */
  userId: string;

  /** Time period covered */
  period: MetricsPeriod;

  /** Total decisions in period */
  totalDecisions: number;

  /** Decisions with known outcomes */
  validOutcomes: number;

  /** Core metrics */
  interventionRate: number; // Overrides / total
  additiveValue: number; // (protégé + human unique) / total
  protegeStandalone: number; // Protégé correct / total
  uniqueHuman: number; // Human unique / total

  /** Domain breakdown */
  domainBreakdown: DomainMetrics[];

  /** Trend indicators */
  trends: MetricsTrends;

  /** When metrics were calculated */
  calculatedAt: Date;
}

/**
 * Time period for metrics
 */
export interface MetricsPeriod {
  start: Date;
  end: Date;
  type: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
}

/**
 * Metrics for a specific domain
 */
export interface DomainMetrics {
  domain: string;
  totalDecisions: number;
  interventionRate: number;
  additiveValue: number;
  protegeStandalone: number;
  uniqueHuman: number;
}

/**
 * Trend indicators for metrics
 */
export interface MetricsTrends {
  interventionRateTrend: TrendDirection;
  additiveValueTrend: TrendDirection;
  volumeTrend: TrendDirection;
}

/**
 * Direction of a trend
 */
export type TrendDirection = 'increasing' | 'decreasing' | 'stable' | 'insufficient_data';

// ============================================================================
// Report Types
// ============================================================================

/**
 * Report format options
 */
export type ReportFormat = 'json' | 'summary';

/**
 * Generated report from metrics
 */
export interface MetricsReport {
  /** Format of the report */
  format: ReportFormat;

  /** User ID */
  userId: string;

  /** Report period */
  period: MetricsPeriod;

  /** Core metrics summary */
  summary: MetricsSummary;

  /** Domain breakdown */
  domainBreakdown: DomainBreakdownReport[];

  /** Strongest and weakest areas */
  strengths: StrengthWeaknessArea[];
  weaknesses: StrengthWeaknessArea[];

  /** Generated at timestamp */
  generatedAt: Date;
}

/**
 * Summary of core metrics for reports
 */
export interface MetricsSummary {
  totalDecisions: number;
  validOutcomes: number;
  interventionRate: number;
  additiveValue: number;
  protegeStandalone: number;
  uniqueHuman: number;
  trends: MetricsTrends;
}

/**
 * Domain breakdown for reports
 */
export interface DomainBreakdownReport {
  domain: string;
  metrics: DomainMetrics;
  rank: number;
  percentageOfTotal: number;
}

/**
 * Identified strength or weakness area
 */
export interface StrengthWeaknessArea {
  domain: string;
  metric: string;
  value: number;
  comparison: 'above_average' | 'below_average';
  significance: 'high' | 'medium' | 'low';
}
