import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CredentialFileStore } from '../file-store.js';
import type { EncryptedEntry } from '../crypto.js';

describe('CredentialFileStore', () => {
  let tmpDir: string;
  let dataPath: string;
  let keyPath: string;
  let store: CredentialFileStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credfile-test-'));
    dataPath = path.join(tmpDir, 'credentials.dat');
    keyPath = path.join(tmpDir, 'master.key');
    store = new CredentialFileStore(dataPath, keyPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('auto-generates master key on first call', async () => {
    const key = await store.ensureMasterKey();
    expect(key.length).toBe(32);
    // Key file should exist now
    const onDisk = await fs.readFile(keyPath);
    expect(onDisk.equals(key)).toBe(true);
  });

  it('returns same master key on subsequent calls', async () => {
    const first = await store.ensureMasterKey();
    const second = await store.ensureMasterKey();
    expect(first.equals(second)).toBe(true);
  });

  it('load returns empty map when file does not exist', async () => {
    const entries = await store.load();
    expect(entries.size).toBe(0);
  });

  it('save and load round-trips entries', async () => {
    const entry: EncryptedEntry = {
      ciphertext: 'Y2lwaGVy',
      iv: 'aXY=',
      authTag: 'dGFn',
    };
    const entries = new Map<string, EncryptedEntry>();
    entries.set('test-key', entry);

    await store.save(entries);
    const loaded = await store.load();
    expect(loaded.size).toBe(1);
    expect(loaded.get('test-key')).toEqual(entry);
  });

  it('rejects corrupt JSON', async () => {
    await fs.writeFile(dataPath, 'not json');
    await expect(store.load()).rejects.toThrow('invalid JSON');
  });

  it('rejects invalid schema', async () => {
    await fs.writeFile(dataPath, JSON.stringify({ bad: 'data' }));
    await expect(store.load()).rejects.toThrow('failed validation');
  });

  it('rejects unsupported version', async () => {
    await fs.writeFile(dataPath, JSON.stringify({ version: 99, entries: {} }));
    await expect(store.load()).rejects.toThrow('not supported');
  });
});
