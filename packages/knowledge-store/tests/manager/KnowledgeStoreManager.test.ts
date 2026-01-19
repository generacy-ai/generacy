import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStoreManager } from '../../src/manager/KnowledgeStoreManager.js';

describe('KnowledgeStoreManager', () => {
  let manager: KnowledgeStoreManager;
  let testDir: string;
  const userId = 'test-user';

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-manager-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new KnowledgeStoreManager({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('getKnowledge', () => {
    it('should return complete knowledge for a user', async () => {
      const knowledge = await manager.getKnowledge(userId);

      expect(knowledge.userId).toBe(userId);
      expect(knowledge.philosophy).toBeDefined();
      expect(knowledge.principles).toEqual([]);
      expect(knowledge.patterns).toEqual([]);
      expect(knowledge.context).toBeDefined();
      expect(knowledge.metadata).toBeDefined();
    });

    it('should include all stored data', async () => {
      await manager.updatePhilosophy(userId, {
        values: [{ name: 'Quality', description: 'Quality matters', priority: 9 }],
      });

      await manager.addPrinciple(userId, {
        content: 'Always test your code before deployment',
        domain: ['testing'],
      });

      await manager.addPattern(userId, {
        description: 'Using composition over inheritance pattern',
        domain: ['design'],
      });

      const knowledge = await manager.getKnowledge(userId);

      expect(knowledge.philosophy.values).toHaveLength(1);
      expect(knowledge.principles).toHaveLength(1);
      expect(knowledge.patterns).toHaveLength(1);
    });
  });

  describe('philosophy operations', () => {
    it('should get and update philosophy', async () => {
      await manager.updatePhilosophy(userId, {
        values: [{ name: 'Speed', description: 'Move fast', priority: 8 }],
      });

      const philosophy = await manager.getPhilosophy(userId);
      expect(philosophy.values[0]?.name).toBe('Speed');
    });
  });

  describe('principle operations', () => {
    it('should add and get principles', async () => {
      const id = await manager.addPrinciple(userId, {
        content: 'Code should be readable and maintainable',
        domain: ['coding', 'quality'],
        weight: 0.8,
      });

      const principles = await manager.getPrinciples(userId);
      expect(principles).toHaveLength(1);
      expect(principles[0]?.id).toBe(id);
    });

    it('should filter principles by domain', async () => {
      await manager.addPrinciple(userId, {
        content: 'Test everything before shipping to production',
        domain: ['testing'],
      });

      await manager.addPrinciple(userId, {
        content: 'Design with the user in mind always',
        domain: ['design'],
      });

      const testingPrinciples = await manager.getPrinciples(userId, ['testing']);
      expect(testingPrinciples).toHaveLength(1);
    });

    it('should update and deprecate principles', async () => {
      const id = await manager.addPrinciple(userId, {
        content: 'Original principle content to be updated',
        domain: ['test'],
      });

      await manager.updatePrinciple(userId, id, {
        content: 'Updated principle content with changes',
      });

      let principles = await manager.getPrinciples(userId);
      expect(principles[0]?.content).toBe('Updated principle content with changes');

      await manager.deprecatePrinciple(userId, id, 'No longer relevant');

      principles = await manager.getPrinciples(userId);
      expect(principles[0]?.status).toBe('deprecated');
    });
  });

  describe('pattern operations', () => {
    it('should add and get patterns', async () => {
      const id = await manager.addPattern(userId, {
        description: 'Observed pattern of using functional components',
        domain: ['react'],
      });

      const patterns = await manager.getPatterns(userId);
      expect(patterns).toHaveLength(1);
      expect(patterns[0]?.id).toBe(id);
    });

    it('should filter patterns by status', async () => {
      await manager.addPattern(userId, {
        description: 'Emerging pattern that is being observed',
        domain: ['test'],
      });

      const emerging = await manager.getPatterns(userId, 'emerging');
      expect(emerging).toHaveLength(1);

      const established = await manager.getPatterns(userId, 'established');
      expect(established).toHaveLength(0);
    });

    it('should promote pattern to principle', async () => {
      const patternId = await manager.addPattern(userId, {
        description: 'Pattern ready to become a principle now',
        domain: ['design'],
      });

      const principleId = await manager.promoteToAnciple(userId, patternId);

      const patterns = await manager.getPatterns(userId);
      expect(patterns[0]?.status).toBe('promoted');
      expect(patterns[0]?.promotedTo).toBe(principleId);

      const principles = await manager.getPrinciples(userId);
      expect(principles).toHaveLength(1);
      expect(principles[0]?.id).toBe(principleId);
    });
  });

  describe('context operations', () => {
    it('should get and update context', async () => {
      await manager.updateContext(userId, {
        activeGoals: ['Complete feature', 'Write tests'],
      });

      const context = await manager.getContext(userId);
      expect(context.activeGoals).toEqual(['Complete feature', 'Write tests']);
    });
  });

  describe('versioning', () => {
    it('should get philosophy history', async () => {
      await manager.updatePhilosophy(userId, {
        values: [{ name: 'V1', description: 'First version', priority: 5 }],
      });

      await manager.updatePhilosophy(userId, {
        values: [{ name: 'V2', description: 'Second version', priority: 5 }],
      });

      const history = await manager.getHistory(userId, 'philosophy');
      expect(Array.isArray(history)).toBe(true);
      expect((history as any[]).length).toBeGreaterThanOrEqual(1);
    });

    it('should get all histories', async () => {
      await manager.updatePhilosophy(userId, {
        values: [{ name: 'Test', description: 'Test value', priority: 5 }],
      });

      const history = await manager.getHistory(userId);
      expect(typeof history).toBe('object');
      expect('philosophy' in (history as object)).toBe(true);
      expect('principles' in (history as object)).toBe(true);
    });

    it('should revert philosophy to previous version', async () => {
      await manager.updatePhilosophy(userId, {
        values: [{ name: 'Original', description: 'Original value', priority: 5 }],
      });

      await manager.updatePhilosophy(userId, {
        values: [{ name: 'Changed', description: 'Changed value', priority: 5 }],
      });

      await manager.revertTo(userId, 'philosophy', 1);

      const philosophy = await manager.getPhilosophy(userId);
      expect(philosophy.values[0]?.name).toBe('Original');
    });
  });

  describe('internal access', () => {
    it('should expose storage for testing', () => {
      const storage = manager.getStorage();
      expect(storage).toBeDefined();
    });

    it('should expose individual managers', () => {
      const managers = manager.getManagers();
      expect(managers.philosophy).toBeDefined();
      expect(managers.principles).toBeDefined();
      expect(managers.patterns).toBeDefined();
      expect(managers.context).toBeDefined();
    });
  });
});
