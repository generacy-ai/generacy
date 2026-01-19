import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorage } from '../../src/storage/LocalFileStorage.js';
import { VersionedStorage } from '../../src/storage/VersionedStorage.js';
import { PrincipleManager } from '../../src/manager/PrincipleManager.js';

describe('PrincipleManager', () => {
  let manager: PrincipleManager;
  let storage: VersionedStorage;
  let testDir: string;
  const userId = 'test-user';

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-principle-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const baseStorage = new LocalFileStorage(testDir);
    storage = new VersionedStorage(baseStorage);
    manager = new PrincipleManager(storage);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('should add a new principle', async () => {
      const id = await manager.add(userId, {
        content: 'Always write tests before implementation',
        domain: ['coding', 'testing'],
        weight: 0.9,
      });

      expect(id).toBeDefined();
      expect(id.length).toBe(36); // UUID length

      const principles = await manager.get(userId);
      expect(principles).toHaveLength(1);
      expect(principles[0]?.content).toBe('Always write tests before implementation');
    });

    it('should set default values', async () => {
      const id = await manager.add(userId, {
        content: 'A principle with defaults applied',
        domain: ['testing'],
      });

      const principle = await manager.getById(userId, id);
      expect(principle?.weight).toBe(0.5);
      expect(principle?.status).toBe('draft');
      expect(principle?.evidence).toEqual([]);
    });

    it('should reject invalid principle', async () => {
      await expect(
        manager.add(userId, {
          content: 'Short', // Too short
          domain: ['test'],
        })
      ).rejects.toThrow('Invalid principle');
    });
  });

  describe('get', () => {
    it('should return empty array for new user', async () => {
      const principles = await manager.get(userId);
      expect(principles).toEqual([]);
    });

    it('should filter by domain', async () => {
      await manager.add(userId, {
        content: 'Coding principle for TypeScript development',
        domain: ['coding', 'typescript'],
      });

      await manager.add(userId, {
        content: 'Design principle for user interfaces',
        domain: ['design', 'ui'],
      });

      const codingPrinciples = await manager.get(userId, ['coding']);
      expect(codingPrinciples).toHaveLength(1);
      expect(codingPrinciples[0]?.domain).toContain('coding');

      const designPrinciples = await manager.get(userId, ['design']);
      expect(designPrinciples).toHaveLength(1);

      const allMatching = await manager.get(userId, ['coding', 'design']);
      expect(allMatching).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('should update principle content', async () => {
      const id = await manager.add(userId, {
        content: 'Original principle content here',
        domain: ['test'],
      });

      await manager.update(userId, id, {
        content: 'Updated principle content here',
      });

      const principle = await manager.getById(userId, id);
      expect(principle?.content).toBe('Updated principle content here');
    });

    it('should update metadata timestamp', async () => {
      const id = await manager.add(userId, {
        content: 'Principle to be updated soon',
        domain: ['test'],
      });

      const before = await manager.getById(userId, id);
      const beforeUpdated = before?.metadata.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await manager.update(userId, id, { weight: 0.8 });

      const after = await manager.getById(userId, id);
      expect(after?.metadata.updatedAt).not.toBe(beforeUpdated);
    });

    it('should throw for non-existent principle', async () => {
      await expect(
        manager.update(userId, 'non-existent-id', { weight: 0.5 })
      ).rejects.toThrow('Principle not found');
    });
  });

  describe('deprecate', () => {
    it('should deprecate a principle', async () => {
      const id = await manager.add(userId, {
        content: 'Principle that will be deprecated',
        domain: ['test'],
        status: 'active',
      });

      await manager.deprecate(userId, id, 'No longer relevant');

      const principle = await manager.getById(userId, id);
      expect(principle?.status).toBe('deprecated');
      expect(principle?.metadata.deprecationReason).toBe('No longer relevant');
      expect(principle?.metadata.deprecatedAt).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete a principle', async () => {
      const id = await manager.add(userId, {
        content: 'Principle to be deleted permanently',
        domain: ['test'],
      });

      await manager.delete(userId, id);

      const principles = await manager.get(userId);
      expect(principles).toHaveLength(0);
    });

    it('should throw for non-existent principle', async () => {
      await expect(manager.delete(userId, 'non-existent')).rejects.toThrow(
        'Principle not found'
      );
    });
  });

  describe('getByStatus', () => {
    it('should filter by status', async () => {
      await manager.add(userId, {
        content: 'An active principle that is being used',
        domain: ['test'],
        status: 'active',
      });

      await manager.add(userId, {
        content: 'A draft principle still being refined',
        domain: ['test'],
        status: 'draft',
      });

      const active = await manager.getByStatus(userId, 'active');
      expect(active).toHaveLength(1);

      const draft = await manager.getByStatus(userId, 'draft');
      expect(draft).toHaveLength(1);
    });
  });

  describe('versioning', () => {
    it('should track principle history', async () => {
      await manager.add(userId, {
        content: 'First principle to be added here',
        domain: ['test'],
      });

      await manager.add(userId, {
        content: 'Second principle added afterwards',
        domain: ['test'],
      });

      const history = await manager.getHistory(userId);
      expect(history).toHaveLength(1);

      const v1 = await manager.getVersion(userId, 1);
      expect(v1).toHaveLength(1);
    });
  });
});
