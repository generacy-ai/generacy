import { describe, it, expect, beforeEach } from 'vitest';
import { ContextIntegratorService } from '../../../src/recommendation/engine/context-integrator.js';
import type {
  DecisionRequest,
  UserContext,
  AppliedPrinciple,
} from '../../../src/recommendation/types/index.js';

describe('ContextIntegratorService', () => {
  let service: ContextIntegratorService;

  beforeEach(() => {
    service = new ContextIntegratorService();
  });

  // Mock data factories matching actual types
  const createDecisionRequest = (overrides?: Partial<DecisionRequest>): DecisionRequest => ({
    id: 'decision-1',
    question: 'Should I switch to a more challenging role?',
    domain: ['career', 'development'],
    options: [
      { id: 'accept', name: 'Accept', description: 'Accept the challenge', attributes: {} },
      { id: 'decline', name: 'Decline', description: 'Stay in current role', attributes: {} },
    ],
    ...overrides,
  });

  const createUserContext = (overrides?: Partial<UserContext>): UserContext => ({
    energyLevel: 8,
    decisionFatigue: 0.2,
    activeGoals: [
      { id: 'goal-1', description: 'Improve leadership skills', priority: 1, domains: ['career'] },
      { id: 'goal-2', description: 'Work-life balance', priority: 2, domains: ['personal'] },
    ],
    constraints: [],
    ...overrides,
  });

  const createAppliedPrinciple = (overrides?: Partial<AppliedPrinciple>): AppliedPrinciple => ({
    principleId: 'principle-1',
    principleText: 'Seek challenge appropriate to skill level',
    relevance: 'Aligns with career growth',
    weight: 10,
    strength: 0.8,
    ...overrides,
  });

  describe('integrate method', () => {
    it('should return adjusted principles with influence records', () => {
      const request = createDecisionRequest();
      const context = createUserContext();
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples).toBeDefined();
      expect(result.adjustedPrinciples.length).toBe(1);
      expect(result.influence).toBeDefined();
      expect(Array.isArray(result.influence)).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('should handle empty principles array', () => {
      const request = createDecisionRequest();
      const context = createUserContext();

      const result = service.integrate(request, context, []);

      expect(result.adjustedPrinciples).toEqual([]);
      expect(result.influence).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('should not modify original principles array', () => {
      const request = createDecisionRequest();
      const context = createUserContext();
      const originalPrinciple = createAppliedPrinciple({ strength: 0.8 });
      const principles = [originalPrinciple];

      service.integrate(request, context, principles);

      expect(principles[0].strength).toBe(0.8);
    });
  });

  describe('goal alignment', () => {
    it('should boost principles aligned with active goals', () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const context = createUserContext({
        activeGoals: [
          { id: 'goal-1', description: 'Develop leadership skills', priority: 1, domains: ['career'] },
        ],
      });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Leadership development is key to career growth',
          strength: 0.7,
        }),
      ];

      const result = service.integrate(request, context, principles);

      // Principle aligned with goal should be boosted
      expect(result.adjustedPrinciples[0].strength).toBeGreaterThan(0.7);
      expect(result.influence.some((i) => i.factor.includes('goal'))).toBe(true);
    });

    it('should apply higher boost for high-priority goals (priority 1)', () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const context = createUserContext({
        activeGoals: [
          { id: 'goal-1', description: 'Leadership growth', priority: 1, domains: ['career'] },
        ],
      });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Leadership is essential for career advancement',
          strength: 0.6,
        }),
      ];

      const result = service.integrate(request, context, principles);

      // High priority (1) should give ~15% boost
      expect(result.adjustedPrinciples[0].strength).toBeGreaterThan(0.7);
    });

    it('should handle empty active goals', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ activeGoals: [] });
      const principles = [createAppliedPrinciple({ strength: 0.7 })];

      const result = service.integrate(request, context, principles);

      // No goals means no boost from goal alignment
      expect(result.adjustedPrinciples.length).toBe(1);
    });
  });

  describe('constraint handling', () => {
    it('should add warnings for critical constraints', () => {
      const request = createDecisionRequest();
      const context = createUserContext({
        constraints: [
          { type: 'relocation', description: 'Cannot relocate', severity: 'critical' },
        ],
      });
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.severity === 'critical')).toBe(true);
    });

    it('should record constraint influence', () => {
      const request = createDecisionRequest();
      const context = createUserContext({
        constraints: [
          { type: 'budget', description: 'Limited budget', severity: 'medium' },
        ],
      });
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.influence.some((i) => i.factor.includes('Constraint'))).toBe(true);
    });

    it('should handle multiple constraints', () => {
      const request = createDecisionRequest();
      const context = createUserContext({
        constraints: [
          { type: 'time', description: 'Limited time', severity: 'high' },
          { type: 'budget', description: 'Limited budget', severity: 'medium' },
        ],
      });
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.influence.filter((i) => i.factor.includes('Constraint')).length).toBe(2);
    });

    it('should handle empty constraints', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ constraints: [] });
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.influence.filter((i) => i.factor.includes('Constraint')).length).toBe(0);
    });
  });

  describe('energy level effects', () => {
    it('should not modify principles at high energy (8-10)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 9 });
      const principles = [createAppliedPrinciple({ strength: 0.8 })];

      const result = service.integrate(request, context, principles);

      // At high energy, no energy-related modifications
      expect(result.influence.filter((i) => i.factor === 'Energy level').length).toBe(0);
    });

    it('should not modify at energy level 8 boundary', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 8 });
      const principles = [createAppliedPrinciple({ strength: 0.75 })];

      const result = service.integrate(request, context, principles);

      expect(result.influence.filter((i) => i.factor === 'Energy level').length).toBe(0);
    });

    it('should add minor bias at medium energy (5-7)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 6, activeGoals: [] }); // No goals to avoid goal boost
      const principles = [
        createAppliedPrinciple({
          principleText: 'Try novel approaches to problem-solving',
          strength: 0.8,
        }),
      ];

      const result = service.integrate(request, context, principles);

      // Novel/complex principles should be slightly reduced (5% reduction)
      // 0.8 * 0.95 = 0.76
      expect(result.adjustedPrinciples[0].strength).toBeLessThan(0.8);
      expect(result.influence.some((i) => i.factor === 'Energy level')).toBe(true);
    });

    it('should add warning at low energy (3-4)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 4 });
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.type === 'energy_warning')).toBe(true);
    });

    it('should significantly reduce complex principles at low energy (3-4)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 3 });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Embrace complex challenges that push boundaries',
          strength: 0.85,
        }),
      ];

      const result = service.integrate(request, context, principles);

      // At low energy, complex principles get reduced by 20%
      // 0.85 * 0.8 = 0.68
      expect(result.adjustedPrinciples[0].strength).toBeLessThan(0.85);
    });

    it('should boost simple/safe principles at low energy (3-4)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 3 });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Keep things simple and proven',
          strength: 0.5,
        }),
      ];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples[0].strength).toBeGreaterThan(0.5);
    });

    it('should add urgent warning at very low energy (1-2)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 2 });
      const principles = [createAppliedPrinciple()];

      const result = service.integrate(request, context, principles);

      expect(result.warnings.some((w) => w.severity === 'critical')).toBe(true);
      expect(result.warnings.some((w) => w.message.includes('URGENT'))).toBe(true);
    });

    it('should strongly reduce risky principles at very low energy (1-2)', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 1 });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Take bold risks for high rewards',
          strength: 0.85,
        }),
      ];

      const result = service.integrate(request, context, principles);

      // At very low energy, risky principles get reduced by 50%
      // 0.85 * 0.5 = 0.425
      expect(result.adjustedPrinciples[0].strength).toBeLessThanOrEqual(0.5);
    });

    it('should strongly boost safe/reversible principles at very low energy', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 2 });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Choose safe and reversible options',
          strength: 0.4,
        }),
      ];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples[0].strength).toBeGreaterThan(0.5);
    });
  });

  describe('getContextModifier', () => {
    it('should return 1.0 for high energy and low fatigue', () => {
      const context = createUserContext({ energyLevel: 9, decisionFatigue: 0.2 });

      const modifier = service.getContextModifier(context);

      expect(modifier).toBe(1.0);
    });

    it('should reduce modifier for medium energy', () => {
      const context = createUserContext({ energyLevel: 6, decisionFatigue: 0.2 });

      const modifier = service.getContextModifier(context);

      expect(modifier).toBeLessThan(1.0);
      expect(modifier).toBeGreaterThan(0.9);
    });

    it('should reduce modifier for low energy', () => {
      const context = createUserContext({ energyLevel: 4, decisionFatigue: 0.2 });

      const modifier = service.getContextModifier(context);

      expect(modifier).toBeLessThan(0.9);
    });

    it('should reduce modifier for very low energy', () => {
      const context = createUserContext({ energyLevel: 2, decisionFatigue: 0.2 });

      const modifier = service.getContextModifier(context);

      expect(modifier).toBeLessThan(0.8);
    });

    it('should reduce modifier for high decision fatigue', () => {
      const context = createUserContext({ energyLevel: 8, decisionFatigue: 0.8 });

      const modifier = service.getContextModifier(context);

      expect(modifier).toBeLessThan(1.0);
    });

    it('should compound energy and fatigue effects', () => {
      const lowEnergyOnly = createUserContext({ energyLevel: 4, decisionFatigue: 0.2 });
      const highFatigueOnly = createUserContext({ energyLevel: 8, decisionFatigue: 0.8 });
      const both = createUserContext({ energyLevel: 4, decisionFatigue: 0.8 });

      const modifierLowEnergy = service.getContextModifier(lowEnergyOnly);
      const modifierHighFatigue = service.getContextModifier(highFatigueOnly);
      const modifierBoth = service.getContextModifier(both);

      expect(modifierBoth).toBeLessThan(modifierLowEnergy);
      expect(modifierBoth).toBeLessThan(modifierHighFatigue);
    });
  });

  describe('integration scenarios', () => {
    it('should combine goal alignment and energy effects', () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const context = createUserContext({
        energyLevel: 5,
        activeGoals: [
          { id: 'goal-1', description: 'Leadership growth', priority: 1, domains: ['career'] },
        ],
      });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Develop leadership through challenging projects',
          strength: 0.7,
        }),
      ];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples.length).toBe(1);
      expect(result.influence.length).toBeGreaterThan(0);
    });

    it('should handle full context with goals, constraints, and low energy', () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const context = createUserContext({
        energyLevel: 3,
        decisionFatigue: 0.6,
        activeGoals: [
          { id: 'goal-1', description: 'Work-life balance', priority: 1, domains: ['personal'] },
        ],
        constraints: [
          { type: 'time', description: 'Limited time', severity: 'high' },
        ],
      });
      const principles = [createAppliedPrinciple({ strength: 0.8 })];

      const result = service.integrate(request, context, principles);

      // Should have warnings from low energy and constraints
      expect(result.warnings.length).toBeGreaterThan(0);
      // Should have influence from energy, constraints
      expect(result.influence.length).toBeGreaterThan(0);
    });

    it('should handle multiple principles', () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const context = createUserContext({ energyLevel: 6 });
      const principles = [
        createAppliedPrinciple({ principleId: 'p1', strength: 0.8 }),
        createAppliedPrinciple({ principleId: 'p2', strength: 0.7 }),
        createAppliedPrinciple({ principleId: 'p3', strength: 0.6 }),
      ];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples.length).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should cap strength at 1.0', () => {
      const request = createDecisionRequest({ domain: ['career'] });
      const context = createUserContext({
        energyLevel: 1,
        activeGoals: [
          { id: 'goal-1', description: 'Choose safe reversible options', priority: 1, domains: ['career'] },
        ],
      });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Choose safe reversible options always',
          strength: 0.95,
        }),
      ];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples[0].strength).toBeLessThanOrEqual(1.0);
    });

    it('should maintain non-negative strength', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 1 });
      const principles = [
        createAppliedPrinciple({
          principleText: 'Take bold risks aggressively',
          strength: 0.1,
        }),
      ];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples[0].strength).toBeGreaterThanOrEqual(0);
    });

    it('should handle principle with zero strength', () => {
      const request = createDecisionRequest();
      const context = createUserContext({ energyLevel: 5 });
      const principles = [createAppliedPrinciple({ strength: 0 })];

      const result = service.integrate(request, context, principles);

      expect(result.adjustedPrinciples[0].strength).toBeGreaterThanOrEqual(0);
      expect(result.adjustedPrinciples[0].strength).toBeLessThanOrEqual(1);
    });
  });
});
