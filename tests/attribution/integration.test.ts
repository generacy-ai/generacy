/**
 * Attribution Integration Tests
 *
 * Full flow tests: decision → outcome → attribution → metrics → report
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAttributionCalculator,
  createMetricsAggregator,
  createReportGenerator,
  type ThreeLayerDecision,
  type DecisionOutcome,
  type Attribution,
  type MetricsPeriod,
} from '../../src/attribution/index.js';

describe('Attribution Integration', () => {
  const calculator = createAttributionCalculator();
  const aggregator = createMetricsAggregator();
  const reportGenerator = createReportGenerator();

  const testPeriod: MetricsPeriod = {
    start: new Date('2024-01-01'),
    end: new Date('2024-01-31'),
    type: 'month',
  };

  // Helper to create test decisions with varied outcomes
  const createTestDecision = (
    id: string,
    domain: string,
    baselineOption: string,
    protegeOption: string,
    humanOption: string,
    wasOverride: boolean = false
  ): ThreeLayerDecision => ({
    id,
    request: {
      id: `request-${id}`,
      description: `Test decision ${id}`,
      optionIds: ['option-a', 'option-b', 'option-c'],
    },
    baseline: { optionId: baselineOption, confidence: 0.8 },
    protege: { optionId: protegeOption, confidence: 0.75 },
    humanChoice: {
      optionId: humanOption,
      wasOverride,
      userId: 'user-1',
    },
    domain,
    decidedAt: new Date(),
  });

  describe('Full Flow: Decision → Attribution → Metrics → Report', () => {
    it('should process a complete attribution flow', () => {
      // Create a set of diverse decisions
      const decisions: ThreeLayerDecision[] = [
        // All aligned - success
        createTestDecision('1', 'engineering', 'option-a', 'option-a', 'option-a'),
        // Human unique value - success
        createTestDecision('2', 'engineering', 'option-a', 'option-a', 'option-b', true),
        // Protégé wisdom - success
        createTestDecision('3', 'marketing', 'option-a', 'option-b', 'option-b'),
        // All aligned - success
        createTestDecision('4', 'marketing', 'option-a', 'option-a', 'option-a'),
        // Collaboration - success
        createTestDecision('5', 'sales', 'option-a', 'option-b', 'option-c', true),
      ];

      const outcomes: DecisionOutcome[] = [
        { decisionId: '1', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: ['Worked'] },
        { decisionId: '2', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: ['Human was right'] },
        { decisionId: '3', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: ['Protégé was right'] },
        { decisionId: '4', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: ['Worked'] },
        { decisionId: '5', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: ['Collaboration worked'] },
      ];

      // Step 1: Calculate attributions for each decision
      const attributions: Attribution[] = [];
      for (let i = 0; i < decisions.length; i++) {
        const attribution = calculator.calculateAttribution(decisions[i], outcomes[i]);
        attributions.push(attribution);
      }

      expect(attributions.length).toBe(5);
      expect(attributions[0].whoWasRight).toBe('all_aligned');
      expect(attributions[1].whoWasRight).toBe('human_unique');
      expect(attributions[2].whoWasRight).toBe('protege_wisdom');
      expect(attributions[4].whoWasRight).toBe('collaboration');

      // Step 2: Aggregate into metrics
      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.userId).toBe('user-1');
      expect(metrics.totalDecisions).toBe(5);
      expect(metrics.validOutcomes).toBe(5);
      expect(metrics.interventionRate).toBeCloseTo(0.4, 2); // 2 overrides out of 5

      // Step 3: Generate report
      const report = reportGenerator.generateReport(metrics, 'json');

      expect(report.format).toBe('json');
      expect(report.userId).toBe('user-1');
      expect(report.summary.totalDecisions).toBe(5);
      expect(report.domainBreakdown).toBeDefined();
      expect(report.domainBreakdown!.length).toBe(3); // engineering, marketing, sales
    });

    it('should handle mixed outcomes (success, failure, partial)', () => {
      const decisions: ThreeLayerDecision[] = [
        createTestDecision('1', 'engineering', 'option-a', 'option-a', 'option-a'),
        createTestDecision('2', 'engineering', 'option-a', 'option-a', 'option-b', true),
        createTestDecision('3', 'engineering', 'option-a', 'option-b', 'option-b'),
      ];

      const outcomes: DecisionOutcome[] = [
        { decisionId: '1', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: ['Worked'] },
        { decisionId: '2', result: { status: 'failure', details: 'Failed', severity: 'major' }, recordedAt: new Date(), evidence: ['Did not work'] },
        { decisionId: '3', result: { status: 'partial', successRate: 0.7, details: 'Partial' }, recordedAt: new Date(), evidence: ['Mostly worked'] },
      ];

      const attributions = decisions.map((d, i) => calculator.calculateAttribution(d, outcomes[i]));

      // Success: all_aligned correct
      expect(attributions[0].whoWasRight).toBe('all_aligned');
      expect(attributions[0].humanCorrect).toBe(true);

      // Failure: human wrong (baseline/protégé would have been right)
      expect(attributions[1].whoWasRight).toBe('human_wrong');
      expect(attributions[1].humanCorrect).toBe(false);

      // Partial success: treated as success (70% > 50%)
      expect(attributions[2].humanCorrect).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle delayed outcomes', () => {
      const decision = createTestDecision('delayed-1', 'engineering', 'option-a', 'option-a', 'option-a');

      // Initially unknown
      const unknownOutcome: DecisionOutcome = {
        decisionId: 'delayed-1',
        result: { status: 'unknown', reason: 'Outcome not yet determined' },
        recordedAt: new Date(),
        evidence: [],
      };

      const unknownAttribution = calculator.calculateAttribution(decision, unknownOutcome);
      expect(unknownAttribution.whoWasRight).toBe('unknown');
      expect(unknownAttribution.confidence).toBe(0);

      // Later, outcome is known
      const knownOutcome: DecisionOutcome = {
        decisionId: 'delayed-1',
        result: { status: 'success', details: 'Finally determined' },
        recordedAt: new Date(),
        evidence: ['Outcome confirmed'],
      };

      const knownAttribution = calculator.calculateAttribution(decision, knownOutcome);
      expect(knownAttribution.whoWasRight).toBe('all_aligned');
      expect(knownAttribution.confidence).toBeGreaterThan(0);
    });

    it('should handle unknown outcomes in metrics', () => {
      const decisions: ThreeLayerDecision[] = [
        createTestDecision('1', 'engineering', 'option-a', 'option-a', 'option-a'),
        createTestDecision('2', 'engineering', 'option-a', 'option-a', 'option-a'),
        createTestDecision('3', 'engineering', 'option-a', 'option-a', 'option-a'),
      ];

      const outcomes: DecisionOutcome[] = [
        { decisionId: '1', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: [] },
        { decisionId: '2', result: { status: 'unknown', reason: 'Pending' }, recordedAt: new Date(), evidence: [] },
        { decisionId: '3', result: { status: 'success', details: 'Success' }, recordedAt: new Date(), evidence: [] },
      ];

      const attributions = decisions.map((d, i) => calculator.calculateAttribution(d, outcomes[i]));
      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.totalDecisions).toBe(3);
      expect(metrics.validOutcomes).toBe(2); // Only 2 known outcomes
    });

    it('should handle multiple domains correctly', () => {
      const decisions: ThreeLayerDecision[] = [
        createTestDecision('1', 'engineering', 'option-a', 'option-a', 'option-b', true),
        createTestDecision('2', 'engineering', 'option-a', 'option-a', 'option-b', true),
        createTestDecision('3', 'marketing', 'option-a', 'option-a', 'option-a'),
        createTestDecision('4', 'marketing', 'option-a', 'option-a', 'option-a'),
        createTestDecision('5', 'sales', 'option-a', 'option-b', 'option-b'),
      ];

      const outcomes: DecisionOutcome[] = decisions.map((d) => ({
        decisionId: d.id,
        result: { status: 'success' as const, details: 'Success' },
        recordedAt: new Date(),
        evidence: [],
      }));

      const attributions = decisions.map((d, i) => calculator.calculateAttribution(d, outcomes[i]));
      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);

      expect(metrics.domainBreakdown.length).toBe(3);

      const engineering = metrics.domainBreakdown.find((d) => d.domain === 'engineering');
      const marketing = metrics.domainBreakdown.find((d) => d.domain === 'marketing');
      const sales = metrics.domainBreakdown.find((d) => d.domain === 'sales');

      expect(engineering?.totalDecisions).toBe(2);
      expect(engineering?.interventionRate).toBe(1); // All overrides in engineering
      expect(marketing?.totalDecisions).toBe(2);
      expect(marketing?.interventionRate).toBe(0); // No overrides in marketing
      expect(sales?.totalDecisions).toBe(1);
    });
  });

  describe('Report Generation', () => {
    it('should generate complete JSON report', () => {
      const decisions: ThreeLayerDecision[] = [
        createTestDecision('1', 'engineering', 'option-a', 'option-a', 'option-b', true),
        createTestDecision('2', 'engineering', 'option-a', 'option-a', 'option-a'),
        createTestDecision('3', 'marketing', 'option-a', 'option-b', 'option-b'),
        createTestDecision('4', 'marketing', 'option-a', 'option-a', 'option-a'),
      ];

      const outcomes: DecisionOutcome[] = decisions.map((d) => ({
        decisionId: d.id,
        result: { status: 'success' as const, details: 'Success' },
        recordedAt: new Date(),
        evidence: [],
      }));

      const attributions = decisions.map((d, i) => calculator.calculateAttribution(d, outcomes[i]));
      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);
      const report = reportGenerator.generateReport(metrics, 'json');

      // Verify report structure
      expect(report.format).toBe('json');
      expect(report.summary).toBeDefined();
      expect(report.summary.totalDecisions).toBe(4);
      expect(report.summary.interventionRate).toBeCloseTo(0.25, 2);
      expect(report.domainBreakdown).toBeDefined();
      expect(report.strengths).toBeDefined();
      expect(report.weaknesses).toBeDefined();
      expect(report.generatedAt).toBeDefined();
    });

    it('should generate summary report', () => {
      const decisions = [createTestDecision('1', 'engineering', 'option-a', 'option-a', 'option-a')];
      const outcomes = [{ decisionId: '1', result: { status: 'success' as const, details: 'Success' }, recordedAt: new Date(), evidence: [] }];

      const attributions = decisions.map((d, i) => calculator.calculateAttribution(d, outcomes[i]));
      const metrics = aggregator.calculate('user-1', decisions, attributions, testPeriod);
      const report = reportGenerator.generateReport(metrics, 'summary');

      expect(report.format).toBe('summary');
      expect(report.summary).toBeDefined();
    });
  });

  describe('Factory Functions', () => {
    it('should create working calculator via factory', () => {
      const calc = createAttributionCalculator();
      const decision = createTestDecision('1', 'test', 'option-a', 'option-a', 'option-a');
      const outcome: DecisionOutcome = {
        decisionId: '1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: [],
      };

      const attribution = calc.calculateAttribution(decision, outcome);
      expect(attribution).toBeDefined();
      expect(attribution.whoWasRight).toBe('all_aligned');
    });

    it('should create working aggregator via factory', () => {
      const agg = createMetricsAggregator();
      const metrics = agg.calculate('user-1', [], [], testPeriod);
      expect(metrics).toBeDefined();
      expect(metrics.totalDecisions).toBe(0);
    });

    it('should create working report generator via factory', () => {
      const gen = createReportGenerator();
      const agg = createMetricsAggregator();
      const metrics = agg.calculate('user-1', [], [], testPeriod);
      const report = gen.generateReport(metrics, 'json');
      expect(report).toBeDefined();
      expect(report.format).toBe('json');
    });
  });
});
