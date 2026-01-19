import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeStore } from '../../src/index.js';
import type { KnowledgeStoreManager } from '../../src/index.js';

describe('Full Workflow Integration', () => {
  let store: KnowledgeStoreManager;
  let testDir: string;
  const user1 = 'user-1';
  const user2 = 'user-2';

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-integration-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    store = createKnowledgeStore({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('complete user workflow', () => {
    it('should support full knowledge lifecycle', async () => {
      // 1. Create philosophy
      await store.updatePhilosophy(user1, {
        values: [
          { name: 'Quality', description: 'Quality over speed', priority: 9 },
          { name: 'Simplicity', description: 'Keep it simple', priority: 8 },
        ],
        beliefs: [
          {
            statement: 'Good code is self-documenting',
            confidence: 0.85,
            domain: ['coding'],
          },
        ],
        identity: {
          professionalTitle: 'Software Engineer',
          expertise: ['TypeScript', 'React'],
          yearsExperience: 10,
        },
      });

      // 2. Add principles
      const principleId1 = await store.addPrinciple(user1, {
        content: 'Always write tests before implementing features',
        domain: ['coding', 'testing'],
        weight: 0.9,
        status: 'active',
      });

      const principleId2 = await store.addPrinciple(user1, {
        content: 'Prefer composition over inheritance in design',
        domain: ['design', 'architecture'],
        weight: 0.8,
        status: 'active',
      });

      // 3. Add a pattern
      const patternId = await store.addPattern(user1, {
        description: 'Using functional components with hooks in React',
        domain: ['react', 'coding'],
      });

      // 4. Update context
      await store.updateContext(user1, {
        currentProject: {
          name: 'Knowledge Store',
          type: 'library',
          technologies: ['TypeScript', 'Node.js'],
        },
        activeGoals: ['Complete MVP', 'Write documentation'],
      });

      // 5. Get complete knowledge
      const knowledge = await store.getKnowledge(user1);

      expect(knowledge.userId).toBe(user1);
      expect(knowledge.philosophy.values).toHaveLength(2);
      expect(knowledge.principles).toHaveLength(2);
      expect(knowledge.patterns).toHaveLength(1);
      expect(knowledge.context.activeGoals).toHaveLength(2);

      // 6. Filter principles by domain
      const codingPrinciples = await store.getPrinciples(user1, ['coding']);
      expect(codingPrinciples).toHaveLength(1);
      expect(codingPrinciples[0]?.id).toBe(principleId1);

      // 7. Promote pattern to principle
      const promotedPrincipleId = await store.promoteToAnciple(user1, patternId);
      expect(promotedPrincipleId).toBeDefined();

      const patterns = await store.getPatterns(user1);
      expect(patterns[0]?.status).toBe('promoted');
      expect(patterns[0]?.promotedTo).toBe(promotedPrincipleId);

      const principles = await store.getPrinciples(user1);
      expect(principles).toHaveLength(3);

      // 8. Deprecate a principle
      await store.deprecatePrinciple(user1, principleId2, 'Replaced by new principle');

      const deprecated = await store.getPrinciples(user1);
      const deprecatedPrinciple = deprecated.find((p) => p.id === principleId2);
      expect(deprecatedPrinciple?.status).toBe('deprecated');
    });

    it('should support export and import between users', async () => {
      // Setup user1's knowledge
      await store.updatePhilosophy(user1, {
        values: [{ name: 'Quality', description: 'Quality first', priority: 9 }],
        beliefs: [],
        identity: { professionalTitle: 'Engineer' },
      });

      await store.addPrinciple(user1, {
        content: 'Write tests for all public functions',
        domain: ['testing'],
        weight: 0.8,
        status: 'active',
      });

      // Export user1's knowledge
      const exported = await store.exportKnowledge(user1, 'full');

      expect(exported.level).toBe('full');
      expect(exported.philosophy).toBeDefined();
      expect(exported.principles).toHaveLength(1);

      // Import to user2
      const importResult = await store.importKnowledge(user2, exported);

      expect(importResult.imported.principles).toBe(1);
      expect(importResult.imported.philosophy).toBe(true);

      // Verify user2 has the knowledge
      const user2Knowledge = await store.getKnowledge(user2);
      expect(user2Knowledge.philosophy.values).toHaveLength(1);
      expect(user2Knowledge.principles).toHaveLength(1);
    });

    it('should support redacted export for privacy', async () => {
      await store.updatePhilosophy(user1, {
        values: [{ name: 'Quality', description: 'Quality first', priority: 9 }],
        beliefs: [
          {
            statement: 'Code should be readable',
            confidence: 0.9,
            domain: ['coding', 'company-internal'],
          },
        ],
        identity: { professionalTitle: 'Engineer' },
      });

      await store.addPrinciple(user1, {
        content: 'Use TypeScript for all new projects',
        domain: ['coding', 'org-standards'],
        weight: 0.9,
        evidence: [
          {
            decision: 'Migrated company codebase',
            context: 'Internal company project migration',
            timestamp: new Date().toISOString(),
          },
        ],
        status: 'active',
      });

      // Export with redaction
      const exported = await store.exportKnowledge(user1, 'redacted');

      expect(exported.level).toBe('redacted');
      // Org-specific domains should be filtered
      expect(exported.philosophy?.beliefs[0]?.domain).not.toContain('company-internal');
      // Context should be excluded
      expect(exported.context).toBeUndefined();
    });

    it('should track version history', async () => {
      // Create initial philosophy
      await store.updatePhilosophy(user1, {
        values: [{ name: 'Speed', description: 'Move fast', priority: 8 }],
        beliefs: [],
        identity: {},
      });

      // Update philosophy
      await store.updatePhilosophy(user1, {
        values: [{ name: 'Quality', description: 'Quality first', priority: 9 }],
        beliefs: [],
        identity: {},
      });

      // Check history
      const history = await store.getHistory(user1, 'philosophy');
      expect(Array.isArray(history)).toBe(true);
      expect((history as any[]).length).toBeGreaterThanOrEqual(1);

      // Revert to previous version
      await store.revertTo(user1, 'philosophy', 1);

      const philosophy = await store.getPhilosophy(user1);
      expect(philosophy.values[0]?.name).toBe('Speed');
    });

    it('should validate integrity', async () => {
      await store.updatePhilosophy(user1, {
        values: [
          { name: 'Value 1', description: 'Desc 1', priority: 9 },
          { name: 'Value 2', description: 'Desc 2', priority: 8 },
        ],
        beliefs: [],
        identity: {},
      });

      await store.addPrinciple(user1, {
        content: 'Test principle for integrity check',
        domain: ['test'],
        weight: 0.5,
      });

      const result = await store.validateIntegrity(user1);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect conflicting principles', async () => {
      await store.addPrinciple(user1, {
        content: 'Always use strict type checking in code',
        domain: ['typescript'],
        weight: 0.9,
        status: 'active',
      });

      await store.addPrinciple(user1, {
        content: 'Never use strict type checking for rapid prototypes',
        domain: ['typescript'],
        weight: 0.7,
        status: 'active',
      });

      const result = await store.detectCircularConflicts(user1);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('factory function', () => {
    it('should create store with default config', () => {
      const defaultStore = createKnowledgeStore();
      expect(defaultStore).toBeInstanceOf(Object);
      expect(typeof defaultStore.getPhilosophy).toBe('function');
    });

    it('should create store with custom config', () => {
      const customStore = createKnowledgeStore({
        baseDir: testDir,
        maxVersions: 100,
        enableAudit: true,
      });
      expect(customStore).toBeInstanceOf(Object);
    });
  });
});
