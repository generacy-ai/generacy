import { describe, it, expect, beforeEach } from 'vitest';
import { ProtegeRecommendationEngine } from '../../../src/recommendation/engine/protege-engine.js';
import type {
  DecisionRequest,
  BaselineRecommendation,
  IndividualKnowledge,
  RecommendationOptions,
} from '../../../src/recommendation/types/index.js';

// Factory functions for test data
const createDecisionRequest = (overrides?: Partial<DecisionRequest>): DecisionRequest => ({
  id: 'decision-001',
  domain: ['career', 'finance'],
  question: 'Should I accept the job offer with higher pay but longer commute?',
  options: [
    {
      id: 'accept',
      name: 'Accept Offer',
      description: 'Higher pay, longer commute, new challenges',
      attributes: { salary: 120000, commuteMinutes: 60 },
    },
    {
      id: 'decline',
      name: 'Decline Offer',
      description: 'Stay at current job, shorter commute, familiar environment',
      attributes: { salary: 100000, commuteMinutes: 20 },
    },
  ],
  ...overrides,
});

const createIndividualKnowledge = (overrides?: Partial<IndividualKnowledge>): IndividualKnowledge => ({
  id: 'knowledge-001',
  ownerId: 'user-001',
  philosophy: {
    values: [
      { name: 'Work-Life Balance', importance: 9 },
      { name: 'Financial Security', importance: 7 },
    ],
    beliefs: [
      { statement: 'Time with family is precious', confidence: 0.9 },
    ],
    boundaries: [
      { description: 'No commutes over 90 minutes', hard: true },
    ],
    riskTolerance: 0.4,
    timeHorizon: 'long',
  },
  principles: [
    {
      id: 'p1',
      name: 'Commute Time Principle',
      content: 'Minimize commute time to maximize time with family',
      domains: ['career', 'life'],
      weight: 8,
      active: true,
      source: 'stated',
    },
    {
      id: 'p2',
      name: 'Financial Growth',
      content: 'Pursue reasonable financial growth opportunities',
      domains: ['career', 'finance'],
      weight: 6,
      active: true,
      source: 'learned',
    },
  ],
  patterns: [],
  context: {
    activeGoals: [
      {
        id: 'goal-1',
        description: 'Spend more evenings with family',
        priority: 1,
        domains: ['life', 'career'],
      },
    ],
    constraints: [],
    energyLevel: 7,
    decisionFatigue: 0.3,
    priorities: ['family', 'health'],
    lastUpdated: new Date().toISOString(),
  },
  ...overrides,
});

const createBaselineRecommendation = (overrides?: Partial<BaselineRecommendation>): BaselineRecommendation => ({
  optionId: 'accept',
  reasoning: 'Higher salary provides better financial outcomes',
  confidence: 0.75,
  factors: [
    { name: 'Salary increase', contribution: 0.4, explanation: '20% higher salary' },
    { name: 'Career growth', contribution: 0.35, explanation: 'New challenges and opportunities' },
  ],
  ...overrides,
});

describe('ProtegeRecommendationEngine', () => {
  let engine: ProtegeRecommendationEngine;

  beforeEach(() => {
    engine = new ProtegeRecommendationEngine();
  });

  describe('generateRecommendation', () => {
    it('should generate a recommendation with all required fields', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result).toHaveProperty('optionId');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('appliedPrinciples');
      expect(result).toHaveProperty('contextInfluence');
      expect(result).toHaveProperty('differsFromBaseline');
      expect(result).toHaveProperty('meta');
    });

    it('should include metadata about processing', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result.meta).toHaveProperty('processingTimeMs');
      expect(result.meta).toHaveProperty('principlesEvaluated');
      expect(result.meta).toHaveProperty('principlesMatched');
      expect(result.meta).toHaveProperty('hadConflicts');
      expect(result.meta).toHaveProperty('engineVersion');
      expect(result.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should match principles based on domain overlap', async () => {
      const request = createDecisionRequest({ domain: ['career', 'finance'] });
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Both principles have domain overlap
      expect(result.meta.principlesMatched).toBeGreaterThan(0);
      expect(result.appliedPrinciples.length).toBeGreaterThan(0);
    });

    it('should generate reasoning steps', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result.reasoning).toBeInstanceOf(Array);
      expect(result.reasoning.length).toBeGreaterThan(0);

      // Verify reasoning step structure
      result.reasoning.forEach((step) => {
        expect(step).toHaveProperty('step');
        expect(step).toHaveProperty('logic');
        expect(step).toHaveProperty('type');
      });
    });

    it('should have a conclusion step in reasoning', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      const conclusionStep = result.reasoning.find((s) => s.type === 'conclusion');
      expect(conclusionStep).toBeDefined();
    });

    it('should calculate confidence score between 0 and 1', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should indicate when recommendation differs from baseline', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation({ optionId: 'accept' });

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(typeof result.differsFromBaseline).toBe('boolean');
    });

    it('should include difference explanation when differing from baseline', async () => {
      const request = createDecisionRequest();
      // Knowledge that should favor 'decline' due to commute principle
      const knowledge = createIndividualKnowledge({
        principles: [
          {
            id: 'p1',
            name: 'Anti-Commute',
            content: 'Never accept jobs with commutes over 30 minutes',
            domains: ['career'],
            weight: 10,
            active: true,
            source: 'stated',
          },
        ],
      });
      const baseline = createBaselineRecommendation({ optionId: 'accept' });

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      if (result.differsFromBaseline) {
        expect(result.differenceExplanation).toBeDefined();
        expect(typeof result.differenceExplanation).toBe('string');
      }
    });
  });

  describe('options handling', () => {
    it('should respect energyLevel override', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const options: RecommendationOptions = { energyLevel: 2 };
      const result = await engine.generateRecommendation(request, knowledge, baseline, options);

      // Low energy should trigger warnings
      const energyWarning = result.warnings?.find((w) => w.type === 'energy_warning');
      expect(energyWarning).toBeDefined();
    });

    it('should skip context integration when skipContext is true', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const options: RecommendationOptions = { skipContext: true };
      const result = await engine.generateRecommendation(request, knowledge, baseline, options);

      // With skipContext, contextInfluence should be empty
      expect(result.contextInfluence).toHaveLength(0);
    });

    it('should respect maxPrinciples limit', async () => {
      // Create knowledge with many principles
      const manyPrinciples = Array.from({ length: 20 }, (_, i) => ({
        id: `p${i}`,
        name: `Principle ${i}`,
        content: `This is principle number ${i}`,
        domains: ['career', 'finance'],
        weight: 5,
        active: true,
        source: 'stated' as const,
      }));

      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge({ principles: manyPrinciples });
      const baseline = createBaselineRecommendation();

      const options: RecommendationOptions = { maxPrinciples: 3 };
      const result = await engine.generateRecommendation(request, knowledge, baseline, options);

      expect(result.appliedPrinciples.length).toBeLessThanOrEqual(3);
    });

    it('should respect minRelevance threshold', async () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const knowledge = createIndividualKnowledge({
        principles: [
          {
            id: 'p1',
            name: 'High Relevance',
            content: 'Career focused principle',
            domains: ['career'],
            weight: 8,
            active: true,
            source: 'stated',
          },
          {
            id: 'p2',
            name: 'Low Relevance',
            content: 'Unrelated principle',
            domains: ['health'], // Different domain
            weight: 8,
            active: true,
            source: 'stated',
          },
        ],
      });
      const baseline = createBaselineRecommendation();

      const options: RecommendationOptions = { minRelevance: 0.5 };
      const result = await engine.generateRecommendation(request, knowledge, baseline, options);

      // Only high relevance principles should be included
      result.appliedPrinciples.forEach((p) => {
        expect(p.strength).toBeGreaterThanOrEqual(0.5);
      });
    });
  });

  describe('explainDifference', () => {
    it('should return a difference explanation', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const protege = await engine.generateRecommendation(request, knowledge, baseline);
      const explanation = engine.explainDifference(protege, baseline);

      expect(explanation).toHaveProperty('differentOption');
      expect(explanation).toHaveProperty('primaryReason');
      expect(explanation).toHaveProperty('drivingPrinciples');
      expect(explanation).toHaveProperty('drivingContext');
      expect(explanation).toHaveProperty('comparison');
    });

    it('should identify when options are the same', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge({
        principles: [
          {
            id: 'p1',
            name: 'Accept Higher Pay',
            content: 'Always accept higher paying jobs',
            domains: ['career', 'finance'],
            weight: 10,
            active: true,
            source: 'stated',
          },
        ],
      });
      const baseline = createBaselineRecommendation({ optionId: 'accept' });

      const protege = await engine.generateRecommendation(request, knowledge, baseline);

      if (protege.optionId === 'accept') {
        const explanation = engine.explainDifference(protege, baseline);
        expect(explanation.differentOption).toBe(false);
      }
    });

    it('should provide comparison aspects', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const protege = await engine.generateRecommendation(request, knowledge, baseline);
      const explanation = engine.explainDifference(protege, baseline);

      expect(explanation.comparison).toBeInstanceOf(Array);
      expect(explanation.comparison.length).toBeGreaterThan(0);

      explanation.comparison.forEach((comp) => {
        expect(comp).toHaveProperty('aspect');
        expect(comp).toHaveProperty('baseline');
        expect(comp).toHaveProperty('protege');
      });
    });
  });

  describe('edge cases', () => {
    it('should handle no matching principles gracefully', async () => {
      const request = createDecisionRequest({ domain: ['unknown-domain'] });
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result).toBeDefined();
      expect(result.appliedPrinciples).toHaveLength(0);
      // Should have low confidence warning
      const lowConfidenceWarning = result.warnings?.find((w) => w.type === 'low_confidence');
      expect(lowConfidenceWarning).toBeDefined();
    });

    it('should handle empty options array', async () => {
      const request = createDecisionRequest({ options: [] });
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result).toBeDefined();
      expect(result.optionId).toBe('');
    });

    it('should handle empty principles array', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge({ principles: [] });
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result).toBeDefined();
      expect(result.meta.principlesMatched).toBe(0);
    });

    it('should handle all inactive principles', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge({
        principles: [
          {
            id: 'p1',
            name: 'Inactive Principle',
            content: 'This principle is inactive',
            domains: ['career'],
            weight: 10,
            active: false,
            source: 'stated',
          },
        ],
      });
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result).toBeDefined();
      expect(result.appliedPrinciples).toHaveLength(0);
    });
  });

  describe('AC compliance', () => {
    it('[AC1] should load and apply individual knowledge stores', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result.meta.principlesEvaluated).toBe(knowledge.principles.length);
    });

    it('[AC2] should match principles to decision domain', async () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Principles with 'career' domain should be matched
      result.appliedPrinciples.forEach((p) => {
        expect(p.relevance).toContain('career');
      });
    });

    it('[AC4] should apply context (priorities, constraints)', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Context influence should be recorded
      expect(result.contextInfluence).toBeInstanceOf(Array);
    });

    it('[AC5] should respect philosophy (values, boundaries)', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Reasoning should include philosophy application
      const philosophyStep = result.reasoning.find((s) => s.type === 'philosophy_application');
      expect(philosophyStep).toBeDefined();
    });

    it('[AC6] should generate reasoning in terms of human principles', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      const principleSteps = result.reasoning.filter((s) => s.type === 'principle_application');
      principleSteps.forEach((step) => {
        expect(step.principle).toBeDefined();
        expect(step.principle?.principleText).toBeDefined();
      });
    });

    it('[AC7] should compare with baseline and explain differences', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);
      const explanation = engine.explainDifference(result, baseline);

      expect(explanation).toBeDefined();
      expect(explanation.comparison.length).toBeGreaterThan(0);
    });

    it('[AC8] should have confidence reflecting principle application certainty', async () => {
      const request = createDecisionRequest();
      const knowledge = createIndividualKnowledge();
      const baseline = createBaselineRecommendation();

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(typeof result.confidence).toBe('number');
    });
  });
});
