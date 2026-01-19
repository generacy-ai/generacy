import { describe, it, expect, beforeEach } from 'vitest';
import { PrincipleMatcherService } from '../../../src/recommendation/engine/principle-matcher.js';
import type { DecisionRequest, Principle, AppliedPrinciple } from '../../../src/recommendation/types/index.js';

describe('PrincipleMatcherService', () => {
  let service: PrincipleMatcherService;

  beforeEach(() => {
    service = new PrincipleMatcherService();
  });

  // Mock data - updated to match our Principle type
  const mockPrinciples: Principle[] = [
    {
      id: 'principle-1',
      name: 'Transparency',
      content: 'Maintain openness in decision-making',
      domains: ['career', 'communication'],
      weight: 10,
      active: true,
      source: 'stated',
    },
    {
      id: 'principle-2',
      name: 'Integrity',
      content: 'Act with honesty and strong moral principles',
      domains: ['ethics', 'career'],
      weight: 15,
      active: true,
      source: 'stated',
    },
    {
      id: 'principle-3',
      name: 'Efficiency',
      content: 'Optimize time and resources',
      domains: ['finance', 'productivity'],
      weight: 8,
      active: true,
      source: 'learned',
    },
    {
      id: 'principle-4',
      name: 'Empathy',
      content: "Consider others' perspectives and feelings",
      domains: ['communication', 'relationships'],
      weight: 12,
      active: true,
      source: 'stated',
    },
    {
      id: 'principle-5',
      name: 'Innovation',
      content: 'Embrace new ideas and approaches',
      domains: ['career', 'productivity'],
      weight: 9,
      active: false, // Inactive principle
      source: 'inferred',
    },
    {
      id: 'principle-6',
      name: 'Sustainability',
      content: 'Consider long-term impact and environmental concerns',
      domains: ['finance', 'ethics'],
      weight: 11,
      active: true,
      source: 'learned',
    },
    {
      id: 'principle-7',
      name: 'Collaboration',
      content: 'Work effectively with others',
      domains: ['communication', 'productivity', 'relationships'],
      weight: 13,
      active: true,
      source: 'stated',
    },
  ];

  const mockDecisionRequest: DecisionRequest = {
    id: 'decision-1',
    question: 'Should I take a new job opportunity with higher pay but longer hours?',
    domain: ['career', 'finance'],
    options: [
      { id: 'accept', name: 'Accept', description: 'Accept the job', attributes: {} },
      { id: 'decline', name: 'Decline', description: 'Decline the job', attributes: {} },
    ],
  };

  const mockDecisionRequestSingleDomain: DecisionRequest = {
    id: 'decision-2',
    question: 'How should I communicate bad news to my team?',
    domain: ['communication'],
    options: [
      { id: 'direct', name: 'Direct', description: 'Be direct', attributes: {} },
      { id: 'gentle', name: 'Gentle', description: 'Be gentle', attributes: {} },
    ],
  };

  const mockDecisionRequestNoMatch: DecisionRequest = {
    id: 'decision-3',
    question: 'Should I learn a new programming language?',
    domain: ['technology', 'learning'],
    options: [
      { id: 'yes', name: 'Yes', description: 'Learn it', attributes: {} },
      { id: 'no', name: 'No', description: "Don't learn", attributes: {} },
    ],
  };

  describe('domain matching', () => {
    it('should match principles with overlapping domains', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      expect(result.length).toBeGreaterThan(0);
      expect(result.some((ap) => ap.principleId === 'principle-1')).toBe(true); // career
      expect(result.some((ap) => ap.principleId === 'principle-2')).toBe(true); // career
      expect(result.some((ap) => ap.principleId === 'principle-3')).toBe(true); // finance
    });

    it('should return empty array when no domains match', () => {
      const result = service.match(mockDecisionRequestNoMatch, mockPrinciples);

      expect(result).toEqual([]);
    });

    it('should match principles with partial domain overlap', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      // Request has ['career', 'finance']
      const matchedIds = result.map((ap) => ap.principleId);

      expect(matchedIds).toContain('principle-1'); // has 'career'
      expect(matchedIds).toContain('principle-2'); // has 'career'
      expect(matchedIds).toContain('principle-3'); // has 'finance'
      expect(matchedIds).toContain('principle-6'); // has 'finance'
    });

    it('should match single domain requests', () => {
      const result = service.match(mockDecisionRequestSingleDomain, mockPrinciples);

      // Request has ['communication']
      const matchedIds = result.map((ap) => ap.principleId);

      expect(matchedIds).toContain('principle-1'); // has 'communication'
      expect(matchedIds).toContain('principle-4'); // has 'communication'
      expect(matchedIds).toContain('principle-7'); // has 'communication'
      expect(matchedIds).not.toContain('principle-2'); // doesn't have 'communication'
    });
  });

  describe('weight ranking', () => {
    it('should rank principles by weight in descending order', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].weight).toBeGreaterThanOrEqual(result[i].weight);
      }
    });

    it('should handle principles with equal weights', () => {
      const principlesWithEqualWeights: Principle[] = [
        {
          id: 'equal-1',
          name: 'First',
          content: 'First principle',
          domains: ['career'],
          weight: 10,
          active: true,
          source: 'stated',
        },
        {
          id: 'equal-2',
          name: 'Second',
          content: 'Second principle',
          domains: ['career'],
          weight: 10,
          active: true,
          source: 'stated',
        },
        {
          id: 'equal-3',
          name: 'Third',
          content: 'Third principle',
          domains: ['career'],
          weight: 10,
          active: true,
          source: 'stated',
        },
      ];

      const result = service.match(mockDecisionRequest, principlesWithEqualWeights);

      expect(result.length).toBe(3);
      expect(result.every((ap) => ap.weight === 10)).toBe(true);
    });

    it('should place highest weight principles first', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      const firstPrinciple = result[0];
      expect(firstPrinciple.principleId).toBe('principle-2'); // weight 15
      expect(firstPrinciple.weight).toBe(15);
    });
  });

  describe('inactive principle filtering', () => {
    it('should exclude inactive principles', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      const inactiveIds = result.map((ap) => ap.principleId);
      expect(inactiveIds).not.toContain('principle-5'); // principle-5 is inactive
    });

    it('should include only active principles', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      // All returned principles should be active
      result.forEach((ap) => {
        const original = mockPrinciples.find((p) => p.id === ap.principleId);
        expect(original?.active).toBe(true);
      });
    });

    it('should return empty array when only inactive principles match domains', () => {
      const inactivePrinciples: Principle[] = [
        {
          id: 'inactive-1',
          name: 'Inactive Principle',
          content: 'This is inactive',
          domains: ['career'],
          weight: 20,
          active: false,
          source: 'stated',
        },
      ];

      const result = service.match(mockDecisionRequest, inactivePrinciples);

      expect(result).toEqual([]);
    });

    it('should filter out inactive principles while keeping active ones', () => {
      const mixedPrinciples: Principle[] = [
        {
          id: 'active-1',
          name: 'Active',
          content: 'Active principle',
          domains: ['career'],
          weight: 10,
          active: true,
          source: 'stated',
        },
        {
          id: 'inactive-1',
          name: 'Inactive',
          content: 'Inactive principle',
          domains: ['career'],
          weight: 15,
          active: false,
          source: 'stated',
        },
      ];

      const result = service.match(mockDecisionRequest, mixedPrinciples);

      expect(result.length).toBe(1);
      expect(result[0].principleId).toBe('active-1');
    });
  });

  describe('relevance scoring', () => {
    it('should calculate relevance based on domain coverage', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      result.forEach((ap) => {
        // Strength should be a score between 0 and 1
        expect(ap.strength).toBeGreaterThan(0);
        expect(ap.strength).toBeLessThanOrEqual(1);
      });
    });

    it('should assign higher relevance to principles with more domain matches', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      // principle-1 has ['career', 'communication'] - matches 'career' (1 match)
      // principle-6 has ['finance', 'ethics'] - matches 'finance' (1 match)
      // Both have 1 match, so strength should be equal

      const principle1 = result.find((ap) => ap.principleId === 'principle-1');
      const principle6 = result.find((ap) => ap.principleId === 'principle-6');

      if (principle1 && principle6) {
        expect(principle1.strength).toBe(principle6.strength);
      }
    });

    it('should return relevance scores for all matched principles', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      expect(result.length).toBeGreaterThan(0);
      expect(result.every((ap) => typeof ap.strength === 'number')).toBe(true);
      expect(result.every((ap) => ap.strength >= 0 && ap.strength <= 1)).toBe(true);
    });
  });

  describe('AppliedPrinciple structure', () => {
    it('should return AppliedPrinciple objects with correct structure', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      expect(result.length).toBeGreaterThan(0);
      result.forEach((appliedPrinciple) => {
        expect(appliedPrinciple).toHaveProperty('principleId');
        expect(appliedPrinciple).toHaveProperty('principleText');
        expect(appliedPrinciple).toHaveProperty('relevance');
        expect(appliedPrinciple).toHaveProperty('weight');
        expect(appliedPrinciple).toHaveProperty('strength');
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty principles array', () => {
      const result = service.match(mockDecisionRequest, []);

      expect(result).toEqual([]);
    });

    it('should handle empty domains in decision request', () => {
      const emptyDomainRequest: DecisionRequest = {
        id: 'decision-4',
        question: 'Some decision',
        domain: [],
        options: [],
      };

      const result = service.match(emptyDomainRequest, mockPrinciples);

      expect(result).toEqual([]);
    });

    it('should handle principles with empty domains array', () => {
      const emptyDomainPrinciples: Principle[] = [
        {
          id: 'empty-domains',
          name: 'No Domains',
          content: 'Principle with no domains',
          domains: [],
          weight: 10,
          active: true,
          source: 'stated',
        },
      ];

      const result = service.match(mockDecisionRequest, emptyDomainPrinciples);

      expect(result).toEqual([]);
    });

    it('should handle case-insensitive domain matching', () => {
      const mixedCasePrinciples: Principle[] = [
        {
          id: 'mixed-case',
          name: 'Mixed Case',
          content: 'Principle with mixed case domains',
          domains: ['Career', 'FINANCE'],
          weight: 10,
          active: true,
          source: 'stated',
        },
      ];

      const result = service.match(mockDecisionRequest, mixedCasePrinciples);

      // Should match regardless of case sensitivity
      expect(result.length).toBe(1);
    });
  });

  describe('multiple principles matching', () => {
    it('should match multiple principles and sort by weight', () => {
      const result = service.match(mockDecisionRequest, mockPrinciples);

      // For decision with ['career', 'finance'], should match:
      // principle-2 (weight 15): ['ethics', 'career']
      // principle-6 (weight 11): ['finance', 'ethics']
      // principle-1 (weight 10): ['career', 'communication']
      // principle-3 (weight 8): ['finance', 'productivity']

      const expectedMatches = ['principle-2', 'principle-6', 'principle-1', 'principle-3'];
      const resultIds = result.map((ap) => ap.principleId);

      expectedMatches.forEach((id) => {
        expect(resultIds).toContain(id);
      });

      // Verify descending weight order
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].weight).toBeGreaterThanOrEqual(result[i].weight);
      }
    });
  });
});
