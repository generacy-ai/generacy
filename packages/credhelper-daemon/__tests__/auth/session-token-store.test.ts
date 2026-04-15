import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionTokenStore } from '../../src/auth/session-token-store.js';
import type { JwtParser, SessionTokenClaims } from '../../src/auth/jwt-parser.js';
import { CredhelperError } from '../../src/errors.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

const KNOWN_CLAIMS: SessionTokenClaims = {
  sub: 'user-123',
  org_id: 'org-456',
  scope: 'credhelper',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function makeMockParser(claims: SessionTokenClaims = KNOWN_CLAIMS): JwtParser {
  return { parse: vi.fn().mockReturnValue(claims) } as unknown as JwtParser;
}

describe('SessionTokenStore', () => {
  let tmpDir: string;
  let tokenFilePath: string;
  let parser: JwtParser;
  let store: SessionTokenStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'credhelper-token-test-'));
    tokenFilePath = join(tmpDir, 'session-token');
    parser = makeMockParser();
    store = new SessionTokenStore(tokenFilePath, parser);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('setToken()', () => {
    it('writes file atomically with mode 0600', async () => {
      const token = makeJwt(KNOWN_CLAIMS);
      await store.setToken(token);

      // Verify file exists and contains the token
      const contents = await readFile(tokenFilePath, 'utf-8');
      expect(contents).toBe(token);

      // Verify file permissions are 0600
      const fileStat = statSync(tokenFilePath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    });

    it('rejects invalid JWT (delegates to JwtParser)', async () => {
      const badParser = {
        parse: vi.fn().mockImplementation(() => {
          throw new CredhelperError(
            'INVALID_TOKEN',
            'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
          );
        }),
      } as unknown as JwtParser;

      const badStore = new SessionTokenStore(tokenFilePath, badParser);
      const token = 'not-a-real-jwt';

      await expect(badStore.setToken(token)).rejects.toThrow(CredhelperError);
      expect(badParser.parse).toHaveBeenCalledWith(token);

      // File should not exist since parse threw before writing
      await expect(stat(tokenFilePath)).rejects.toThrow();
    });
  });

  describe('clearToken()', () => {
    it('removes file and cache', async () => {
      const token = makeJwt(KNOWN_CLAIMS);
      await store.setToken(token);

      // Confirm token is cached
      expect(await store.getToken()).not.toBeNull();

      await store.clearToken();

      // Cache should be cleared
      expect(await store.getToken()).toBeNull();

      // File should be gone
      await expect(stat(tokenFilePath)).rejects.toThrow();
    });

    it('is idempotent when no file exists (ENOENT)', async () => {
      // No setToken was called, so no file exists — should not throw
      await expect(store.clearToken()).resolves.toBeUndefined();
      expect(await store.getToken()).toBeNull();
    });
  });

  describe('getStatus()', () => {
    it('returns authenticated state without token value', async () => {
      const token = makeJwt(KNOWN_CLAIMS);
      await store.setToken(token);

      const status = store.getStatus();
      expect(status.authenticated).toBe(true);

      if (status.authenticated) {
        expect(status.user).toBe(KNOWN_CLAIMS.sub);
        expect(status.org).toBe(KNOWN_CLAIMS.org_id);
        expect(status.expiresAt).toBe(new Date(KNOWN_CLAIMS.exp * 1000).toISOString());

        // Ensure the raw token value is NOT exposed in status
        expect(status).not.toHaveProperty('value');
        expect(status).not.toHaveProperty('token');
      }
    });

    it('returns {authenticated: false} when empty', () => {
      const status = store.getStatus();
      expect(status).toEqual({ authenticated: false });
    });
  });

  describe('getToken()', () => {
    it('returns value+claims when set', async () => {
      const token = makeJwt(KNOWN_CLAIMS);
      await store.setToken(token);

      const result = await store.getToken();
      expect(result).not.toBeNull();
      expect(result!.value).toBe(token);
      expect(result!.claims).toEqual(KNOWN_CLAIMS);
    });

    it('returns null when no token is set', async () => {
      const result = await store.getToken();
      expect(result).toBeNull();
    });
  });

  describe('loadFromDisk()', () => {
    it('restores token from file', async () => {
      const token = makeJwt(KNOWN_CLAIMS);

      // Write token file directly (simulating a previous daemon run)
      await writeFile(tokenFilePath, token, { mode: 0o600 });

      // Create a fresh store (no in-memory cache)
      const freshStore = new SessionTokenStore(tokenFilePath, parser);

      expect(await freshStore.getToken()).toBeNull();

      await freshStore.loadFromDisk();

      const result = await freshStore.getToken();
      expect(result).not.toBeNull();
      expect(result!.value).toBe(token);
      expect(result!.claims).toEqual(KNOWN_CLAIMS);
      expect(parser.parse).toHaveBeenCalledWith(token);
    });

    it('gracefully handles missing file', async () => {
      // No file on disk — should not throw, cache stays null
      await expect(store.loadFromDisk()).resolves.toBeUndefined();
      expect(await store.getToken()).toBeNull();
    });

    it('ignores invalid token on disk', async () => {
      const invalidParser = {
        parse: vi.fn().mockImplementation(() => {
          throw new CredhelperError('INVALID_TOKEN', 'bad token');
        }),
      } as unknown as JwtParser;

      await writeFile(tokenFilePath, 'corrupted-data', { mode: 0o600 });

      const freshStore = new SessionTokenStore(tokenFilePath, invalidParser);
      await expect(freshStore.loadFromDisk()).resolves.toBeUndefined();
      expect(await freshStore.getToken()).toBeNull();
    });
  });
});
