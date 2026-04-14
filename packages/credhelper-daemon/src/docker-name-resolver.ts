import http from 'node:http';

import type { ContainerNameCacheEntry } from './types.js';

/**
 * Resolves Docker container IDs to container names by querying the upstream
 * Docker API. Results are cached per instance (typically per session).
 */
export class ContainerNameResolver {
  private readonly cache = new Map<string, ContainerNameCacheEntry>();

  constructor(private readonly upstreamSocket: string) {}

  /**
   * Resolve a container ID to its name.
   * Returns `null` on failure (caller should deny — fail closed).
   */
  async resolve(containerId: string): Promise<string | null> {
    const cached = this.cache.get(containerId);
    if (cached !== undefined) {
      return cached.name;
    }

    try {
      const name = await this.fetchContainerName(containerId);
      if (name !== null) {
        this.cache.set(containerId, { name, resolvedAt: Date.now() });
      }
      return name;
    } catch {
      return null;
    }
  }

  /** Clear the cache (called on session end). */
  clear(): void {
    this.cache.clear();
  }

  private fetchContainerName(containerId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          socketPath: this.upstreamSocket,
          method: 'GET',
          path: `/containers/${encodeURIComponent(containerId)}/json`,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString()) as { Name?: string };
              // Docker container names are prefixed with '/'
              const raw = body.Name ?? null;
              resolve(raw !== null ? raw.replace(/^\//, '') : null);
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', () => resolve(null));
      req.end();
    });
  }
}
