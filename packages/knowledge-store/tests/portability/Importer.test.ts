import { describe, it, expect } from 'vitest';
import { importKnowledge, applyImport } from '../../src/portability/Importer.js';
import { exportKnowledge } from '../../src/portability/Exporter.js';
import type { Philosophy, Principle, Pattern, UserContext } from '../../src/types/knowledge.js';
import type { ExportedKnowledge } from '../../src/types/portability.js';

describe('Importer', () => {
  const emptyPhilosophy: Philosophy = {
    values: [],
    beliefs: [],
    identity: {},
  };

  const existingPrinciples: Principle[] = [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Always write tests before implementation',
      domain: ['testing'],
      weight: 0.9,
      evidence: [],
      status: 'active',
      metadata: {
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    },
  ];

  const existingPatterns: Pattern[] = [];

  function createValidExport(
    principles: Principle[],
    philosophy: Philosophy = emptyPhilosophy
  ): ExportedKnowledge {
    return exportKnowledge(
      philosophy,
      principles,
      [],
      { recentDecisions: [], activeGoals: [], preferences: { verbosity: 'normal' } },
      'full'
    );
  }

  describe('checksum verification', () => {
    it('should fail on invalid checksum', () => {
      const data: ExportedKnowledge = {
        version: '1.0.0',
        level: 'full',
        exportedAt: '2024-01-01T00:00:00.000Z',
        checksum: 'invalid-checksum',
      };

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Checksum verification failed');
    });
  });

  describe('principle import', () => {
    it('should import new principles', () => {
      const newPrinciple: Principle = {
        id: '660e8400-e29b-41d4-a716-446655440000',
        content: 'A completely new principle for testing',
        domain: ['new-domain'],
        weight: 0.7,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([newPrinciple]);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.imported.principles).toBe(1);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should detect ID collision conflicts', () => {
      const conflictingPrinciple: Principle = {
        id: '550e8400-e29b-41d4-a716-446655440000', // Same ID as existing
        content: 'Different content with the same identifier',
        domain: ['different'],
        weight: 0.5,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([conflictingPrinciple]);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.type).toBe('principle');
    });

    it('should detect similar content conflicts', () => {
      const similarPrinciple: Principle = {
        id: '770e8400-e29b-41d4-a716-446655440000',
        // Very similar to existing: "Always write tests before implementation"
        // Using same words in slightly different order to exceed 70% threshold
        content: 'Write tests before implementation always',
        domain: ['testing'],
        weight: 0.8,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([similarPrinciple]);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.conflicts).toHaveLength(1);
    });

    it('should auto-resolve low-weight conflicts', () => {
      const lowWeightPrinciple: Principle = {
        id: '550e8400-e29b-41d4-a716-446655440000', // Same ID
        content: 'Same ID but low weight principle',
        domain: ['testing'],
        weight: 0.3,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([lowWeightPrinciple]);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.conflicts[0]?.resolution).toBe('auto');
      expect(result.conflicts[0]?.autoResolved).toBe(true);
    });

    it('should require review for high-weight conflicts', () => {
      const highWeightPrinciple: Principle = {
        id: '550e8400-e29b-41d4-a716-446655440000', // Same ID
        content: 'Same ID but high weight principle',
        domain: ['testing'],
        weight: 0.95,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([highWeightPrinciple]);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.conflicts[0]?.resolution).toBe('pending');
      expect(result.success).toBe(false);
    });
  });

  describe('philosophy import', () => {
    it('should import philosophy when none exists', () => {
      const philosophy: Philosophy = {
        values: [{ name: 'Quality', description: 'Quality first', priority: 9 }],
        beliefs: [],
        identity: {},
      };

      const data = createValidExport([], philosophy);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      expect(result.imported.philosophy).toBe(true);
    });

    it('should create conflict when philosophy exists', () => {
      const existingPhilosophy: Philosophy = {
        values: [{ name: 'Speed', description: 'Move fast', priority: 8 }],
        beliefs: [],
        identity: {},
      };

      const incomingPhilosophy: Philosophy = {
        values: [{ name: 'Quality', description: 'Quality first', priority: 9 }],
        beliefs: [],
        identity: {},
      };

      const data = createValidExport([], incomingPhilosophy);

      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        existingPhilosophy,
        data
      );

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.type).toBe('philosophy');
      expect(result.conflicts[0]?.resolution).toBe('pending');
    });
  });

  describe('applyImport', () => {
    it('should return new principles to add', () => {
      const newPrinciple: Principle = {
        id: '660e8400-e29b-41d4-a716-446655440000',
        content: 'Brand new principle to be imported',
        domain: ['new'],
        weight: 0.7,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([newPrinciple]);
      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      const { principles, patterns } = applyImport(data, result);

      expect(principles).toHaveLength(1);
      expect(principles[0]?.content).toBe('Brand new principle to be imported');
    });

    it('should not include conflicting principles', () => {
      const conflictPrinciple: Principle = {
        id: '550e8400-e29b-41d4-a716-446655440000', // Same ID
        content: 'Conflicting principle with same ID',
        domain: ['test'],
        weight: 0.5,
        evidence: [],
        status: 'active',
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };

      const data = createValidExport([conflictPrinciple]);
      const result = importKnowledge(
        existingPrinciples,
        existingPatterns,
        emptyPhilosophy,
        data
      );

      const { principles } = applyImport(data, result);

      expect(principles).toHaveLength(0);
    });
  });
});
