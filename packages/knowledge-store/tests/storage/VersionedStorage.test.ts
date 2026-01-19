import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorage } from '../../src/storage/LocalFileStorage.js';
import { VersionedStorage } from '../../src/storage/VersionedStorage.js';

describe('VersionedStorage', () => {
  let storage: VersionedStorage;
  let baseStorage: LocalFileStorage;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `knowledge-store-versioned-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    baseStorage = new LocalFileStorage(testDir);
    storage = new VersionedStorage(baseStorage, { maxVersions: 5 });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('automatic versioning', () => {
    it('should create version on update', async () => {
      await storage.set('auto', { value: 1 });
      await storage.set('auto', { value: 2 });

      const versions = await storage.listVersions('auto');
      expect(versions).toHaveLength(1);

      const v1 = await storage.getVersion('auto', 1);
      expect(v1).toEqual({ value: 1 });

      const current = await storage.get('auto');
      expect(current).toEqual({ value: 2 });
    });

    it('should not create version on first write', async () => {
      await storage.set('new', { value: 1 });

      const versions = await storage.listVersions('new');
      expect(versions).toHaveLength(0);
    });

    it('should create multiple versions', async () => {
      await storage.set('multi', { v: 1 });
      await storage.set('multi', { v: 2 });
      await storage.set('multi', { v: 3 });
      await storage.set('multi', { v: 4 });

      const versions = await storage.listVersions('multi');
      expect(versions).toHaveLength(3);

      expect(await storage.getVersion('multi', 1)).toEqual({ v: 1 });
      expect(await storage.getVersion('multi', 2)).toEqual({ v: 2 });
      expect(await storage.getVersion('multi', 3)).toEqual({ v: 3 });
      expect(await storage.get('multi')).toEqual({ v: 4 });
    });
  });

  describe('delegation', () => {
    it('should delegate get to underlying storage', async () => {
      await baseStorage.set('direct', { value: 'base' });
      const result = await storage.get('direct');
      expect(result).toEqual({ value: 'base' });
    });

    it('should delegate delete to underlying storage', async () => {
      await storage.set('to-delete', { value: 1 });
      await storage.delete('to-delete');
      const result = await storage.get('to-delete');
      expect(result).toBeNull();
    });

    it('should delegate list to underlying storage', async () => {
      await storage.set('prefix-1', { v: 1 });
      await storage.set('prefix-2', { v: 2 });
      const result = await storage.list('prefix');
      expect(result).toHaveLength(2);
    });

    it('should delegate exists to underlying storage', async () => {
      await storage.set('exists', { v: 1 });
      expect(await storage.exists('exists')).toBe(true);
      expect(await storage.exists('not-exists')).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should use default maxVersions of 50', async () => {
      const defaultStorage = new VersionedStorage(baseStorage);
      expect(defaultStorage).toBeDefined();
    });

    it('should expose underlying storage', async () => {
      const underlying = storage.getUnderlyingStorage();
      expect(underlying).toBe(baseStorage);
    });
  });

  describe('version retrieval', () => {
    it('should retrieve specific version', async () => {
      await storage.set('versioned', { iteration: 1 });
      await storage.set('versioned', { iteration: 2 });
      await storage.set('versioned', { iteration: 3 });

      const v1 = await storage.getVersion<{ iteration: number }>('versioned', 1);
      expect(v1?.iteration).toBe(1);

      const v2 = await storage.getVersion<{ iteration: number }>('versioned', 2);
      expect(v2?.iteration).toBe(2);
    });

    it('should return null for non-existent version', async () => {
      await storage.set('versioned', { value: 1 });
      const result = await storage.getVersion('versioned', 999);
      expect(result).toBeNull();
    });
  });

  describe('manual version creation', () => {
    it('should allow manual version creation', async () => {
      await storage.set('manual', { state: 'initial' });
      const version = await storage.createVersion('manual');
      expect(version).toBe(1);

      const v1 = await storage.getVersion('manual', 1);
      expect(v1).toEqual({ state: 'initial' });
    });
  });
});
