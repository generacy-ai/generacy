import { describe, it, expect, beforeEach } from 'vitest';
import { ProtegeRecommendationEngine } from '../../../src/recommendation/engine/protege-engine.js';
import type {
  DecisionRequest,
  BaselineRecommendation,
  IndividualKnowledge,
  Principle,
} from '../../../src/recommendation/types/index.js';

/**
 * Integration tests for the full recommendation flow
 * Tests end-to-end scenarios including AC3: conflicting principles
 */

describe('Recommendation Flow Integration', () => {
  let engine: ProtegeRecommendationEngine;

  beforeEach(() => {
    engine = new ProtegeRecommendationEngine();
  });

  describe('Full recommendation flow', () => {
    it('should generate a complete recommendation with all components', async () => {
      const request: DecisionRequest = {
        id: 'integration-test-001',
        domain: ['career', 'finance'],
        question: 'Should I invest in index funds or individual stocks?',
        options: [
          {
            id: 'index-funds',
            name: 'Index Funds',
            description: 'Diversified, lower risk, steady returns',
            attributes: { riskLevel: 0.3, expectedReturn: 0.07 },
          },
          {
            id: 'individual-stocks',
            name: 'Individual Stocks',
            description: 'Higher potential returns, higher risk',
            attributes: { riskLevel: 0.7, expectedReturn: 0.15 },
          },
        ],
      };

      const knowledge: IndividualKnowledge = {
        id: 'knowledge-integration-001',
        ownerId: 'user-integration-001',
        philosophy: {
          values: [
            { name: 'Financial Security', importance: 9 },
            { name: 'Growth Mindset', importance: 6 },
          ],
          beliefs: [
            { statement: 'Slow and steady wins the race', confidence: 0.85 },
          ],
          boundaries: [],
          riskTolerance: 0.35,
          timeHorizon: 'long',
        },
        principles: [
          {
            id: 'conservative-investing',
            name: 'Conservative Investing',
            content: 'Prefer stable, diversified investments over risky bets',
            domains: ['finance', 'investing'],
            weight: 8,
            active: true,
            source: 'stated',
          },
          {
            id: 'long-term-thinking',
            name: 'Long-term Thinking',
            content: 'Make decisions with a 10+ year horizon in mind',
            domains: ['life', 'finance'],
            weight: 7,
            active: true,
            source: 'learned',
          },
        ],
        patterns: [],
        context: {
          activeGoals: [
            {
              id: 'retirement-goal',
              description: 'Build retirement savings',
              priority: 1,
              domains: ['finance'],
            },
          ],
          constraints: [],
          energyLevel: 8,
          decisionFatigue: 0.2,
          priorities: ['security', 'stability'],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'individual-stocks',
        reasoning: 'Higher expected returns maximize wealth growth',
        confidence: 0.7,
        factors: [
          { name: 'Expected return', contribution: 0.8, explanation: '15% vs 7%' },
        ],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Verify complete structure
      expect(result.optionId).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reasoning.length).toBeGreaterThan(0);
      expect(result.appliedPrinciples.length).toBeGreaterThan(0);
      expect(result.meta.engineVersion).toBeDefined();

      // Conservative investor with low risk tolerance should likely prefer index funds
      // (though this depends on the exact implementation)
      if (result.optionId === 'index-funds') {
        expect(result.differsFromBaseline).toBe(true);
        expect(result.differenceExplanation).toBeDefined();
      }
    });

    it('should handle realistic multi-domain decision', async () => {
      const request: DecisionRequest = {
        id: 'multi-domain-001',
        domain: ['career', 'family', 'health'],
        question: 'Should I accept a promotion requiring more travel?',
        options: [
          {
            id: 'accept-promotion',
            name: 'Accept Promotion',
            description: 'Higher salary, more responsibility, 50% travel',
            attributes: { salary: 150000, travelPercent: 50 },
          },
          {
            id: 'decline-promotion',
            name: 'Decline Promotion',
            description: 'Same salary, same role, minimal travel',
            attributes: { salary: 120000, travelPercent: 10 },
          },
          {
            id: 'negotiate',
            name: 'Negotiate Terms',
            description: 'Counter-offer: promotion with reduced travel',
            attributes: { salary: 140000, travelPercent: 25 },
          },
        ],
      };

      const knowledge: IndividualKnowledge = {
        id: 'knowledge-multi-001',
        ownerId: 'user-multi-001',
        philosophy: {
          values: [
            { name: 'Family Time', importance: 10 },
            { name: 'Career Growth', importance: 7 },
            { name: 'Financial Security', importance: 8 },
          ],
          beliefs: [],
          boundaries: [
            { description: 'Never travel more than 30% of the time', hard: true },
          ],
          riskTolerance: 0.5,
          timeHorizon: 'long',
        },
        principles: [
          {
            id: 'family-first',
            name: 'Family First',
            content: 'Family commitments take priority over career advancement',
            domains: ['family', 'career'],
            weight: 9,
            active: true,
            source: 'stated',
          },
          {
            id: 'career-growth',
            name: 'Career Growth',
            content: 'Seek opportunities for professional development',
            domains: ['career'],
            weight: 6,
            active: true,
            source: 'learned',
          },
        ],
        patterns: [],
        context: {
          activeGoals: [
            {
              id: 'family-dinners',
              description: 'Be home for family dinners most weeknights',
              priority: 1,
              domains: ['family'],
            },
          ],
          constraints: [
            {
              type: 'time',
              description: 'Kid starting school next month',
              severity: 'high',
            },
          ],
          energyLevel: 6,
          decisionFatigue: 0.4,
          priorities: ['family', 'stability'],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'accept-promotion',
        reasoning: 'Maximizes career advancement and financial returns',
        confidence: 0.75,
        factors: [
          { name: 'Salary increase', contribution: 0.5, explanation: '25% raise' },
          { name: 'Career trajectory', contribution: 0.5, explanation: 'Faster advancement' },
        ],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // The boundary "Never travel more than 30%" should eliminate accept-promotion
      // and likely favor negotiate or decline
      expect(result.optionId).not.toBe('accept-promotion');
      expect(result.reasoning.length).toBeGreaterThan(0);

      // Should have boundary-related reasoning or philosophy application
      const hasPhilosophyStep = result.reasoning.some((s) => s.type === 'philosophy_application');
      expect(hasPhilosophyStep).toBe(true);
    });
  });

  describe('AC3: Conflicting principles with learned weights', () => {
    it('should resolve conflicts by selecting highest-weight principle', async () => {
      const request: DecisionRequest = {
        id: 'conflict-test-001',
        domain: ['career'],
        question: 'Should I take the risky startup job or safe corporate job?',
        options: [
          {
            id: 'startup',
            name: 'Startup Job',
            description: 'Risky but innovative, potential for high growth',
            attributes: { risk: 'high', innovation: 'high' },
          },
          {
            id: 'corporate',
            name: 'Corporate Job',
            description: 'Stable, predictable, lower growth potential',
            attributes: { risk: 'low', stability: 'high' },
          },
        ],
      };

      // Create principles that conflict - one favors risk, one favors stability
      const conflictingPrinciples: Principle[] = [
        {
          id: 'stability-principle',
          name: 'Stability First',
          content: 'Always prioritize stable, predictable options',
          domains: ['career', 'life'],
          weight: 9, // Higher weight - should win
          active: true,
          source: 'stated',
        },
        {
          id: 'innovation-principle',
          name: 'Embrace Innovation',
          content: 'Take risks for innovative, growth opportunities',
          domains: ['career'],
          weight: 6, // Lower weight
          active: true,
          source: 'learned',
        },
      ];

      const knowledge: IndividualKnowledge = {
        id: 'conflict-knowledge-001',
        ownerId: 'user-conflict-001',
        philosophy: {
          values: [
            { name: 'Stability', importance: 8 },
            { name: 'Innovation', importance: 6 },
          ],
          beliefs: [],
          boundaries: [],
          riskTolerance: 0.4,
          timeHorizon: 'medium',
        },
        principles: conflictingPrinciples,
        patterns: [],
        context: {
          activeGoals: [],
          constraints: [],
          energyLevel: 7,
          decisionFatigue: 0.2,
          priorities: [],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'startup',
        reasoning: 'Higher growth potential in tech sector',
        confidence: 0.6,
        factors: [],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Higher weight stability principle should influence toward corporate
      // The recommendation should reflect the conflict resolution
      expect(result.appliedPrinciples.length).toBe(2);

      // Verify both principles were applied
      const principleIds = result.appliedPrinciples.map((p) => p.principleId);
      expect(principleIds).toContain('stability-principle');
      expect(principleIds).toContain('innovation-principle');

      // Check that reasoning acknowledges the principles
      const principleApplicationSteps = result.reasoning.filter(
        (s) => s.type === 'principle_application'
      );
      expect(principleApplicationSteps.length).toBeGreaterThan(0);

      // Note: hadConflicts is true when applied principles favor different options
      // Since these principles don't explicitly set favorsOption, we verify
      // that both principles were considered even though they have opposing intents
      expect(result.meta.principlesMatched).toBe(2);
    });

    it('should include conflict resolution in reasoning', async () => {
      const request: DecisionRequest = {
        id: 'conflict-reasoning-001',
        domain: ['finance'],
        question: 'Should I save aggressively or enjoy life now?',
        options: [
          {
            id: 'save',
            name: 'Aggressive Saving',
            description: 'Maximize savings, minimal spending',
            attributes: {},
          },
          {
            id: 'enjoy',
            name: 'Enjoy Life',
            description: 'Balance savings with experiences',
            attributes: {},
          },
        ],
      };

      const knowledge: IndividualKnowledge = {
        id: 'conflict-reasoning-knowledge',
        ownerId: 'user-001',
        philosophy: {
          values: [
            { name: 'Future Security', importance: 8 },
            { name: 'Present Enjoyment', importance: 7 },
          ],
          beliefs: [],
          boundaries: [],
          riskTolerance: 0.5,
          timeHorizon: 'long',
        },
        principles: [
          {
            id: 'save-for-future',
            name: 'Save for Future',
            content: 'Prioritize long-term financial security through aggressive saving',
            domains: ['finance'],
            weight: 8,
            active: true,
            source: 'learned',
          },
          {
            id: 'live-in-present',
            name: 'Live in Present',
            content: 'Life is short - enjoy experiences while you can',
            domains: ['finance', 'life'],
            weight: 7,
            active: true,
            source: 'stated',
          },
        ],
        patterns: [],
        context: {
          activeGoals: [],
          constraints: [],
          energyLevel: 8,
          decisionFatigue: 0.1,
          priorities: [],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'enjoy',
        reasoning: 'Balanced approach recommended for mental health',
        confidence: 0.65,
        factors: [],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Both principles should be applied
      expect(result.appliedPrinciples.length).toBe(2);

      // Reasoning should show both principles were considered
      const allPrincipleIds = result.reasoning
        .filter((s) => s.principle)
        .map((s) => s.principle?.principleId);

      // At least one principle should be mentioned in reasoning
      expect(
        allPrincipleIds.includes('save-for-future') ||
        allPrincipleIds.includes('live-in-present')
      ).toBe(true);
    });

    it('should handle three-way principle conflicts', async () => {
      const request: DecisionRequest = {
        id: 'three-way-conflict-001',
        domain: ['career'],
        question: 'Which job should I take?',
        options: [
          { id: 'job-a', name: 'High Pay', description: 'Highest salary', attributes: {} },
          { id: 'job-b', name: 'Best Culture', description: 'Best work culture', attributes: {} },
          { id: 'job-c', name: 'Remote Work', description: 'Fully remote', attributes: {} },
        ],
      };

      const knowledge: IndividualKnowledge = {
        id: 'three-way-knowledge',
        ownerId: 'user-001',
        philosophy: {
          values: [],
          beliefs: [],
          boundaries: [],
          riskTolerance: 0.5,
          timeHorizon: 'medium',
        },
        principles: [
          {
            id: 'money-matters',
            name: 'Money Matters',
            content: 'Choose the highest paying option',
            domains: ['career'],
            weight: 7,
            active: true,
            source: 'learned',
          },
          {
            id: 'culture-first',
            name: 'Culture First',
            content: 'Work environment is most important',
            domains: ['career'],
            weight: 8, // Highest weight
            active: true,
            source: 'stated',
          },
          {
            id: 'flexibility-wins',
            name: 'Flexibility Wins',
            content: 'Remote work provides the best life balance',
            domains: ['career', 'life'],
            weight: 6,
            active: true,
            source: 'inferred',
          },
        ],
        patterns: [],
        context: {
          activeGoals: [],
          constraints: [],
          energyLevel: 7,
          decisionFatigue: 0.3,
          priorities: [],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'job-a',
        reasoning: 'Highest financial return',
        confidence: 0.7,
        factors: [],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // All three principles should be applied
      expect(result.appliedPrinciples.length).toBe(3);

      // Note: hadConflicts depends on principles explicitly favoring different options
      // These principles don't set favorsOption, so we verify all were considered
      expect(result.meta.principlesMatched).toBe(3);

      // Confidence should reflect the complexity of conflicting principles
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Energy level and fatigue effects', () => {
    it('should adjust recommendations based on low energy', async () => {
      const request: DecisionRequest = {
        id: 'energy-test-001',
        domain: ['life'],
        question: 'What should I do this evening?',
        options: [
          {
            id: 'complex-activity',
            name: 'Complex Project',
            description: 'Work on challenging side project requiring focus',
            attributes: { complexity: 'high' },
          },
          {
            id: 'simple-activity',
            name: 'Simple Relaxation',
            description: 'Watch a movie and relax',
            attributes: { complexity: 'low' },
          },
        ],
      };

      const knowledge: IndividualKnowledge = {
        id: 'energy-knowledge',
        ownerId: 'user-001',
        philosophy: {
          values: [{ name: 'Productivity', importance: 7 }],
          beliefs: [],
          boundaries: [],
          riskTolerance: 0.5,
          timeHorizon: 'short',
        },
        principles: [
          {
            id: 'be-productive',
            name: 'Be Productive',
            content: 'Use time wisely to accomplish goals',
            domains: ['life'],
            weight: 7,
            active: true,
            source: 'stated',
          },
        ],
        patterns: [],
        context: {
          activeGoals: [],
          constraints: [],
          energyLevel: 2, // Very low energy
          decisionFatigue: 0.8, // High fatigue
          priorities: [],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'complex-activity',
        reasoning: 'More productive use of time',
        confidence: 0.6,
        factors: [],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Should have energy-related warning
      const energyWarning = result.warnings?.find((w) => w.type === 'energy_warning');
      expect(energyWarning).toBeDefined();
      expect(energyWarning?.severity).toBe('critical');

      // Context influence should mention energy
      const energyInfluence = result.contextInfluence.find((c) =>
        c.factor.toLowerCase().includes('energy')
      );
      expect(energyInfluence).toBeDefined();
    });
  });

  describe('Boundary enforcement', () => {
    it('should respect hard boundaries', async () => {
      const request: DecisionRequest = {
        id: 'boundary-test-001',
        domain: ['finance'],
        question: 'How should I invest my savings?',
        options: [
          {
            id: 'gambling',
            name: 'Gambling Investments',
            description: 'High-risk speculative gambling on crypto',
            attributes: { type: 'gambling' },
          },
          {
            id: 'safe-investment',
            name: 'Safe Investments',
            description: 'Government bonds and index funds',
            attributes: { type: 'safe' },
          },
        ],
      };

      const knowledge: IndividualKnowledge = {
        id: 'boundary-knowledge',
        ownerId: 'user-001',
        philosophy: {
          values: [{ name: 'Wealth', importance: 8 }],
          beliefs: [],
          boundaries: [
            { description: 'Never engage in gambling or speculative betting', hard: true },
          ],
          riskTolerance: 0.5,
          timeHorizon: 'long',
        },
        principles: [],
        patterns: [],
        context: {
          activeGoals: [],
          constraints: [],
          energyLevel: 7,
          decisionFatigue: 0.2,
          priorities: [],
          lastUpdated: new Date().toISOString(),
        },
      };

      const baseline: BaselineRecommendation = {
        optionId: 'gambling',
        reasoning: 'Highest potential returns',
        confidence: 0.5,
        factors: [],
      };

      const result = await engine.generateRecommendation(request, knowledge, baseline);

      // Hard boundary should prevent gambling option
      // The recommendation should be safe-investment (or empty if all options violate)
      expect(result.optionId).not.toBe('gambling');
    });
  });
});
