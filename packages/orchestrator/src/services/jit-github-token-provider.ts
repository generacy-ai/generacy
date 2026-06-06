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
  credentialId: string;
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

  const cache = new Map<string, TokenCacheEntry>();

  return async () => {
    const currentTime = now();
    const cached = cache.get(credentialId);

    if (cached && cached.expiresAt.getTime() - currentTime.getTime() > refreshWindowMs) {
      return cached.token;
    }

    try {
      const response = await client.fetch(credentialId);
      const entry: TokenCacheEntry = {
        token: response.token,
        expiresAt: response.expiresAt,
        fetchedAt: now(),
      };
      cache.set(credentialId, entry);
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
      cache.delete(credentialId);

      try {
        authHealth?.recordResult(credentialId, { ok: false, statusCode: 503 });
      } catch {
        // Sink errors must not mask the original failure.
      }

      logger.warn(
        { code: err.code, message: err.message, credentialId },
        'JIT GitHub token refresh failed',
      );

      throw err;
    }
  };
}
