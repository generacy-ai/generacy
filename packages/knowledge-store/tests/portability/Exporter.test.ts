import { describe, it, expect } from 'vitest';
import { exportKnowledge, verifyChecksum } from '../../src/portability/Exporter.js';
import type { Philosophy, Principle, Pattern, UserContext } from '../../src/types/knowledge.js';

describe('Exporter', () => {
  const basePhilosophy: Philosophy = {
    values: [{ name: 'Quality', description: 'Quality over speed', priority: 9 }],
    beliefs: [
      {
        statement: 'Code should be readable',
        confidence: 0.9,
        domain: ['coding', 'company-internal'],
      },
    ],
    identity: {
      professionalTitle: 'Engineer',
      expertise: ['TypeScript'],
      yearsExperience: 10,
    },
  };

  const basePrinciples: Principle[] = [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Always write tests before implementation',
      domain: ['testing', 'coding'],
      weight: 0.9,
      evidence: [
        {
          decision: 'Used TDD for feature',
          context: 'Building internal company tool',
          timestamp: '2024-01-15T10:00:00.000Z',
        },
      ],
      status: 'active',
      metadata: {
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
    },
    {
      id: '550e8400-e29b-41d4-a716-446655440001',
      content: 'Deprecated principle no longer used',
      domain: ['legacy'],
      weight: 0.3,
      evidence: [],
      status: 'deprecated',
      metadata: {
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        deprecatedAt: '2024-01-01T00:00:00.000Z',
        deprecationReason: 'No longer relevant',
      },
    },
  ];

  const basePatterns: Pattern[] = [
    {
      id: '660e8400-e29b-41d4-a716-446655440000',
      description: 'Using composition over inheritance',
      occurrences: [
        {
          context: 'Building company React app',
          timestamp: '2024-01-15T10:00:00.000Z',
          decision: 'Used composition',
        },
      ],
      status: 'emerging',
      domain: ['react', 'design'],
      firstSeen: '2024-01-15T10:00:00.000Z',
      lastSeen: '2024-01-15T10:00:00.000Z',
    },
  ];

  const baseContext: UserContext = {
    currentProject: {
      name: 'Internal Tool',
      type: 'web-app',
      technologies: ['React', 'TypeScript'],
    },
    recentDecisions: [],
    activeGoals: ['Complete MVP'],
    preferences: { verbosity: 'normal' },
  };

  describe('full export', () => {
    it('should include all data', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'full'
      );

      expect(result.level).toBe('full');
      expect(result.version).toBe('1.0.0');
      expect(result.philosophy).toEqual(basePhilosophy);
      expect(result.principles).toHaveLength(1); // Deprecated excluded
      expect(result.principles?.[0]?.evidence).toBeDefined();
      expect(result.patterns).toHaveLength(1);
      expect(result.context).toEqual(baseContext);
      expect(result.checksum).toBeDefined();
    });

    it('should exclude deprecated principles', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'full'
      );

      expect(result.principles?.every((p) => p.id !== basePrinciples[1]?.id)).toBe(
        true
      );
    });
  });

  describe('redacted export', () => {
    it('should remove org-specific domains from beliefs', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'redacted'
      );

      expect(result.philosophy?.beliefs[0]?.domain).not.toContain('company-internal');
      expect(result.philosophy?.beliefs[0]?.domain).toContain('coding');
    });

    it('should redact org references in evidence context', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'redacted'
      );

      const principle = result.principles?.[0];
      expect(principle?.evidence?.[0]?.context).toContain('[REDACTED]');
    });

    it('should exclude context', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'redacted'
      );

      expect(result.context).toBeUndefined();
    });

    it('should include identity', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'redacted'
      );

      expect(result.philosophy?.identity.professionalTitle).toBe('Engineer');
    });
  });

  describe('abstracted export', () => {
    it('should not include evidence', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'abstracted'
      );

      expect(result.principles?.[0]?.evidence).toBeUndefined();
      expect(result.principles?.[0]?.evidenceCount).toBe(1);
    });

    it('should anonymize identity', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'abstracted'
      );

      expect(result.philosophy?.identity).toEqual({});
    });

    it('should exclude patterns', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'abstracted'
      );

      expect(result.patterns).toBeUndefined();
    });

    it('should exclude context', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'abstracted'
      );

      expect(result.context).toBeUndefined();
    });
  });

  describe('checksum', () => {
    it('should generate valid checksum', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'full'
      );

      expect(verifyChecksum(result)).toBe(true);
    });

    it('should detect tampered data', () => {
      const result = exportKnowledge(
        basePhilosophy,
        basePrinciples,
        basePatterns,
        baseContext,
        'full'
      );

      // Tamper with data
      result.philosophy!.values[0]!.name = 'Tampered';

      expect(verifyChecksum(result)).toBe(false);
    });
  });
});
