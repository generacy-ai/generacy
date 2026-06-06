import {
  JitTokenError,
  type JitGitTokenClient,
} from '@generacy-ai/control-plane';
import type { AuthHealthSink } from './label-monitor-service.js';

export type JitGithubTokenProvider = () => Promise<string>;

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JitGithubTokenProviderOptions {
  client: JitGitTokenClient;
  /**
   * GitHub-app credentialId from `.agency/credentials.yaml`. When omitted,
   * the provider operates credential-less: it calls `client.fetch()` (the
   * control-plane resolves the installation from cluster identity) and
   * uses the `WIZARD_SENTINEL_KEY` for cache + authHealth keying.
   */
  credentialId?: string;
  authHealth?: AuthHealthSink;
  refreshWindowMs?: number;
  now?: () => Date;
  logger: Logger;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: Date;
  fetchedAt: Date;
}

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60_000;
const DEFAULT_SOCKET_PATH = '/run/generacy-control-plane/control.sock';

/**
 * Reserved-prefix sentinel used as the cache and AuthHealth key when the
 * JIT gh provider is built credential-less (no `github-app` descriptor in
 * `.agency/credentials.yaml`). Cannot collide with real descriptor ids,
 * which are GitHub installation/credential identifiers.
 *
 * Visible in:
 *   - structured logs from `createJitGithubTokenProvider` and `GitHubAuthHealthService`
 *   - `cluster.credentials` relay payloads (`refresh-requested` / `auth-failed` /
 *     `auth-recovered`) emitted on the credential-less path
 *
 * Cloud-side: no consumer today. Future consumers should treat any
 * credentialId starting with `__` as synthetic.
 */
export const WIZARD_SENTINEL_KEY = '__wizard__';

export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['GIT_TOKEN_SOCKET_PATH'] ??
    env['CONTROL_PLANE_SOCKET_PATH'] ??
    DEFAULT_SOCKET_PATH
  );
}

export function createJitGithubTokenProvider(
  options: JitGithubTokenProviderOptions,
): JitGithubTokenProvider {
  const {
    client,
    credentialId,
    authHealth,
    refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS,
    now = () => new Date(),
    logger,
  } = options;

  const effectiveKey = credentialId ?? WIZARD_SENTINEL_KEY;
  const cache = new Map<string, TokenCacheEntry>();

  return async () => {
    const currentTime = now();
    const cached = cache.get(effectiveKey);

    if (cached && cached.expiresAt.getTime() - currentTime.getTime() > refreshWindowMs) {
      return cached.token;
    }

    try {
      // Pass-through: undefined → client sends '{}'; defined → client sends { credentialId }.
      const response = await client.fetch(credentialId);
      const entry: TokenCacheEntry = {
        token: response.token,
        expiresAt: response.expiresAt,
        fetchedAt: now(),
      };
      cache.set(effectiveKey, entry);
      return entry.token;
    } catch (rawErr) {
      const err =
        rawErr instanceof JitTokenError
          ? rawErr
          : new JitTokenError(
              'CONTROL_SOCKET_UNREACHABLE',
              rawErr instanceof Error ? rawErr.message : String(rawErr),
            );

      // Discard any stale cached entry — never serve a token after a refresh failure.
      cache.delete(effectiveKey);

      try {
        authHealth?.recordResult(effectiveKey, { ok: false, statusCode: 503 });
      } catch {
        // Sink errors must not mask the original failure.
      }

      logger.warn(
        { code: err.code, message: err.message, credentialId: effectiveKey },
        'JIT GitHub token refresh failed',
      );

      throw err;
    }
  };
}
