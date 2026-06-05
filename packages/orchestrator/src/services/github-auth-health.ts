import type {
  CredentialDescriptor,
  CredentialsEventPayload,
  GitHubAuthSnapshot,
  GitHubAuthStatus,
  PerCredentialState,
} from '../types/github-auth.js';
import type { AuthHealthSink } from './label-monitor-service.js';

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface GitHubAuthHealthServiceOptions {
  emitEvent: (payload: CredentialsEventPayload) => void;
  logger: Logger;
  now?: () => number;
  minRefreshIntervalMs?: number;
}

export type RecordResult =
  | { ok: true }
  | { ok: false; statusCode?: number; error?: unknown };

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

/**
 * In-memory per-credential GitHub auth state machine.
 *
 * Owns the `githubAuth` field surfaced on `/health` and emits state-transition
 * events on `cluster.credentials`. Rate-limits refresh requests per credential.
 */
export class GitHubAuthHealthService implements AuthHealthSink {
  private readonly emitEvent: (payload: CredentialsEventPayload) => void;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly minRefreshIntervalMs: number;
  private readonly entries: Map<string, PerCredentialState> = new Map();

  constructor(options: GitHubAuthHealthServiceOptions) {
    this.emitEvent = options.emitEvent;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  setCredentials(credentials: CredentialDescriptor[]): void {
    const incoming = new Set<string>();
    for (const desc of credentials) {
      incoming.add(desc.credentialId);
      const existing = this.entries.get(desc.credentialId);
      const expiresAtMs = desc.expiresAt ? Date.parse(desc.expiresAt) : undefined;
      if (existing) {
        existing.expiresAtMs = Number.isFinite(expiresAtMs) ? expiresAtMs : undefined;
      } else {
        this.entries.set(desc.credentialId, {
          credentialId: desc.credentialId,
          status: 'unknown',
          consecutiveFailures: 0,
          expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
        });
      }
    }
    for (const id of [...this.entries.keys()]) {
      if (!incoming.has(id)) {
        this.entries.delete(id);
      }
    }
  }

  recordResult(credentialId: string, result: RecordResult): void {
    const entry = this.getOrCreate(credentialId);

    if (result.ok) {
      const wasFailing = entry.status === 'failing';
      const previousFailures = entry.consecutiveFailures;
      entry.status = 'ok';
      entry.lastSuccessAt = this.now();
      entry.consecutiveFailures = 0;
      if (wasFailing) {
        this.emitEvent({
          action: 'auth-recovered',
          credentialId,
          type: 'github-app',
          recoveredAfterFailures: previousFailures,
        });
        this.logger.info(
          {
            credentialId,
            lastSuccessAt: new Date(entry.lastSuccessAt).toISOString(),
            recoveredAfterFailures: previousFailures,
          },
          'GitHub authentication recovered',
        );
      }
      return;
    }

    if (result.statusCode !== 401) {
      // Non-401 failures don't transition auth state — they may be transient.
      return;
    }

    const wasFailing = entry.status === 'failing';
    entry.consecutiveFailures += 1;
    entry.status = 'failing';

    if (!wasFailing) {
      this.emitEvent({
        action: 'auth-failed',
        credentialId,
        type: 'github-app',
        consecutiveFailures: entry.consecutiveFailures,
        reason: 'HTTP 401',
      });
    }

    this.maybeRequestRefresh(credentialId, 'auth-401');
  }

  maybeRequestRefresh(
    credentialId: string,
    reason: 'near-expiry' | 'auth-401' | string,
  ): boolean {
    const entry = this.getOrCreate(credentialId);
    const now = this.now();
    if (
      entry.lastRefreshRequestAtMs !== undefined &&
      now - entry.lastRefreshRequestAtMs < this.minRefreshIntervalMs
    ) {
      this.logger.debug(
        {
          credentialId,
          msSinceLastRequest: now - entry.lastRefreshRequestAtMs,
        },
        'Refresh request suppressed by rate limit',
      );
      return false;
    }
    entry.lastRefreshRequestAtMs = now;
    const expiresAtIso = entry.expiresAtMs
      ? new Date(entry.expiresAtMs).toISOString()
      : undefined;
    this.emitEvent({
      action: 'refresh-requested',
      credentialId,
      type: 'github-app',
      expiresAt: expiresAtIso,
      reason,
    });
    const secondsRemaining =
      entry.expiresAtMs !== undefined
        ? Math.max(0, Math.floor((entry.expiresAtMs - now) / 1000))
        : undefined;
    this.logger.warn(
      { credentialId, expiresAt: expiresAtIso, secondsRemaining, reason },
      'GitHub token near expiry — requesting refresh from cloud',
    );
    return true;
  }

  snapshot(): GitHubAuthSnapshot {
    if (this.entries.size === 0) {
      return { status: 'unknown', consecutiveFailures: 0 };
    }
    const selected = this.selectSurfaceCredential();
    if (!selected) {
      return { status: 'unknown', consecutiveFailures: 0 };
    }
    const snapshot: GitHubAuthSnapshot = {
      status: selected.status,
      consecutiveFailures: selected.consecutiveFailures,
      credentialId: selected.credentialId,
    };
    if (selected.lastSuccessAt !== undefined) {
      snapshot.lastSuccessAt = new Date(selected.lastSuccessAt).toISOString();
    }
    if (selected.expiresAtMs !== undefined) {
      snapshot.expiresAt = new Date(selected.expiresAtMs).toISOString();
    }
    return snapshot;
  }

  private getOrCreate(credentialId: string): PerCredentialState {
    let entry = this.entries.get(credentialId);
    if (!entry) {
      entry = {
        credentialId,
        status: 'unknown',
        consecutiveFailures: 0,
      };
      this.entries.set(credentialId, entry);
    }
    return entry;
  }

  private selectSurfaceCredential(): PerCredentialState | undefined {
    const byPriority: Record<GitHubAuthStatus, PerCredentialState[]> = {
      failing: [],
      ok: [],
      unknown: [],
    };
    for (const entry of this.entries.values()) {
      byPriority[entry.status].push(entry);
    }
    const pick = (group: PerCredentialState[]): PerCredentialState | undefined => {
      if (group.length === 0) return undefined;
      return [...group].sort((a, b) => a.credentialId.localeCompare(b.credentialId))[0];
    };
    return pick(byPriority.failing) ?? pick(byPriority.ok) ?? pick(byPriority.unknown);
  }
}
