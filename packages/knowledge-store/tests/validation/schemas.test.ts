import { describe, it, expect } from 'vitest';
import {
  valueSchema,
  beliefSchema,
  philosophySchema,
  evidenceSchema,
  principleSchema,
  patternSchema,
  userContextSchema,
} from '../../src/validation/schemas.js';

describe('valueSchema', () => {
  it('should validate a valid value', () => {
    const value = {
      name: 'Quality over speed',
      description: 'Take time to do things right',
      priority: 9,
    };
    expect(valueSchema.safeParse(value).success).toBe(true);
  });

  it('should reject name too short', () => {
    const value = {
      name: 'Q',
      description: 'Description',
      priority: 5,
    };
    expect(valueSchema.safeParse(value).success).toBe(false);
  });

  it('should reject priority out of range', () => {
    const value = {
      name: 'Test value',
      description: 'Description',
      priority: 11,
    };
    expect(valueSchema.safeParse(value).success).toBe(false);
  });
});

describe('beliefSchema', () => {
  it('should validate a valid belief', () => {
    const belief = {
      statement: 'Code should be self-documenting',
      confidence: 0.85,
      domain: ['coding', 'typescript'],
    };
    expect(beliefSchema.safeParse(belief).success).toBe(true);
  });

  it('should reject statement too short', () => {
    const belief = {
      statement: 'Short',
      confidence: 0.5,
      domain: [],
    };
    expect(beliefSchema.safeParse(belief).success).toBe(false);
  });

  it('should reject confidence out of range', () => {
    const belief = {
      statement: 'Code should be self-documenting',
      confidence: 1.5,
      domain: [],
    };
    expect(beliefSchema.safeParse(belief).success).toBe(false);
  });
});

describe('philosophySchema', () => {
  it('should validate a valid philosophy', () => {
    const philosophy = {
      values: [
        { name: 'Quality', description: 'Quality over speed', priority: 9 },
      ],
      beliefs: [
        { statement: 'Code should be self-documenting', confidence: 0.85, domain: ['coding'] },
      ],
      identity: {
        professionalTitle: 'Software Engineer',
        expertise: ['TypeScript', 'React'],
        yearsExperience: 10,
      },
    };
    expect(philosophySchema.safeParse(philosophy).success).toBe(true);
  });

  it('should validate philosophy with empty arrays', () => {
    const philosophy = {
      values: [],
      beliefs: [],
      identity: {},
    };
    expect(philosophySchema.safeParse(philosophy).success).toBe(true);
  });
});

describe('evidenceSchema', () => {
  it('should validate valid evidence', () => {
    const evidence = {
      decision: 'Chose TypeScript over JavaScript',
      context: 'Building a large-scale application',
      outcome: 'positive' as const,
      timestamp: '2024-01-15T10:00:00.000Z',
    };
    expect(evidenceSchema.safeParse(evidence).success).toBe(true);
  });

  it('should validate evidence without outcome', () => {
    const evidence = {
      decision: 'Used async/await',
      context: 'API integration',
      timestamp: '2024-01-15T10:00:00.000Z',
    };
    expect(evidenceSchema.safeParse(evidence).success).toBe(true);
  });

  it('should reject invalid timestamp', () => {
    const evidence = {
      decision: 'Test decision',
      context: 'Test context',
      timestamp: 'not-a-date',
    };
    expect(evidenceSchema.safeParse(evidence).success).toBe(false);
  });
});

describe('principleSchema', () => {
  it('should validate a valid principle', () => {
    const principle = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Always write tests before implementation',
      domain: ['coding', 'testing'],
      weight: 0.9,
      evidence: [],
      status: 'active' as const,
      metadata: {
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
    };
    expect(principleSchema.safeParse(principle).success).toBe(true);
  });

  it('should reject principle without domain', () => {
    const principle = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Always write tests before implementation',
      domain: [],
      weight: 0.9,
      evidence: [],
      status: 'active' as const,
      metadata: {
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
    };
    expect(principleSchema.safeParse(principle).success).toBe(false);
  });

  it('should reject invalid UUID', () => {
    const principle = {
      id: 'not-a-uuid',
      content: 'Always write tests before implementation',
      domain: ['coding'],
      weight: 0.9,
      evidence: [],
      status: 'active' as const,
      metadata: {
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
    };
    expect(principleSchema.safeParse(principle).success).toBe(false);
  });

  it('should validate deprecated principle', () => {
    const principle = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'An outdated principle that is no longer used',
      domain: ['legacy'],
      weight: 0.5,
      evidence: [],
      status: 'deprecated' as const,
      metadata: {
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
        deprecatedAt: '2024-06-15T10:00:00.000Z',
        deprecationReason: 'No longer relevant',
      },
    };
    expect(principleSchema.safeParse(principle).success).toBe(true);
  });
});

describe('patternSchema', () => {
  it('should validate a valid pattern', () => {
    const pattern = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Using composition over inheritance in React',
      occurrences: [
        {
          context: 'Building component library',
          timestamp: '2024-01-15T10:00:00.000Z',
          decision: 'Used composition pattern',
        },
      ],
      status: 'emerging' as const,
      domain: ['react', 'design'],
      firstSeen: '2024-01-15T10:00:00.000Z',
      lastSeen: '2024-01-15T10:00:00.000Z',
    };
    expect(patternSchema.safeParse(pattern).success).toBe(true);
  });

  it('should validate promoted pattern', () => {
    const pattern = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Using composition over inheritance in React',
      occurrences: [],
      status: 'promoted' as const,
      domain: ['react'],
      firstSeen: '2024-01-15T10:00:00.000Z',
      lastSeen: '2024-01-15T10:00:00.000Z',
      promotedTo: '660e8400-e29b-41d4-a716-446655440000',
    };
    expect(patternSchema.safeParse(pattern).success).toBe(true);
  });

  it('should reject description too short', () => {
    const pattern = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Short',
      occurrences: [],
      status: 'emerging' as const,
      domain: [],
      firstSeen: '2024-01-15T10:00:00.000Z',
      lastSeen: '2024-01-15T10:00:00.000Z',
    };
    expect(patternSchema.safeParse(pattern).success).toBe(false);
  });
});

describe('userContextSchema', () => {
  it('should validate a valid user context', () => {
    const context = {
      currentProject: {
        name: 'Knowledge Store',
        type: 'library',
        technologies: ['TypeScript', 'Node.js'],
      },
      recentDecisions: [
        {
          summary: 'Chose Zod for validation',
          timestamp: '2024-01-15T10:00:00.000Z',
          principlesApplied: ['550e8400-e29b-41d4-a716-446655440000'],
        },
      ],
      activeGoals: ['Complete MVP', 'Write tests'],
      preferences: {
        verbosity: 'normal' as const,
        codeStyle: 'functional',
      },
    };
    expect(userContextSchema.safeParse(context).success).toBe(true);
  });

  it('should validate minimal context', () => {
    const context = {
      recentDecisions: [],
      activeGoals: [],
      preferences: {
        verbosity: 'minimal' as const,
      },
    };
    expect(userContextSchema.safeParse(context).success).toBe(true);
  });

  it('should allow extra properties in preferences', () => {
    const context = {
      recentDecisions: [],
      activeGoals: [],
      preferences: {
        verbosity: 'detailed' as const,
        customSetting: 'value',
        anotherSetting: 123,
      },
    };
    const result = userContextSchema.safeParse(context);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferences.customSetting).toBe('value');
    }
  });
});
