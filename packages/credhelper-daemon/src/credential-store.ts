import type { CredentialCacheEntry, Secret } from './types.js';

/**
 * In-memory credential store. Credentials are keyed by session ID then
 * credential ID. Never persisted to disk.
 */
export class CredentialStore {
  private readonly store = new Map<string, Map<string, CredentialCacheEntry>>();

  set(sessionId: string, credId: string, entry: CredentialCacheEntry): void {
    let session = this.store.get(sessionId);
    if (!session) {
      session = new Map();
      this.store.set(sessionId, session);
    }
    session.set(credId, entry);
  }

  get(sessionId: string, credId: string): CredentialCacheEntry | undefined {
    return this.store.get(sessionId)?.get(credId);
  }

  getAllForSession(sessionId: string): Map<string, CredentialCacheEntry> {
    return this.store.get(sessionId) ?? new Map();
  }

  isExpired(sessionId: string, credId: string): boolean {
    const entry = this.get(sessionId, credId);
    if (!entry) return true;
    return entry.expiresAt.getTime() < Date.now();
  }

  clearSession(sessionId: string): void {
    this.store.delete(sessionId);
  }

  clear(): void {
    this.store.clear();
  }
}
