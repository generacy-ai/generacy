import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorage } from '../../src/storage/LocalFileStorage.js';

describe('LocalFileStorage', () => {
  let storage: LocalFileStorage;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    storage = new LocalFileStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('get/set', () => {
    it('should store and retrieve a value', async () => {
      const data = { name: 'test', value: 123 };
      await storage.set('test-key', data);
      const result = await storage.get('test-key');
      expect(result).toEqual(data);
    });

    it('should return null for non-existent key', async () => {
      const result = await storage.get('non-existent');
      expect(result).toBeNull();
    });

    it('should overwrite existing value', async () => {
      await storage.set('key', { value: 1 });
      await storage.set('key', { value: 2 });
      const result = await storage.get<{ value: number }>('key');
      expect(result?.value).toBe(2);
    });

    it('should handle complex nested objects', async () => {
      const data = {
        name: 'test',
        nested: {
          array: [1, 2, 3],
          object: { a: 'b' },
        },
        date: '2024-01-15T10:00:00.000Z',
      };
      await storage.set('complex', data);
      const result = await storage.get('complex');
      expect(result).toEqual(data);
    });

    it('should handle keys with slashes', async () => {
      const data = { value: 'nested' };
      await storage.set('user/123/settings', data);
      const result = await storage.get('user/123/settings');
      expect(result).toEqual(data);
    });
  });

  describe('delete', () => {
    it('should delete an existing key', async () => {
      await storage.set('to-delete', { value: 1 });
      await storage.delete('to-delete');
      const result = await storage.get('to-delete');
      expect(result).toBeNull();
    });

    it('should not throw when deleting non-existent key', async () => {
      await expect(storage.delete('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('exists', () => {
    it('should return true for existing key', async () => {
      await storage.set('exists', { value: 1 });
      const result = await storage.exists('exists');
      expect(result).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      const result = await storage.exists('not-exists');
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('should list keys with prefix', async () => {
      await storage.set('user-1', { id: 1 });
      await storage.set('user-2', { id: 2 });
      await storage.set('other', { id: 3 });

      const result = await storage.list('user');
      expect(result).toHaveLength(2);
      expect(result).toContain('user-1');
      expect(result).toContain('user-2');
    });

    it('should return empty array for non-matching prefix', async () => {
      await storage.set('key1', { value: 1 });
      const result = await storage.list('nonexistent');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-existent directory', async () => {
      const result = await storage.list('subdir/prefix');
      expect(result).toEqual([]);
    });
  });

  describe('versioning', () => {
    it('should create and retrieve versions', async () => {
      await storage.set('versioned', { version: 1 });
      const v1 = await storage.createVersion('versioned');
      expect(v1).toBe(1);

      await storage.set('versioned', { version: 2 });
      const v2 = await storage.createVersion('versioned');
      expect(v2).toBe(2);

      const version1 = await storage.getVersion('versioned', 1);
      expect(version1).toEqual({ version: 1 });

      const version2 = await storage.getVersion('versioned', 2);
      expect(version2).toEqual({ version: 2 });
    });

    it('should list versions', async () => {
      await storage.set('multi-version', { v: 1 });
      await storage.createVersion('multi-version');
      await storage.set('multi-version', { v: 2 });
      await storage.createVersion('multi-version');
      await storage.set('multi-version', { v: 3 });
      await storage.createVersion('multi-version');

      const versions = await storage.listVersions('multi-version');
      expect(versions).toHaveLength(3);
      expect(versions[0]?.version).toBe(1);
      expect(versions[1]?.version).toBe(2);
      expect(versions[2]?.version).toBe(3);
    });

    it('should return null for non-existent version', async () => {
      await storage.set('versioned', { value: 1 });
      const result = await storage.getVersion('versioned', 999);
      expect(result).toBeNull();
    });

    it('should return empty array when no versions exist', async () => {
      const result = await storage.listVersions('no-versions');
      expect(result).toEqual([]);
    });

    it('should throw when creating version for non-existent key', async () => {
      await expect(storage.createVersion('non-existent')).rejects.toThrow();
    });
  });

  describe('atomic writes', () => {
    it('should write atomically', async () => {
      // Write data
      await storage.set('atomic', { value: 'data' });

      // Verify the file exists and contains valid JSON
      const filePath = join(testDir, 'atomic.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({ value: 'data' });
    });

    it('should not leave temp files on successful write', async () => {
      await storage.set('clean', { value: 1 });

      const files = await fs.readdir(testDir);
      const tempFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tempFiles).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should handle invalid JSON gracefully', async () => {
      // Manually write invalid JSON
      const filePath = join(testDir, 'invalid.json');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(filePath, 'not valid json', 'utf-8');

      await expect(storage.get('invalid')).rejects.toThrow();
    });
  });
});
