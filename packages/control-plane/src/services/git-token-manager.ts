import type { GitTokenCacheEntry } from '../types/git-token.js';
import { GitHelperError } from '../types/git-token.js';
import type { CloudPullClient } from './cloud-pull-client.js';

export const REFRESH_WINDOW_MS = 5 * 60_000;

export interface GitTokenManager {
  getToken(credentialId: string): Promise<GitTokenCacheEntry>;
}

export interface CreateGitTokenManagerOptions {
  cloudPullClient: CloudPullClient;
  /** Override the clock. Defaults to `Date.now`. */
  now?: () => number;
  logger?: { info: (obj: Record<string, unknown>) => void; warn: (obj: Record<string, unknown>) => void };
}

export function createGitTokenManager(options: CreateGitTokenManagerOptions): GitTokenManager {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? {
    info: (obj) => console.log(JSON.stringify(obj)),
    warn: (obj) => console.warn(JSON.stringify(obj)),
  };

  let cache: GitTokenCacheEntry | null = null;
  let inFlight: Promise<GitTokenCacheEntry> | null = null;

  async function refresh(credentialId: string): Promise<GitTokenCacheEntry> {
    const start = now();
    try {
      const response = await options.cloudPullClient.pull(credentialId);
      const expiresAtMs = Date.parse(response.expiresAt);
      const fetchedAtMs = now();
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= fetchedAtMs) {
        throw new GitHelperError(
          'CLOUD_RESPONSE_INVALID',
          'Cloud returned an expiresAt at or before now',
        );
      }
      const entry: GitTokenCacheEntry = {
        token: response.token,
        expiresAt: new Date(expiresAtMs),
        credentialId,
        fetchedAt: new Date(fetchedAtMs),
      };
      cache = entry;
      logger.info({
        event: 'git-token-get',
        result: 'refresh-success',
        credentialId,
        expiresAt: response.expiresAt,
        durationMs: now() - start,
      });
      return entry;
    } catch (err) {
      const errorCode = err instanceof GitHelperError ? err.code : 'UNKNOWN';
      logger.warn({
        event: 'git-token-get',
        result: 'refresh-error',
        credentialId,
        errorCode,
        durationMs: now() - start,
      });
      throw err;
    }
  }

  return {
    async getToken(credentialId: string): Promise<GitTokenCacheEntry> {
      const start = now();

      if (
        cache &&
        cache.credentialId === credentialId &&
        cache.expiresAt.getTime() - now() > REFRESH_WINDOW_MS
      ) {
        logger.info({
          event: 'git-token-get',
          result: 'cache-hit',
          credentialId,
          expiresAt: cache.expiresAt.toISOString(),
          durationMs: now() - start,
        });
        return cache;
      }

      if (inFlight) {
        return inFlight;
      }

      inFlight = refresh(credentialId).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
