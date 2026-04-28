import type { WritableBackendClient } from './types.js';
import type { EncryptedEntry } from './crypto.js';
import { encrypt, decrypt } from './crypto.js';
import { CredentialFileStore } from './file-store.js';
import { CredhelperError } from '../errors.js';

export interface ClusterLocalBackendOptions {
  dataPath?: string;
  keyPath?: string;
}

const DEFAULT_DATA_PATH = '/var/lib/generacy/credentials.dat';
const DEFAULT_KEY_PATH = '/var/lib/generacy/master.key';

export class ClusterLocalBackend implements WritableBackendClient {
  private masterKey!: Buffer;
  private cache = new Map<string, EncryptedEntry>();
  private readonly fileStore: CredentialFileStore;

  constructor(options: ClusterLocalBackendOptions = {}) {
    const dataPath = options.dataPath ?? DEFAULT_DATA_PATH;
    const keyPath = options.keyPath ?? DEFAULT_KEY_PATH;
    this.fileStore = new CredentialFileStore(dataPath, keyPath);
  }

  async init(): Promise<void> {
    this.masterKey = await this.fileStore.ensureMasterKey();
    this.cache = await this.fileStore.load();
  }

  async fetchSecret(key: string): Promise<string> {
    const entry = this.cache.get(key);
    if (!entry) {
      throw new CredhelperError(
        'BACKEND_SECRET_NOT_FOUND',
        `Credential '${key}' not found in cluster-local store`,
        { backendType: 'cluster-local', key },
      );
    }
    return decrypt(entry, this.masterKey);
  }

  async setSecret(key: string, value: string): Promise<void> {
    const entry = encrypt(value, this.masterKey);
    this.cache.set(key, entry);
    await this.fileStore.save(this.cache);
  }

  async deleteSecret(key: string): Promise<void> {
    if (!this.cache.has(key)) {
      throw new CredhelperError(
        'BACKEND_SECRET_NOT_FOUND',
        `Credential '${key}' not found in cluster-local store`,
        { backendType: 'cluster-local', key },
      );
    }
    this.cache.delete(key);
    await this.fileStore.save(this.cache);
  }
}
