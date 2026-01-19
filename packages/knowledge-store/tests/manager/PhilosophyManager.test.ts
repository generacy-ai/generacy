import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorage } from '../../src/storage/LocalFileStorage.js';
import { VersionedStorage } from '../../src/storage/VersionedStorage.js';
import { PhilosophyManager } from '../../src/manager/PhilosophyManager.js';
import type { Philosophy } from '../../src/types/knowledge.js';

describe('PhilosophyManager', () => {
  let manager: PhilosophyManager;
  let storage: VersionedStorage;
  let testDir: string;
  const userId = 'test-user';

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-philosophy-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    const baseStorage = new LocalFileStorage(testDir);
    storage = new VersionedStorage(baseStorage);
    manager = new PhilosophyManager(storage);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('get', () => {
    it('should return default philosophy for new user', async () => {
      const philosophy = await manager.get(userId);
      expect(philosophy).toEqual({
        values: [],
        beliefs: [],
        identity: {},
      });
    });

    it('should return stored philosophy', async () => {
      const testPhilosophy: Philosophy = {
        values: [{ name: 'Quality', description: 'Quality over speed', priority: 9 }],
        beliefs: [],
        identity: { professionalTitle: 'Engineer' },
      };

      await storage.set(`${userId}/philosophy`, testPhilosophy);
      const philosophy = await manager.get(userId);
      expect(philosophy).toEqual(testPhilosophy);
    });
  });

  describe('update', () => {
    it('should update philosophy values', async () => {
      await manager.update(userId, {
        values: [{ name: 'Quality', description: 'Quality over speed', priority: 9 }],
      });

      const philosophy = await manager.get(userId);
      expect(philosophy.values).toHaveLength(1);
      expect(philosophy.values[0]?.name).toBe('Quality');
    });

    it('should merge identity updates', async () => {
      await manager.update(userId, {
        identity: { professionalTitle: 'Engineer' },
      });

      await manager.update(userId, {
        identity: { yearsExperience: 10 },
      });

      const philosophy = await manager.get(userId);
      expect(philosophy.identity.professionalTitle).toBe('Engineer');
      expect(philosophy.identity.yearsExperience).toBe(10);
    });

    it('should reject invalid philosophy', async () => {
      await expect(
        manager.update(userId, {
          values: [{ name: 'X', description: 'Test', priority: 5 }], // name too short
        })
      ).rejects.toThrow('Invalid philosophy');
    });
  });

  describe('versioning', () => {
    it('should create versions on update', async () => {
      await manager.update(userId, {
        values: [{ name: 'Value 1', description: 'First value', priority: 5 }],
      });

      await manager.update(userId, {
        values: [{ name: 'Value 2', description: 'Second value', priority: 5 }],
      });

      const history = await manager.getHistory(userId);
      expect(history).toHaveLength(1);

      const v1 = await manager.getVersion(userId, 1);
      expect(v1?.values[0]?.name).toBe('Value 1');
    });

    it('should revert to previous version', async () => {
      await manager.update(userId, {
        values: [{ name: 'Original', description: 'Original value', priority: 5 }],
      });

      await manager.update(userId, {
        values: [{ name: 'Changed', description: 'Changed value', priority: 5 }],
      });

      await manager.revertTo(userId, 1);

      const philosophy = await manager.get(userId);
      expect(philosophy.values[0]?.name).toBe('Original');
    });

    it('should throw when reverting to non-existent version', async () => {
      await expect(manager.revertTo(userId, 999)).rejects.toThrow('Version 999 not found');
    });
  });
});
