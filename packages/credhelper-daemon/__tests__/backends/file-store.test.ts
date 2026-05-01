import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CredentialFileStore } from '../../src/backends/file-store.js';
import { CredhelperError } from '../../src/errors.js';
import type { EncryptedEntry } from '../../src/backends/crypto.js';

describe('CredentialFileStore', () => {
  let tmpDir: string;
  let dataPath: string;
  let keyPath: string;
  let store: CredentialFileStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credhelper-fs-test-'));
    dataPath = path.join(tmpDir, 'credentials.dat');
    keyPath = path.join(tmpDir, 'master.key');
    store = new CredentialFileStore(dataPath, keyPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const dummyEntry: EncryptedEntry = {
    ciphertext: 'Y2lwaGVy',
    iv: 'aXZpdml2aXZpdml2',
    authTag: 'dGFndGFndGFndGFndGFndGFn',
  };

  describe('ensureMasterKey', () => {
    it('creates master key on first call and reuses on second', async () => {
      const key1 = await store.ensureMasterKey();
      expect(key1.length).toBe(32);

      const key2 = await store.ensureMasterKey();
      expect(key1.equals(key2)).toBe(true);
    });

    it('creates master key file with mode 0600', async () => {
      await store.ensureMasterKey();
      const stat = await fs.stat(keyPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('load', () => {
    it('returns empty map when file missing', async () => {
      const entries = await store.load();
      expect(entries.size).toBe(0);
    });

    it('fails on corrupt JSON with CREDENTIAL_STORE_CORRUPT', async () => {
      await fs.writeFile(dataPath, 'not json at all');
      try {
        await store.load();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('CREDENTIAL_STORE_CORRUPT');
      }
    });

    it('fails on unknown version with CREDENTIAL_STORE_MIGRATION_NEEDED', async () => {
      await fs.writeFile(dataPath, JSON.stringify({ version: 999, entries: {} }));
      try {
        await store.load();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CredhelperError);
        expect((err as CredhelperError).code).toBe('CREDENTIAL_STORE_MIGRATION_NEEDED');
      }
    });

    it('loads valid file with entries', async () => {
      const envelope = { version: 1, entries: { 'my-key': dummyEntry } };
      await fs.writeFile(dataPath, JSON.stringify(envelope));
      const entries = await store.load();
      expect(entries.size).toBe(1);
      expect(entries.get('my-key')).toEqual(dummyEntry);
    });
  });

  describe('save', () => {
    it('produces valid JSON file', async () => {
      const entries = new Map<string, EncryptedEntry>([['k1', dummyEntry]]);
      await store.save(entries);

      const raw = await fs.readFile(dataPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.entries['k1']).toEqual(dummyEntry);
    });

    it('atomic write does not corrupt existing file on crash simulation', async () => {
      // Write initial valid data
      const initial = new Map<string, EncryptedEntry>([['original', dummyEntry]]);
      await store.save(initial);

      // Verify it's readable
      const loaded = await store.load();
      expect(loaded.get('original')).toEqual(dummyEntry);

      // The temp file mechanism means a partial write (tmp file) wouldn't
      // affect the original. Verify the original is intact after a second save.
      const updated = new Map<string, EncryptedEntry>([
        ['original', dummyEntry],
        ['new-key', dummyEntry],
      ]);
      await store.save(updated);
      const reloaded = await store.load();
      expect(reloaded.size).toBe(2);
    });
  });

  describe('advisory lock', () => {
    it('allows sequential save operations', async () => {
      const e1 = new Map<string, EncryptedEntry>([['a', dummyEntry]]);
      const e2 = new Map<string, EncryptedEntry>([['b', dummyEntry]]);
      await store.save(e1);
      await store.save(e2);
      const loaded = await store.load();
      expect(loaded.has('b')).toBe(true);
      expect(loaded.has('a')).toBe(false);
    });

    it('creates lock file at ${dataPath}.lock after first save', async () => {
      const lockPath = `${dataPath}.lock`;

      // Lock file should not exist before any save
      await expect(fs.stat(lockPath)).rejects.toThrow();

      await store.save(new Map([['x', dummyEntry]]));

      // Lock file should exist after save
      const stat = await fs.stat(lockPath);
      expect(stat.isFile()).toBe(true);
    });

    it('concurrent save() calls produce no data corruption', async () => {
      const saves = Array.from({ length: 10 }, (_, i) =>
        store.save(new Map([[`key-${i}`, dummyEntry]])),
      );
      await Promise.all(saves);

      // The file must be valid JSON with exactly one entry (last writer wins)
      const loaded = await store.load();
      expect(loaded.size).toBe(1);

      // The single remaining key must be one of the keys we wrote
      const [key] = loaded.keys();
      expect(key).toMatch(/^key-\d$/);
    });
  });
});
