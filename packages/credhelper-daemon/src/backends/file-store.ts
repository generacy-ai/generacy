import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { EncryptedEntrySchema, generateMasterKey } from './crypto.js';
import type { EncryptedEntry } from './crypto.js';
import { CredhelperError } from '../errors.js';

const CURRENT_VERSION = 1;

export const CredentialFileEnvelopeSchema = z.object({
  version: z.number().int().positive(),
  entries: z.record(z.string(), EncryptedEntrySchema),
});

export interface CredentialFileEnvelope {
  version: number;
  entries: Record<string, EncryptedEntry>;
}

export class CredentialFileStore {
  private readonly lockPath: string;

  constructor(
    private readonly dataPath: string,
    private readonly keyPath: string,
  ) {
    this.lockPath = `${dataPath}.lock`;
  }

  async ensureMasterKey(): Promise<Buffer> {
    try {
      const key = await fs.readFile(this.keyPath);
      if (key.length !== 32) {
        throw new CredhelperError(
          'CREDENTIAL_STORE_CORRUPT',
          `Master key file has invalid length: ${key.length} (expected 32)`,
        );
      }
      return key;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const key = generateMasterKey();
        await fs.writeFile(this.keyPath, key, { mode: 0o600 });
        return key;
      }
      throw err;
    }
  }

  async load(): Promise<Map<string, EncryptedEntry>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.dataPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredhelperError(
        'CREDENTIAL_STORE_CORRUPT',
        'Credential file contains invalid JSON',
      );
    }

    const result = CredentialFileEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      throw new CredhelperError(
        'CREDENTIAL_STORE_CORRUPT',
        `Credential file failed validation: ${result.error.message}`,
      );
    }

    if (result.data.version !== CURRENT_VERSION) {
      throw new CredhelperError(
        'CREDENTIAL_STORE_MIGRATION_NEEDED',
        `Credential file version ${result.data.version} is not supported (expected ${CURRENT_VERSION})`,
      );
    }

    return new Map(Object.entries(result.data.entries));
  }

  async save(entries: Map<string, EncryptedEntry>): Promise<void> {
    const envelope: CredentialFileEnvelope = {
      version: CURRENT_VERSION,
      entries: Object.fromEntries(entries),
    };
    const data = JSON.stringify(envelope, null, 2);

    await this.withLock(async () => {
      const tmpPath = `${this.dataPath}.tmp.${process.pid}`;
      await fs.writeFile(tmpPath, data, { mode: 0o600 });
      const fh = await fs.open(tmpPath, 'r');
      await fh.datasync();
      await fh.close();
      await fs.rename(tmpPath, this.dataPath);
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const fd = openSync(this.lockPath, 'w');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', fd],
        });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`flock exited with code ${code}`));
        });
        child.on('error', reject);
      });
      return await fn();
    } finally {
      closeSync(fd);
    }
  }
}
