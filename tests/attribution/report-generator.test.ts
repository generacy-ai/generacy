/**
 * ReportGenerator Tests
 *
 * Tests for generating exportable reports from metrics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultReportGenerator,
  type ReportGenerator,
} from '../../src/attribution/report-generator.js';
import type {
  IndividualMetrics,
  MetricsPeriod,
  DomainMetrics,
  MetricsReport,
  ReportFormat,
  DomainBreakdownReport,
  StrengthWeaknessArea,
} from '../../src/attribution/types.js';

describe('ReportGenerator', () => {
  let generator: ReportGenerator;

  beforeEach(() => {
    generator = new DefaultReportGenerator();
  });

  const testPeriod: MetricsPeriod = {
    start: new Date('2024-01-01'),
    end: new Date('2024-01-31'),
    type: 'month',
  };

  // Helper to create test metrics
  const createTestMetrics = (overrides: Partial<IndividualMetrics> = {}): IndividualMetrics => ({
    userId: 'user-1',
    period: testPeriod,
    totalDecisions: 100,
    validOutcomes: 90,
    interventionRate: 0.25,
    additiveValue: 0.35,
    protegeStandalone: 0.6,
    uniqueHuman: 0.15,
    domainBreakdown: [
      {
        domain: 'engineering',
        totalDecisions: 50,
        interventionRate: 0.3,
        additiveValue: 0.4,
        protegeStandalone: 0.65,
        uniqueHuman: 0.2,
      },
      {
        domain: 'marketing',
        totalDecisions: 30,
        interventionRate: 0.2,
        additiveValue: 0.3,
        protegeStandalone: 0.55,
        uniqueHuman: 0.1,
      },
      {
        domain: 'sales',
        totalDecisions: 20,
        interventionRate: 0.25,
        additiveValue: 0.35,
        protegeStandalone: 0.6,
        uniqueHuman: 0.15,
      },
    ],
    trends: {
      interventionRateTrend: 'stable',
      additiveValueTrend: 'increasing',
      volumeTrend: 'increasing',
    },
    calculatedAt: new Date(),
    ...overrides,
  });

  describe('JSON Report Generation', () => {
    it('should generate a JSON format report', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'json');

      expect(report.format).toBe('json');
      expect(report.userId).toBe('user-1');
      expect(report.period).toEqual(testPeriod);
    });

    it('should include all core metrics in summary', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'json');

      expect(report.summary.totalDecisions).toBe(100);
      expect(report.summary.validOutcomes).toBe(90);
      expect(report.summary.interventionRate).toBe(0.25);
      expect(report.summary.additiveValue).toBe(0.35);
      expect(report.summary.protegeStandalone).toBe(0.6);
      expect(report.summary.uniqueHuman).toBe(0.15);
    });

    it('should include trends in summary', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'json');

      expect(report.summary.trends).toEqual(metrics.trends);
    });

    it('should include domain breakdown', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'json');

      expect(report.domainBreakdown).toBeDefined();
      expect(report.domainBreakdown!.length).toBe(3);
    });
  });

  describe('Summary Report Generation', () => {
    it('should generate a summary format report', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'summary');

      expect(report.format).toBe('summary');
    });

    it('should still include core metrics in summary format', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'summary');

      expect(report.summary).toBeDefined();
      expect(report.summary.totalDecisions).toBe(100);
    });
  });

  describe('Domain Breakdown Report', () => {
    it('should generate domain breakdown with rankings', () => {
      const metrics = createTestMetrics();
      const breakdown = generator.generateDomainBreakdown(metrics);

      expect(breakdown.length).toBe(3);
      // Should be ranked by total decisions (engineering first)
      expect(breakdown[0].domain).toBe('engineering');
      expect(breakdown[0].rank).toBe(1);
    });

    it('should include percentage of total for each domain', () => {
      const metrics = createTestMetrics();
      const breakdown = generator.generateDomainBreakdown(metrics);

      const engineering = breakdown.find((d) => d.domain === 'engineering');
      expect(engineering?.percentageOfTotal).toBeCloseTo(0.5, 2); // 50/100
    });

    it('should include full metrics for each domain', () => {
      const metrics = createTestMetrics();
      const breakdown = generator.generateDomainBreakdown(metrics);

      const marketing = breakdown.find((d) => d.domain === 'marketing');
      expect(marketing?.metrics.interventionRate).toBe(0.2);
      expect(marketing?.metrics.additiveValue).toBe(0.3);
    });
  });

  describe('Strengths Identification', () => {
    it('should identify strongest areas', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'json');

      expect(report.strengths).toBeDefined();
      expect(report.strengths.length).toBeGreaterThan(0);
    });

    it('should identify domain with highest unique human contribution', () => {
      const metrics = createTestMetrics({
        domainBreakdown: [
          {
            domain: 'engineering',
            totalDecisions: 50,
            interventionRate: 0.3,
            additiveValue: 0.4,
            protegeStandalone: 0.65,
            uniqueHuman: 0.35, // Highest
          },
          {
            domain: 'marketing',
            totalDecisions: 30,
            interventionRate: 0.2,
            additiveValue: 0.3,
            protegeStandalone: 0.55,
            uniqueHuman: 0.1,
          },
        ],
      });

      const report = generator.generateReport(metrics, 'json');
      const humanStrength = report.strengths.find(
        (s) => s.metric === 'uniqueHuman' && s.domain === 'engineering'
      );

      expect(humanStrength).toBeDefined();
      expect(humanStrength?.comparison).toBe('above_average');
    });

    it('should mark high significance for large deviations', () => {
      const metrics = createTestMetrics({
        domainBreakdown: [
          {
            domain: 'engineering',
            totalDecisions: 50,
            interventionRate: 0.3,
            additiveValue: 0.7, // Much higher than average
            protegeStandalone: 0.65,
            uniqueHuman: 0.2,
          },
          {
            domain: 'marketing',
            totalDecisions: 50,
            interventionRate: 0.2,
            additiveValue: 0.1, // Much lower
            protegeStandalone: 0.55,
            uniqueHuman: 0.1,
          },
        ],
      });

      const report = generator.generateReport(metrics, 'json');
      const highStrength = report.strengths.find(
        (s) => s.significance === 'high' && s.domain === 'engineering'
      );

      expect(highStrength).toBeDefined();
    });
  });

  describe('Weaknesses Identification', () => {
    it('should identify weakest areas', () => {
      const metrics = createTestMetrics();
      const report = generator.generateReport(metrics, 'json');

      expect(report.weaknesses).toBeDefined();
    });

    it('should identify domain with lowest additive value', () => {
      const metrics = createTestMetrics({
        domainBreakdown: [
          {
            domain: 'engineering',
            totalDecisions: 50,
            interventionRate: 0.3,
            additiveValue: 0.5, // Higher
            protegeStandalone: 0.65,
            uniqueHuman: 0.2,
          },
          {
            domain: 'marketing',
            totalDecisions: 30,
            interventionRate: 0.2,
            additiveValue: 0.1, // Lowest
            protegeStandalone: 0.55,
            uniqueHuman: 0.1,
          },
        ],
      });

      const report = generator.generateReport(metrics, 'json');
      const weakness = report.weaknesses.find(
        (w) => w.metric === 'additiveValue' && w.domain === 'marketing'
      );

      expect(weakness).toBeDefined();
      expect(weakness?.comparison).toBe('below_average');
    });
  });

  describe('Report Timestamp', () => {
    it('should include generation timestamp', () => {
      const metrics = createTestMetrics();
      const before = new Date();
      const report = generator.generateReport(metrics, 'json');
      const after = new Date();

      expect(report.generatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(report.generatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('Edge Cases', () => {
    it('should handle metrics with no domain breakdown', () => {
      const metrics = createTestMetrics({ domainBreakdown: [] });
      const report = generator.generateReport(metrics, 'json');

      expect(report.domainBreakdown).toEqual([]);
      expect(report.strengths).toEqual([]);
      expect(report.weaknesses).toEqual([]);
    });

    it('should handle single domain', () => {
      const metrics = createTestMetrics({
        domainBreakdown: [
          {
            domain: 'engineering',
            totalDecisions: 100,
            interventionRate: 0.25,
            additiveValue: 0.35,
            protegeStandalone: 0.6,
            uniqueHuman: 0.15,
          },
        ],
      });

      const report = generator.generateReport(metrics, 'json');

      expect(report.domainBreakdown!.length).toBe(1);
      expect(report.domainBreakdown![0].percentageOfTotal).toBe(1);
    });

    it('should handle zero decisions', () => {
      const metrics = createTestMetrics({
        totalDecisions: 0,
        validOutcomes: 0,
        interventionRate: 0,
        additiveValue: 0,
        protegeStandalone: 0,
        uniqueHuman: 0,
        domainBreakdown: [],
      });

      const report = generator.generateReport(metrics, 'json');

      expect(report.summary.totalDecisions).toBe(0);
      expect(report.domainBreakdown).toEqual([]);
    });
  });
});
