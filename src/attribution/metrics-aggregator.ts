/**
 * Metrics Aggregator
 *
 * Aggregates attributions into meaningful metrics.
 */

import type {
  ThreeLayerDecision,
  Attribution,
  IndividualMetrics,
  MetricsPeriod,
  DomainMetrics,
  MetricsTrends,
  TrendDirection,
} from './types.js';

/**
 * Interface for metrics aggregation
 */
export interface MetricsAggregator {
  /**
   * Calculate metrics for a user over a period
   */
  calculate(
    userId: string,
    decisions: ThreeLayerDecision[],
    attributions: Attribution[],
    period: MetricsPeriod
  ): IndividualMetrics;
}

/**
 * Default implementation of MetricsAggregator
 */
export class DefaultMetricsAggregator implements MetricsAggregator {
  /**
   * Minimum decisions required for meaningful trend detection
   */
  private readonly minDecisionsForTrend = 5;

  /**
   * Calculate metrics for a user over a period
   */
  calculate(
    userId: string,
    decisions: ThreeLayerDecision[],
    attributions: Attribution[],
    period: MetricsPeriod
  ): IndividualMetrics {
    const totalDecisions = decisions.length;

    // Filter to valid outcomes (non-unknown attributions)
    const validAttributions = attributions.filter((a) => a.whoWasRight !== 'unknown');
    const validOutcomes = validAttributions.length;

    // Handle empty case
    if (totalDecisions === 0) {
      return this.createEmptyMetrics(userId, period);
    }

    // Calculate core metrics
    const interventionRate = this.calculateInterventionRate(decisions);
    const { additiveValue, protegeStandalone, uniqueHuman } = this.calculateValueMetrics(
      validAttributions,
      validOutcomes
    );

    // Calculate domain breakdown
    const domainBreakdown = this.calculateDomainBreakdown(decisions, attributions);

    // Calculate trends
    const trends = this.calculateTrends(decisions, attributions);

    return {
      userId,
      period,
      totalDecisions,
      validOutcomes,
      interventionRate,
      additiveValue,
      protegeStandalone,
      uniqueHuman,
      domainBreakdown,
      trends,
      calculatedAt: new Date(),
    };
  }

  /**
   * Create empty metrics for zero decisions
   */
  private createEmptyMetrics(userId: string, period: MetricsPeriod): IndividualMetrics {
    return {
      userId,
      period,
      totalDecisions: 0,
      validOutcomes: 0,
      interventionRate: 0,
      additiveValue: 0,
      protegeStandalone: 0,
      uniqueHuman: 0,
      domainBreakdown: [],
      trends: {
        interventionRateTrend: 'insufficient_data',
        additiveValueTrend: 'insufficient_data',
        volumeTrend: 'insufficient_data',
      },
      calculatedAt: new Date(),
    };
  }

  /**
   * Calculate intervention rate (overrides / total)
   */
  private calculateInterventionRate(decisions: ThreeLayerDecision[]): number {
    if (decisions.length === 0) return 0;

    const overrides = decisions.filter((d) => d.humanChoice.wasOverride).length;
    return overrides / decisions.length;
  }

  /**
   * Calculate value metrics from attributions
   */
  private calculateValueMetrics(
    attributions: Attribution[],
    validOutcomes: number
  ): { additiveValue: number; protegeStandalone: number; uniqueHuman: number } {
    if (validOutcomes === 0) {
      return { additiveValue: 0, protegeStandalone: 0, uniqueHuman: 0 };
    }

    // Count attributions by category
    let protegeCorrectCount = 0;
    let humanUniqueCount = 0;
    let collaborationCount = 0;

    for (const attr of attributions) {
      // Protégé standalone: protégé was correct
      if (attr.protegeCorrect) {
        protegeCorrectCount++;
      }

      // Human unique value: B = P ≠ H and human correct
      if (attr.whoWasRight === 'human_unique') {
        humanUniqueCount++;
      }

      // Collaboration counts toward additive value
      if (attr.whoWasRight === 'collaboration') {
        collaborationCount++;
      }

      // Protégé wisdom also counts toward additive
      if (attr.whoWasRight === 'protege_wisdom') {
        // Already counted in protegeCorrect
      }
    }

    // Additive value = (protégé wisdom + human unique + collaboration) / total
    // protégé wisdom is where B ≠ P = H and correct
    const protegeWisdomCount = attributions.filter(
      (a) => a.whoWasRight === 'protege_wisdom'
    ).length;

    const additiveValue =
      (protegeWisdomCount + humanUniqueCount + collaborationCount) / validOutcomes;

    const protegeStandalone = protegeCorrectCount / validOutcomes;
    const uniqueHuman = humanUniqueCount / validOutcomes;

    return { additiveValue, protegeStandalone, uniqueHuman };
  }

  /**
   * Calculate metrics breakdown by domain
   */
  private calculateDomainBreakdown(
    decisions: ThreeLayerDecision[],
    attributions: Attribution[]
  ): DomainMetrics[] {
    // Group decisions by domain
    const domainMap = new Map<string, { decisions: ThreeLayerDecision[]; attributions: Attribution[] }>();

    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];
      if (!decision) continue;

      const attribution = attributions[i];
      const domain = decision.domain || 'general';

      if (!domainMap.has(domain)) {
        domainMap.set(domain, { decisions: [], attributions: [] });
      }

      const group = domainMap.get(domain)!;
      group.decisions.push(decision);
      if (attribution) {
        group.attributions.push(attribution);
      }
    }

    // Calculate metrics for each domain
    const domainMetrics: DomainMetrics[] = [];

    for (const [domain, group] of domainMap) {
      const validAttrs = group.attributions.filter((a) => a.whoWasRight !== 'unknown');
      const validCount = validAttrs.length || 1; // Avoid division by zero

      const interventionRate = this.calculateInterventionRate(group.decisions);
      const { additiveValue, protegeStandalone, uniqueHuman } = this.calculateValueMetrics(
        validAttrs,
        validCount
      );

      domainMetrics.push({
        domain,
        totalDecisions: group.decisions.length,
        interventionRate,
        additiveValue,
        protegeStandalone,
        uniqueHuman,
      });
    }

    return domainMetrics;
  }

  /**
   * Calculate trend directions
   */
  private calculateTrends(
    decisions: ThreeLayerDecision[],
    attributions: Attribution[]
  ): MetricsTrends {
    // With insufficient data, can't determine trends
    if (decisions.length < this.minDecisionsForTrend) {
      return {
        interventionRateTrend: 'insufficient_data',
        additiveValueTrend: 'insufficient_data',
        volumeTrend: 'insufficient_data',
      };
    }

    // Simple trend detection based on first half vs second half
    const midpoint = Math.floor(decisions.length / 2);
    const firstHalf = decisions.slice(0, midpoint);
    const secondHalf = decisions.slice(midpoint);

    const firstHalfAttrs = attributions.slice(0, midpoint);
    const secondHalfAttrs = attributions.slice(midpoint);

    // Intervention rate trend
    const firstInterventionRate = this.calculateInterventionRate(firstHalf);
    const secondInterventionRate = this.calculateInterventionRate(secondHalf);
    const interventionRateTrend = this.determineTrend(firstInterventionRate, secondInterventionRate);

    // Additive value trend
    const firstValidAttrs = firstHalfAttrs.filter((a) => a.whoWasRight !== 'unknown');
    const secondValidAttrs = secondHalfAttrs.filter((a) => a.whoWasRight !== 'unknown');
    const firstAdditive = this.calculateValueMetrics(firstValidAttrs, firstValidAttrs.length || 1).additiveValue;
    const secondAdditive = this.calculateValueMetrics(secondValidAttrs, secondValidAttrs.length || 1).additiveValue;
    const additiveValueTrend = this.determineTrend(firstAdditive, secondAdditive);

    // Volume trend
    const volumeTrend = this.determineTrend(firstHalf.length, secondHalf.length);

    return {
      interventionRateTrend,
      additiveValueTrend,
      volumeTrend,
    };
  }

  /**
   * Determine trend direction from two values
   */
  private determineTrend(first: number, second: number): TrendDirection {
    const threshold = 0.1; // 10% change threshold
    const change = second - first;
    const relativeChange = first > 0 ? change / first : change;

    if (relativeChange > threshold) {
      return 'increasing';
    } else if (relativeChange < -threshold) {
      return 'decreasing';
    } else {
      return 'stable';
    }
  }
}
