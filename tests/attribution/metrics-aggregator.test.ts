/**
 * MetricsAggregator Tests
 *
 * Tests for aggregating attributions into meaningful metrics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultMetricsAggregator,
  type MetricsAggregator,
} from '../../src/attribution/metrics-aggregator.js';
import type {
  Attribution,
  ThreeLayerDecision,
  IndividualMetrics,
  MetricsPeriod,
  DomainMetrics,
  TrendDirection,
} from '../../src/attribution/types.js';

describe('MetricsAggregator', () => {
  let aggregator: MetricsAggregator;

  beforeEach(() => {
    aggregator = new DefaultMetricsAggregator();
  });

  // Helper to create a test attribution
  const createAttribution = (
    category: Attribution['whoWasRight'],
    valueSource: Attribution['valueSource'],
    overrides: Partial<Attribution> = {}
  ): Attribution => ({
    decisionId: `decision-${Date.now()}-${Math.random()}`,
    baselineCorrect: category !== 'all_wrong' && category !== 'unknown',
    protegeCorrect: ['all_aligned', 'protege_wisdom', 'baseline_only'].includes(category),
    humanCorrect: !['all_wrong', 'human_wrong', 'unknown'].includes(category),
    whoWasRight: category,
    valueSource,
    confidence: category === 'unknown' ? 0 : 0.8,
    calculatedAt: new Date(),
    ...overrides,
  });

  // Helper to create a test decision
  const createDecision = (
    domain: string = 'general',
    wasOverride: boolean = false
  ): ThreeLayerDecision => ({
    id: `decision-${Date.now()}-${Math.random()}`,
    request: {
      id: 'request-1',
      description: 'Test decision',
      optionIds: ['option-a', 'option-b'],
    },
    baseline: { optionId: 'option-a', confidence: 0.8 },
    protege: { optionId: wasOverride ? 'option-a' : 'option-b', confidence: 0.75 },
    humanChoice: {
      optionId: 'option-b',
      wasOverride,
      userId: 'user-1',
    },
    domain,
    decidedAt: new Date(),
  });

  const testPeriod: MetricsPeriod = {
    start: new Date('2024-01-01'),
    end: new Date('2024-01-31'),
    type: 'month',
  };

  describe('Intervention Rate Calculation', () => {
    it('should calculate intervention rate correctly', () => {
      // 3 overrides out of 10 decisions = 30%
      const decisions: ThreeLayerDecision[] = [
        ...Array(3)
          .fill(null)
          .map(() => createDecision('general', true)), // overrides
        ...Array(7)
          .fill(null)
          .map(() => createDecision('general', false)), // no overrides
      ];
      const attributions = decisions.map(() =>
        createAttribution('all_aligned', 'system')
      );

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.interventionRate).toBeCloseTo(0.3, 2);
    });

    it('should return 0 intervention rate when no overrides', () => {
      const decisions = Array(5)
        .fill(null)
        .map(() => createDecision('general', false));
      const attributions = decisions.map(() => createAttribution('all_aligned', 'system'));

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.interventionRate).toBe(0);
    });

    it('should return 1 intervention rate when all overrides', () => {
      const decisions = Array(5)
        .fill(null)
        .map(() => createDecision('general', true));
      const attributions = decisions.map(() => createAttribution('human_unique', 'human_judgment'));

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.interventionRate).toBe(1);
    });
  });

  describe('Additive Value Calculation', () => {
    it('should calculate additive value from protégé and human unique', () => {
      // 2 protégé wisdom + 3 human unique out of 10 = 50% additive value
      const attributions: Attribution[] = [
        ...Array(2)
          .fill(null)
          .map(() => createAttribution('protege_wisdom', 'protege_wisdom')),
        ...Array(3)
          .fill(null)
          .map(() => createAttribution('human_unique', 'human_judgment')),
        ...Array(5)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.additiveValue).toBeCloseTo(0.5, 2);
    });

    it('should include collaboration in additive value', () => {
      // 2 collaboration + 2 human unique out of 10 = 40%
      const attributions: Attribution[] = [
        ...Array(2)
          .fill(null)
          .map(() => createAttribution('collaboration', 'collaboration')),
        ...Array(2)
          .fill(null)
          .map(() => createAttribution('human_unique', 'human_judgment')),
        ...Array(6)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      // Collaboration adds value beyond baseline, so should be included
      expect(metrics.additiveValue).toBeGreaterThan(0);
    });
  });

  describe('Protégé Standalone Value', () => {
    it('should calculate protégé standalone value', () => {
      // 4 protégé correct (wisdom or aligned) out of 10 = 40%
      const attributions: Attribution[] = [
        ...Array(2)
          .fill(null)
          .map(() => createAttribution('protege_wisdom', 'protege_wisdom')),
        ...Array(2)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
        ...Array(6)
          .fill(null)
          .map(() =>
            createAttribution('human_unique', 'human_judgment', { protegeCorrect: false })
          ),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.protegeStandalone).toBeCloseTo(0.4, 2);
    });
  });

  describe('Unique Human Contribution', () => {
    it('should calculate unique human contribution', () => {
      // 3 human unique out of 10 = 30%
      const attributions: Attribution[] = [
        ...Array(3)
          .fill(null)
          .map(() => createAttribution('human_unique', 'human_judgment')),
        ...Array(7)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.uniqueHuman).toBeCloseTo(0.3, 2);
    });

    it('should not count human_wrong as unique contribution', () => {
      const attributions: Attribution[] = [
        ...Array(3)
          .fill(null)
          .map(() => createAttribution('human_wrong', 'system')),
        ...Array(7)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.uniqueHuman).toBe(0);
    });
  });

  describe('Domain Breakdown', () => {
    it('should break down metrics by domain', () => {
      const decisions: ThreeLayerDecision[] = [
        ...Array(5)
          .fill(null)
          .map(() => createDecision('engineering', true)),
        ...Array(3)
          .fill(null)
          .map(() => createDecision('marketing', false)),
        ...Array(2)
          .fill(null)
          .map(() => createDecision('sales', true)),
      ];
      const attributions = decisions.map(() => createAttribution('all_aligned', 'system'));

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.domainBreakdown.length).toBe(3);

      const engineering = metrics.domainBreakdown.find((d) => d.domain === 'engineering');
      const marketing = metrics.domainBreakdown.find((d) => d.domain === 'marketing');
      const sales = metrics.domainBreakdown.find((d) => d.domain === 'sales');

      expect(engineering?.totalDecisions).toBe(5);
      expect(marketing?.totalDecisions).toBe(3);
      expect(sales?.totalDecisions).toBe(2);
    });

    it('should calculate domain-specific intervention rates', () => {
      const decisions: ThreeLayerDecision[] = [
        ...Array(4)
          .fill(null)
          .map(() => createDecision('engineering', true)), // 80% override
        createDecision('engineering', false),
        ...Array(1)
          .fill(null)
          .map(() => createDecision('marketing', true)), // 50% override
        createDecision('marketing', false),
      ];
      const attributions = decisions.map(() => createAttribution('all_aligned', 'system'));

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      const engineering = metrics.domainBreakdown.find((d) => d.domain === 'engineering');
      const marketing = metrics.domainBreakdown.find((d) => d.domain === 'marketing');

      expect(engineering?.interventionRate).toBeCloseTo(0.8, 2);
      expect(marketing?.interventionRate).toBeCloseTo(0.5, 2);
    });
  });

  describe('Trend Detection', () => {
    it('should detect increasing trend', () => {
      // Mock implementation would need historical data
      // For now, test that trends are present in output
      const decisions = Array(10)
        .fill(null)
        .map(() => createDecision());
      const attributions = decisions.map(() => createAttribution('all_aligned', 'system'));

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.trends).toBeDefined();
      expect(metrics.trends.interventionRateTrend).toBeDefined();
      expect(metrics.trends.additiveValueTrend).toBeDefined();
      expect(metrics.trends.volumeTrend).toBeDefined();
    });

    it('should return insufficient_data for small datasets', () => {
      const decisions = [createDecision()];
      const attributions = [createAttribution('all_aligned', 'system')];

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      // With only 1 decision, trend detection isn't meaningful
      expect(metrics.trends.volumeTrend).toBe('insufficient_data');
    });
  });

  describe('Valid Outcomes Counting', () => {
    it('should count valid outcomes separately from total decisions', () => {
      const attributions: Attribution[] = [
        ...Array(7)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
        ...Array(3)
          .fill(null)
          .map(() => createAttribution('unknown', 'none')),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.totalDecisions).toBe(10);
      expect(metrics.validOutcomes).toBe(7);
    });

    it('should exclude unknown outcomes from metric calculations', () => {
      // 3 human unique out of 7 valid = ~43%
      const attributions: Attribution[] = [
        ...Array(3)
          .fill(null)
          .map(() => createAttribution('human_unique', 'human_judgment')),
        ...Array(4)
          .fill(null)
          .map(() => createAttribution('all_aligned', 'system')),
        ...Array(3)
          .fill(null)
          .map(() => createAttribution('unknown', 'none')),
      ];
      const decisions = attributions.map(() => createDecision());

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      // uniqueHuman should be calculated from valid outcomes only
      expect(metrics.uniqueHuman).toBeCloseTo(3 / 7, 2);
    });
  });

  describe('Calculation Timestamp', () => {
    it('should record calculation timestamp', () => {
      const decisions = [createDecision()];
      const attributions = [createAttribution('all_aligned', 'system')];

      const before = new Date();
      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);
      const after = new Date();

      expect(metrics.calculatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(metrics.calculatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should include user ID and period in metrics', () => {
      const decisions = [createDecision()];
      const attributions = [createAttribution('all_aligned', 'system')];

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.userId).toBe('user-1');
      expect(metrics.period).toEqual(testPeriod);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty decision array', () => {
      const metrics = aggregator.calculate('user-1', [], [], testPeriod);

      expect(metrics.totalDecisions).toBe(0);
      expect(metrics.validOutcomes).toBe(0);
      expect(metrics.interventionRate).toBe(0);
      expect(metrics.additiveValue).toBe(0);
    });

    it('should handle all unknown attributions', () => {
      const decisions = Array(5)
        .fill(null)
        .map(() => createDecision());
      const attributions = decisions.map(() => createAttribution('unknown', 'none'));

      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.totalDecisions).toBe(5);
      expect(metrics.validOutcomes).toBe(0);
      expect(metrics.interventionRate).toBe(0);
    });
  });
});
