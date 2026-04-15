import { writeFile, rename, unlink, readFile } from 'node:fs/promises';

import type { SessionTokenClaims } from './jwt-parser.js';
import type { JwtParser } from './jwt-parser.js';

export interface SessionTokenProvider {
  getToken(): Promise<{ value: string; claims: SessionTokenClaims } | null>;
}

export type SessionTokenStatus =
  | { authenticated: true; user: string; org: string; expiresAt: string }
  | { authenticated: false };

/**
 * Shared in-memory + filesystem token provider.
 *
 * ControlServer writes tokens via setToken()/clearToken().
 * GeneracyCloudBackend reads tokens via getToken().
 * Filesystem persistence at tokenFilePath survives daemon restarts
 * within a container lifecycle (/run/ is tmpfs).
 */
export class SessionTokenStore implements SessionTokenProvider {
  private cached: { value: string; claims: SessionTokenClaims } | null = null;

  constructor(
    private readonly tokenFilePath: string,
    private readonly parser: JwtParser,
  ) {}

  /**
   * Parse JWT, write atomically to filesystem, update in-memory cache.
   * Throws CredhelperError if JWT is invalid.
   */
  async setToken(token: string): Promise<void> {
    const claims = this.parser.parse(token);
    const tmpPath = `${this.tokenFilePath}.tmp`;
    await writeFile(tmpPath, token, { mode: 0o600 });
    await rename(tmpPath, this.tokenFilePath);
    this.cached = { value: token, claims };
  }

  /**
   * Unlink token file (idempotent), clear in-memory cache.
   */
  async clearToken(): Promise<void> {
    try {
      await unlink(this.tokenFilePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.cached = null;
  }

  /**
   * Return auth status from in-memory cache (no token value exposed).
   */
  getStatus(): SessionTokenStatus {
    if (!this.cached) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      user: this.cached.claims.sub,
      org: this.cached.claims.org_id,
      expiresAt: new Date(this.cached.claims.exp * 1000).toISOString(),
    };
  }

  /**
   * Return token + claims for backend use, or null if not authenticated.
   */
  async getToken(): Promise<{ value: string; claims: SessionTokenClaims } | null> {
    return this.cached;
  }

  /**
   * Attempt to load token from filesystem into memory (called at daemon startup).
   * Gracefully handles missing or invalid token files.
   */
  async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.tokenFilePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    try {
      const claims = this.parser.parse(raw);
      this.cached = { value: raw, claims };
    } catch {
      // Invalid/expired token on disk — ignore, user will re-login
    }
  }
}
