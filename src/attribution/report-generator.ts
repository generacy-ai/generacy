/**
 * Report Generator
 *
 * Generates exportable reports from metrics.
 */

import type {
  IndividualMetrics,
  MetricsReport,
  ReportFormat,
  MetricsSummary,
  DomainBreakdownReport,
  StrengthWeaknessArea,
  DomainMetrics,
} from './types.js';

/**
 * Interface for report generation
 */
export interface ReportGenerator {
  /**
   * Generate a report from metrics
   */
  generateReport(metrics: IndividualMetrics, format: ReportFormat): MetricsReport;

  /**
   * Generate domain breakdown with rankings
   */
  generateDomainBreakdown(metrics: IndividualMetrics): DomainBreakdownReport[];
}

/**
 * Default implementation of ReportGenerator
 */
export class DefaultReportGenerator implements ReportGenerator {
  /**
   * Threshold for high significance (deviation from average)
   */
  private readonly highSignificanceThreshold = 0.3;

  /**
   * Threshold for medium significance
   */
  private readonly mediumSignificanceThreshold = 0.15;

  /**
   * Generate a report from metrics
   */
  generateReport(metrics: IndividualMetrics, format: ReportFormat): MetricsReport {
    const summary = this.createSummary(metrics);
    const domainBreakdown = this.generateDomainBreakdown(metrics);
    const strengths = this.identifyStrengths(metrics);
    const weaknesses = this.identifyWeaknesses(metrics);

    return {
      format,
      userId: metrics.userId,
      period: metrics.period,
      summary,
      domainBreakdown,
      strengths,
      weaknesses,
      generatedAt: new Date(),
    };
  }

  /**
   * Generate domain breakdown with rankings
   */
  generateDomainBreakdown(metrics: IndividualMetrics): DomainBreakdownReport[] {
    if (metrics.domainBreakdown.length === 0) {
      return [];
    }

    // Sort by total decisions (descending)
    const sorted = [...metrics.domainBreakdown].sort(
      (a, b) => b.totalDecisions - a.totalDecisions
    );

    return sorted.map((domain, index) => ({
      domain: domain.domain,
      metrics: domain,
      rank: index + 1,
      percentageOfTotal:
        metrics.totalDecisions > 0 ? domain.totalDecisions / metrics.totalDecisions : 0,
    }));
  }

  /**
   * Create summary from metrics
   */
  private createSummary(metrics: IndividualMetrics): MetricsSummary {
    return {
      totalDecisions: metrics.totalDecisions,
      validOutcomes: metrics.validOutcomes,
      interventionRate: metrics.interventionRate,
      additiveValue: metrics.additiveValue,
      protegeStandalone: metrics.protegeStandalone,
      uniqueHuman: metrics.uniqueHuman,
      trends: metrics.trends,
    };
  }

  /**
   * Identify strongest areas
   */
  private identifyStrengths(metrics: IndividualMetrics): StrengthWeaknessArea[] {
    if (metrics.domainBreakdown.length === 0) {
      return [];
    }

    const strengths: StrengthWeaknessArea[] = [];
    const metricsToAnalyze = ['additiveValue', 'protegeStandalone', 'uniqueHuman'] as const;

    for (const metricName of metricsToAnalyze) {
      const average = this.calculateAverage(metrics.domainBreakdown, metricName);

      for (const domain of metrics.domainBreakdown) {
        const value = domain[metricName];
        const deviation = average > 0 ? (value - average) / average : value;

        if (deviation > 0) {
          const significance = this.determineSignificance(deviation);
          strengths.push({
            domain: domain.domain,
            metric: metricName,
            value,
            comparison: 'above_average',
            significance,
          });
        }
      }
    }

    // Sort by significance and deviation
    return strengths.sort((a, b) => {
      const sigOrder = { high: 3, medium: 2, low: 1 };
      return sigOrder[b.significance] - sigOrder[a.significance];
    });
  }

  /**
   * Identify weakest areas
   */
  private identifyWeaknesses(metrics: IndividualMetrics): StrengthWeaknessArea[] {
    if (metrics.domainBreakdown.length === 0) {
      return [];
    }

    const weaknesses: StrengthWeaknessArea[] = [];
    const metricsToAnalyze = ['additiveValue', 'protegeStandalone', 'uniqueHuman'] as const;

    for (const metricName of metricsToAnalyze) {
      const average = this.calculateAverage(metrics.domainBreakdown, metricName);

      for (const domain of metrics.domainBreakdown) {
        const value = domain[metricName];
        const deviation = average > 0 ? (value - average) / average : 0;

        if (deviation < 0) {
          const significance = this.determineSignificance(Math.abs(deviation));
          weaknesses.push({
            domain: domain.domain,
            metric: metricName,
            value,
            comparison: 'below_average',
            significance,
          });
        }
      }
    }

    // Sort by significance (most significant weaknesses first)
    return weaknesses.sort((a, b) => {
      const sigOrder = { high: 3, medium: 2, low: 1 };
      return sigOrder[b.significance] - sigOrder[a.significance];
    });
  }

  /**
   * Calculate average for a metric across domains
   */
  private calculateAverage(
    domains: DomainMetrics[],
    metricName: keyof Pick<DomainMetrics, 'additiveValue' | 'protegeStandalone' | 'uniqueHuman'>
  ): number {
    if (domains.length === 0) return 0;
    const sum = domains.reduce((acc, d) => acc + d[metricName], 0);
    return sum / domains.length;
  }

  /**
   * Determine significance level from deviation
   */
  private determineSignificance(deviation: number): 'high' | 'medium' | 'low' {
    if (deviation >= this.highSignificanceThreshold) {
      return 'high';
    } else if (deviation >= this.mediumSignificanceThreshold) {
      return 'medium';
    } else {
      return 'low';
    }
  }
}
