import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorage } from '../../src/storage/LocalFileStorage.js';
import { VersionedStorage } from '../../src/storage/VersionedStorage.js';
import { PatternManager } from '../../src/manager/PatternManager.js';
import { PrincipleManager } from '../../src/manager/PrincipleManager.js';

describe('PatternManager', () => {
  let manager: PatternManager;
  let principleManager: PrincipleManager;
  let storage: VersionedStorage;
  let testDir: string;
  const userId = 'test-user';

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-pattern-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const baseStorage = new LocalFileStorage(testDir);
    storage = new VersionedStorage(baseStorage);
    manager = new PatternManager(storage);
    principleManager = new PrincipleManager(storage);
    manager.setPrincipleManager(principleManager);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('should add a new pattern', async () => {
      const id = await manager.add(userId, {
        description: 'Using composition over inheritance in components',
        domain: ['react', 'design'],
      });

      expect(id).toBeDefined();

      const patterns = await manager.get(userId);
      expect(patterns).toHaveLength(1);
      expect(patterns[0]?.description).toBe('Using composition over inheritance in components');
      expect(patterns[0]?.status).toBe('emerging');
    });

    it('should reject invalid pattern', async () => {
      await expect(
        manager.add(userId, {
          description: 'Short', // Too short
          domain: ['test'],
        })
      ).rejects.toThrow('Invalid pattern');
    });
  });

  describe('get', () => {
    it('should return empty array for new user', async () => {
      const patterns = await manager.get(userId);
      expect(patterns).toEqual([]);
    });

    it('should filter by status', async () => {
      await manager.add(userId, {
        description: 'An emerging pattern being observed',
        domain: ['test'],
      });

      const id2 = await manager.add(userId, {
        description: 'Another pattern to be established',
        domain: ['test'],
      });

      await manager.update(userId, id2, { status: 'established' });

      const emerging = await manager.get(userId, 'emerging');
      expect(emerging).toHaveLength(1);

      const established = await manager.get(userId, 'established');
      expect(established).toHaveLength(1);
    });
  });

  describe('addOccurrence', () => {
    it('should add an occurrence to a pattern', async () => {
      const id = await manager.add(userId, {
        description: 'Pattern with multiple occurrences tracked',
        domain: ['test'],
      });

      await manager.addOccurrence(userId, id, {
        context: 'Building a new feature',
        decision: 'Used the pattern successfully',
      });

      const pattern = await manager.getById(userId, id);
      expect(pattern?.occurrences).toHaveLength(1);
      expect(pattern?.occurrences[0]?.context).toBe('Building a new feature');
    });

    it('should auto-promote to established after 3 occurrences', async () => {
      const id = await manager.add(userId, {
        description: 'Pattern that will become established',
        domain: ['test'],
      });

      await manager.addOccurrence(userId, id, {
        context: 'First occurrence context',
        decision: 'Decision 1',
      });

      await manager.addOccurrence(userId, id, {
        context: 'Second occurrence context',
        decision: 'Decision 2',
      });

      await manager.addOccurrence(userId, id, {
        context: 'Third occurrence context',
        decision: 'Decision 3',
      });

      const pattern = await manager.getById(userId, id);
      expect(pattern?.status).toBe('established');
    });
  });

  describe('promoteToAnciple', () => {
    it('should promote pattern to principle', async () => {
      const patternId = await manager.add(userId, {
        description: 'Pattern to be promoted to principle',
        domain: ['test', 'design'],
        occurrences: [
          { context: 'Context 1', timestamp: new Date().toISOString(), decision: 'Decision 1' },
          { context: 'Context 2', timestamp: new Date().toISOString(), decision: 'Decision 2' },
        ],
      });

      const principleId = await manager.promoteToAnciple(userId, patternId);

      expect(principleId).toBeDefined();

      // Check pattern is marked as promoted
      const pattern = await manager.getById(userId, patternId);
      expect(pattern?.status).toBe('promoted');
      expect(pattern?.promotedTo).toBe(principleId);

      // Check principle was created
      const principle = await principleManager.getById(userId, principleId);
      expect(principle?.content).toBe('Pattern to be promoted to principle');
      expect(principle?.evidence).toHaveLength(2);
    });

    it('should throw if pattern already promoted', async () => {
      const id = await manager.add(userId, {
        description: 'Pattern that gets promoted once only',
        domain: ['test'],
      });

      await manager.promoteToAnciple(userId, id);

      await expect(manager.promoteToAnciple(userId, id)).rejects.toThrow(
        'Pattern already promoted'
      );
    });

    it('should throw if principle manager not set', async () => {
      const isolatedManager = new PatternManager(storage);
      const id = await isolatedManager.add(userId, {
        description: 'Pattern without principle manager set',
        domain: ['test'],
      });

      await expect(isolatedManager.promoteToAnciple(userId, id)).rejects.toThrow(
        'PrincipleManager not set'
      );
    });
  });

  describe('reject', () => {
    it('should reject a pattern', async () => {
      const id = await manager.add(userId, {
        description: 'Pattern that will be rejected',
        domain: ['test'],
      });

      await manager.reject(userId, id);

      const pattern = await manager.getById(userId, id);
      expect(pattern?.status).toBe('rejected');
    });
  });

  describe('delete', () => {
    it('should delete a pattern', async () => {
      const id = await manager.add(userId, {
        description: 'Pattern to be deleted permanently',
        domain: ['test'],
      });

      await manager.delete(userId, id);

      const patterns = await manager.get(userId);
      expect(patterns).toHaveLength(0);
    });

    it('should throw for non-existent pattern', async () => {
      await expect(manager.delete(userId, 'non-existent')).rejects.toThrow(
        'Pattern not found'
      );
    });
  });
});
