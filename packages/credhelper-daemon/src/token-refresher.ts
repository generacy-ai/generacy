import type { CredentialCacheEntry, Secret } from './types.js';
import { CredentialStore } from './credential-store.js';

export type MintFn = () => Promise<{ value: Secret; expiresAt: Date }>;

/**
 * Background token refresher. Schedules refresh at 75% of each credential's
 * TTL using setTimeout chains. On mint failure the credential is marked
 * unavailable and the timer stops (fail-closed for that credential).
 */
export class TokenRefresher {
  private readonly timers = new Map<string, Map<string, NodeJS.Timeout>>();

  constructor(private readonly store: CredentialStore) {}

  /**
   * Schedule a background refresh for a credential.
   * Fires at 75% of TTL, calls mintFn, updates the store, and reschedules.
   */
  scheduleRefresh(
    sessionId: string,
    credId: string,
    ttlMs: number,
    mintFn: MintFn,
  ): void {
    const delay = Math.max(ttlMs * 0.75, 1000); // at least 1s

    const timerId = setTimeout(async () => {
      try {
        const result = await mintFn();
        const existing = this.store.get(sessionId, credId);
        if (!existing) return; // session was cleared

        const updated: CredentialCacheEntry = {
          ...existing,
          value: result.value,
          expiresAt: result.expiresAt,
          available: true,
        };
        this.store.set(sessionId, credId, updated);

        // Reschedule with new TTL
        const newTtlMs = result.expiresAt.getTime() - Date.now();
        if (newTtlMs > 0) {
          this.scheduleRefresh(sessionId, credId, newTtlMs, mintFn);
        }
      } catch (err) {
        console.error(
          `[credhelper] Token refresh failed for session=${sessionId} credential=${credId}:`,
          err,
        );
        // Mark credential unavailable — fail-closed
        const existing = this.store.get(sessionId, credId);
        if (existing) {
          this.store.set(sessionId, credId, { ...existing, available: false });
        }
      }
    }, delay);

    // Track the timer
    let sessionTimers = this.timers.get(sessionId);
    if (!sessionTimers) {
      sessionTimers = new Map();
      this.timers.set(sessionId, sessionTimers);
    }
    // Clear any existing timer for this credential
    const existing = sessionTimers.get(credId);
    if (existing) clearTimeout(existing);
    sessionTimers.set(credId, timerId);
  }

  /** Cancel all refresh timers for a session. */
  cancelSession(sessionId: string): void {
    const sessionTimers = this.timers.get(sessionId);
    if (sessionTimers) {
      for (const timerId of sessionTimers.values()) {
        clearTimeout(timerId);
      }
      this.timers.delete(sessionId);
    }
  }

  /** Cancel all refresh timers across all sessions. */
  cancelAll(): void {
    for (const sessionTimers of this.timers.values()) {
      for (const timerId of sessionTimers.values()) {
        clearTimeout(timerId);
      }
    }
    this.timers.clear();
  }
}
