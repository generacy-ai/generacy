import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorage } from '../../src/storage/LocalFileStorage.js';
import { ContextManager } from '../../src/manager/ContextManager.js';

describe('ContextManager', () => {
  let manager: ContextManager;
  let testDir: string;
  const userId = 'test-user';

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-context-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const storage = new LocalFileStorage(testDir);
    manager = new ContextManager(storage);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('get', () => {
    it('should return default context for new user', async () => {
      const context = await manager.get(userId);
      expect(context).toEqual({
        recentDecisions: [],
        activeGoals: [],
        preferences: { verbosity: 'normal' },
      });
    });
  });

  describe('update', () => {
    it('should update context', async () => {
      await manager.update(userId, {
        activeGoals: ['Complete MVP', 'Write docs'],
      });

      const context = await manager.get(userId);
      expect(context.activeGoals).toEqual(['Complete MVP', 'Write docs']);
    });

    it('should merge preferences', async () => {
      await manager.update(userId, {
        preferences: { verbosity: 'detailed' },
      });

      await manager.update(userId, {
        preferences: { codeStyle: 'functional' },
      });

      const context = await manager.get(userId);
      expect(context.preferences.verbosity).toBe('detailed');
      expect(context.preferences.codeStyle).toBe('functional');
    });
  });

  describe('setCurrentProject', () => {
    it('should set current project', async () => {
      await manager.setCurrentProject(userId, {
        name: 'Knowledge Store',
        type: 'library',
        technologies: ['TypeScript', 'Node.js'],
      });

      const context = await manager.get(userId);
      expect(context.currentProject?.name).toBe('Knowledge Store');
    });

    it('should clear current project', async () => {
      await manager.setCurrentProject(userId, {
        name: 'Test',
        type: 'app',
        technologies: [],
      });

      await manager.setCurrentProject(userId, undefined);

      const context = await manager.get(userId);
      expect(context.currentProject).toBeUndefined();
    });
  });

  describe('addRecentDecision', () => {
    it('should add a decision', async () => {
      await manager.addRecentDecision(userId, {
        summary: 'Chose TypeScript over JavaScript',
        principlesApplied: ['principle-1'],
      });

      const context = await manager.get(userId);
      expect(context.recentDecisions).toHaveLength(1);
      expect(context.recentDecisions[0]?.summary).toBe('Chose TypeScript over JavaScript');
      expect(context.recentDecisions[0]?.timestamp).toBeDefined();
    });

    it('should prepend decisions (newest first)', async () => {
      await manager.addRecentDecision(userId, {
        summary: 'First decision made',
        principlesApplied: [],
      });

      await manager.addRecentDecision(userId, {
        summary: 'Second decision made',
        principlesApplied: [],
      });

      const context = await manager.get(userId);
      expect(context.recentDecisions[0]?.summary).toBe('Second decision made');
      expect(context.recentDecisions[1]?.summary).toBe('First decision made');
    });

    it('should limit to 50 decisions', async () => {
      for (let i = 0; i < 60; i++) {
        await manager.addRecentDecision(userId, {
          summary: `Decision ${i}`,
          principlesApplied: [],
        });
      }

      const context = await manager.get(userId);
      expect(context.recentDecisions).toHaveLength(50);
      expect(context.recentDecisions[0]?.summary).toBe('Decision 59');
    });
  });

  describe('goals management', () => {
    it('should set active goals', async () => {
      await manager.setActiveGoals(userId, ['Goal 1', 'Goal 2']);

      const context = await manager.get(userId);
      expect(context.activeGoals).toEqual(['Goal 1', 'Goal 2']);
    });

    it('should add active goal', async () => {
      await manager.addActiveGoal(userId, 'New Goal');

      const context = await manager.get(userId);
      expect(context.activeGoals).toContain('New Goal');
    });

    it('should not add duplicate goal', async () => {
      await manager.addActiveGoal(userId, 'Goal');
      await manager.addActiveGoal(userId, 'Goal');

      const context = await manager.get(userId);
      expect(context.activeGoals.filter((g) => g === 'Goal')).toHaveLength(1);
    });

    it('should remove active goal', async () => {
      await manager.setActiveGoals(userId, ['Goal 1', 'Goal 2']);
      await manager.removeActiveGoal(userId, 'Goal 1');

      const context = await manager.get(userId);
      expect(context.activeGoals).toEqual(['Goal 2']);
    });
  });

  describe('updatePreferences', () => {
    it('should update preferences', async () => {
      await manager.updatePreferences(userId, {
        verbosity: 'minimal',
        codeStyle: 'oop',
      });

      const context = await manager.get(userId);
      expect(context.preferences.verbosity).toBe('minimal');
      expect(context.preferences.codeStyle).toBe('oop');
    });
  });

  describe('clear', () => {
    it('should reset context to defaults', async () => {
      await manager.update(userId, {
        activeGoals: ['Goal 1'],
        currentProject: { name: 'Test', type: 'app', technologies: [] },
      });

      await manager.clear(userId);

      const context = await manager.get(userId);
      expect(context.activeGoals).toEqual([]);
      expect(context.currentProject).toBeUndefined();
    });
  });
});
