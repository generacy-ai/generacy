/**
 * Attribution Calculation Engine
 *
 * Public exports for the attribution module - determines which layer
 * (baseline, protégé, or human) added value in each decision.
 */

// Types
export type {
  // Decision and outcome types
  ThreeLayerDecision,
  DecisionRequestRef,
  LayerChoice,
  HumanDecision,
  DecisionOutcome,
  OutcomeResult,
  // Attribution types
  Attribution,
  AttributionCategory,
  ValueSource,
  // Assessment types
  OutcomeAssessment,
  AssessmentMethod,
  // Counterfactual types
  CounterfactualAnalysis,
  CounterfactualResult,
  // Metrics types
  IndividualMetrics,
  MetricsPeriod,
  DomainMetrics,
  MetricsTrends,
  TrendDirection,
  // Report types
  ReportFormat,
  MetricsReport,
  MetricsSummary,
  DomainBreakdownReport,
  StrengthWeaknessArea,
} from './types.js';

// Interfaces
export type { OutcomeEvaluator } from './outcome-evaluator.js';
export type { CounterfactualAnalyzer } from './counterfactual-analyzer.js';
export type { AttributionCalculator } from './attribution-calculator.js';
export type { MetricsAggregator } from './metrics-aggregator.js';
export type { ReportGenerator } from './report-generator.js';

// Default implementations
export { DefaultOutcomeEvaluator } from './outcome-evaluator.js';
export { DefaultCounterfactualAnalyzer } from './counterfactual-analyzer.js';
export { DefaultAttributionCalculator } from './attribution-calculator.js';
export { DefaultMetricsAggregator } from './metrics-aggregator.js';
export { DefaultReportGenerator } from './report-generator.js';

// Factory functions
import { DefaultOutcomeEvaluator } from './outcome-evaluator.js';
import { DefaultCounterfactualAnalyzer } from './counterfactual-analyzer.js';
import { DefaultAttributionCalculator } from './attribution-calculator.js';
import { DefaultMetricsAggregator } from './metrics-aggregator.js';
import { DefaultReportGenerator } from './report-generator.js';
import type { AttributionCalculator } from './attribution-calculator.js';
import type { MetricsAggregator } from './metrics-aggregator.js';
import type { ReportGenerator } from './report-generator.js';

/**
 * Create a fully wired attribution calculator with default dependencies
 */
export function createAttributionCalculator(): AttributionCalculator {
  const outcomeEvaluator = new DefaultOutcomeEvaluator();
  const counterfactualAnalyzer = new DefaultCounterfactualAnalyzer(outcomeEvaluator);
  return new DefaultAttributionCalculator(outcomeEvaluator, counterfactualAnalyzer);
}

/**
 * Create a metrics aggregator with default configuration
 */
export function createMetricsAggregator(): MetricsAggregator {
  return new DefaultMetricsAggregator();
}

/**
 * Create a report generator with default configuration
 */
export function createReportGenerator(): ReportGenerator {
  return new DefaultReportGenerator();
}
