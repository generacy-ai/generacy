/**
 * Difference Explainer Utility
 *
 * Explains differences between protégé and baseline recommendations:
 * - Identifies when options differ
 * - Explains driving principles and context factors
 * - Generates structured comparisons
 */

import type {
  ProtegeRecommendation,
  BaselineRecommendation,
  DifferenceExplanation,
  DifferenceComparison,
  AppliedPrinciple,
  ContextInfluenceRecord,
} from '../types/index.js';

/**
 * Check if protégé and baseline recommendations differ
 *
 * @param protege - Protégé recommendation
 * @param baseline - Baseline recommendation
 * @returns True if recommendations differ
 */
export function hasDifference(
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): boolean {
  return protege.optionId !== baseline.optionId;
}

/**
 * Explain the difference between protégé and baseline recommendations
 *
 * @param protege - Protégé recommendation
 * @param baseline - Baseline recommendation
 * @returns Detailed explanation of differences
 */
export function explainDifference(
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): DifferenceExplanation {
  const differentOption = hasDifference(protege, baseline);

  // Identify driving principles (those that favor the protégé option)
  const drivingPrinciples = identifyDrivingPrinciples(protege, baseline);

  // Identify driving context factors
  const drivingContext = identifyDrivingContext(protege, baseline);

  // Generate primary reason
  const primaryReason = generatePrimaryReason(
    differentOption,
    drivingPrinciples,
    drivingContext,
    protege,
    baseline
  );

  // Generate structured comparison
  const comparison = generateComparison(protege, baseline);

  return {
    differentOption,
    primaryReason,
    drivingPrinciples,
    drivingContext,
    comparison,
  };
}

/**
 * Identify principles that drove the difference
 */
function identifyDrivingPrinciples(
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): AppliedPrinciple[] {
  const principles = protege.appliedPrinciples || [];

  if (!hasDifference(protege, baseline)) {
    // If options match, return principles that support the shared choice
    return principles.filter((p) => p.favorsOption === protege.optionId);
  }

  // Return principles that favor the protégé option
  const driving = principles.filter((p) => p.favorsOption === protege.optionId);

  // If no principles explicitly favor the protégé option, return the highest-weighted ones
  if (driving.length === 0 && principles.length > 0) {
    const sorted = [...principles].sort((a, b) => (b.weight * b.strength) - (a.weight * a.strength));
    return sorted.slice(0, Math.min(3, sorted.length));
  }

  return driving;
}

/**
 * Identify context factors that drove the difference
 */
function identifyDrivingContext(
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): ContextInfluenceRecord[] {
  const context = protege.contextInfluence || [];

  if (!hasDifference(protege, baseline)) {
    // If options match, return high-magnitude factors
    return context.filter((c) => c.magnitude === 'high');
  }

  // Return high and medium magnitude factors
  return context.filter((c) => c.magnitude === 'high' || c.magnitude === 'medium');
}

/**
 * Generate primary reason for the difference (or alignment)
 */
function generatePrimaryReason(
  differentOption: boolean,
  drivingPrinciples: AppliedPrinciple[],
  drivingContext: ContextInfluenceRecord[],
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): string {
  if (!differentOption) {
    const firstPrinciple = drivingPrinciples[0];
    if (firstPrinciple) {
      return `Both baseline analysis and personal principles align on "${protege.optionId}". Key principle: "${firstPrinciple.principleText.substring(0, 50)}..."`;
    }
    return `Both baseline analysis and personal evaluation recommend "${protege.optionId}".`;
  }

  // Different options - explain why
  const reasons: string[] = [];

  const topPrinciple = drivingPrinciples[0];
  if (topPrinciple) {
    reasons.push(
      `Personal principle "${topPrinciple.principleText.substring(0, 40)}..." favors "${protege.optionId}" over the baseline's "${baseline.optionId}"`
    );
  }

  const topContext = drivingContext[0];
  if (topContext) {
    reasons.push(`Current context (${topContext.factor}: ${topContext.effect}) influenced the choice`);
  }

  if (reasons.length === 0) {
    return `Protégé recommends "${protege.optionId}" while baseline suggests "${baseline.optionId}" based on personal philosophy alignment.`;
  }

  return reasons.join('. ') + '.';
}

/**
 * Generate structured comparison between protégé and baseline
 */
function generateComparison(
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): DifferenceComparison[] {
  const comparisons: DifferenceComparison[] = [];

  // Compare recommended options
  comparisons.push({
    aspect: 'Recommended Option',
    baseline: baseline.optionId,
    protege: protege.optionId,
  });

  // Compare confidence levels
  comparisons.push({
    aspect: 'Confidence',
    baseline: `${(baseline.confidence * 100).toFixed(0)}%`,
    protege: `${(protege.confidence * 100).toFixed(0)}%`,
  });

  // Compare reasoning approach
  const baselineReasoningSummary = typeof baseline.reasoning === 'string'
    ? baseline.reasoning.substring(0, 50) + (baseline.reasoning.length > 50 ? '...' : '')
    : 'Objective analysis';

  const protegeReasoningSummary = protege.reasoning.length > 0
    ? `${protege.reasoning.length} reasoning steps based on personal principles`
    : 'No reasoning steps generated';

  comparisons.push({
    aspect: 'Reasoning Approach',
    baseline: baselineReasoningSummary,
    protege: protegeReasoningSummary,
  });

  // Compare factors considered
  const baselineFactors = baseline.factors?.length || 0;
  const protegeFactors = protege.appliedPrinciples?.length || 0;

  comparisons.push({
    aspect: 'Factors Considered',
    baseline: `${baselineFactors} objective factor(s)`,
    protege: `${protegeFactors} personal principle(s)`,
  });

  return comparisons;
}

/**
 * Generate a human-readable summary of the difference
 */
export function generateDifferenceSummary(
  protege: ProtegeRecommendation,
  baseline: BaselineRecommendation
): string {
  const explanation = explainDifference(protege, baseline);

  if (!explanation.differentOption) {
    return `Both analyses agree: "${protege.optionId}" is the recommended choice.`;
  }

  const parts: string[] = [];
  parts.push(`The personalized recommendation ("${protege.optionId}") differs from the objective baseline ("${baseline.optionId}").`);
  parts.push(explanation.primaryReason);

  if (explanation.drivingPrinciples.length > 0) {
    parts.push(`Key principles: ${explanation.drivingPrinciples.map((p) => `"${p.principleText.substring(0, 30)}..."`).join(', ')}.`);
  }

  return parts.join(' ');
}
