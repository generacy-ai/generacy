import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ControlServer } from '../src/control-server.js';
import type { SessionManager } from '../src/session-manager.js';
import type { SessionTokenStore } from '../src/auth/session-token-store.js';
import { CredhelperError } from '../src/errors.js';

function request(
  socketPath: string,
  method: string,
  urlPath: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: data
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode!, body: JSON.parse(raw) });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('ControlServer', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlServer;
  let mockSessionManager: {
    beginSession: ReturnType<typeof vi.fn>;
    endSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-server-test-'));
    socketPath = path.join(tmpDir, 'control.sock');

    mockSessionManager = {
      beginSession: vi.fn(),
      endSession: vi.fn(),
    };

    server = new ControlServer(
      mockSessionManager as unknown as SessionManager,
      process.getuid?.() ?? 1000,
      false,
    );
    await server.start(socketPath);
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /sessions', () => {
    it('returns session_dir and expires_at', async () => {
      const expiresAt = new Date('2026-12-31T23:59:59.000Z');
      mockSessionManager.beginSession.mockResolvedValue({
        sessionDir: '/tmp/sessions/test-session',
        expiresAt,
      });

      const res = await request(socketPath, 'POST', '/sessions', {
        role: 'ci-deploy',
        session_id: 'test-session',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        session_dir: '/tmp/sessions/test-session',
        expires_at: '2026-12-31T23:59:59.000Z',
      });
      expect(mockSessionManager.beginSession).toHaveBeenCalledWith({
        role: 'ci-deploy',
        sessionId: 'test-session',
      });
    });
  });

  describe('DELETE /sessions/:id', () => {
    it('returns { ok: true }', async () => {
      mockSessionManager.endSession.mockResolvedValue(undefined);

      const res = await request(socketPath, 'DELETE', '/sessions/sess-abc');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockSessionManager.endSession).toHaveBeenCalledWith('sess-abc');
    });
  });

  describe('JSON parsing', () => {
    it('returns 400 for invalid JSON body', async () => {
      const res = await new Promise<{ status: number; body: any }>(
        (resolve, reject) => {
          const data = 'not valid json {{{';
          const req = http.request(
            {
              socketPath,
              method: 'POST',
              path: '/sessions',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode!, body: JSON.parse(raw) });
              });
            },
          );
          req.on('error', reject);
          req.write(data);
          req.end();
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.error).toBe('Invalid JSON body');
    });
  });

  describe('missing fields', () => {
    it('returns 400 when role is missing', async () => {
      const res = await request(socketPath, 'POST', '/sessions', {
        session_id: 'test-session',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.error).toBe('Missing required fields: role, session_id');
    });

    it('returns 400 when session_id is missing', async () => {
      const res = await request(socketPath, 'POST', '/sessions', {
        role: 'ci-deploy',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.error).toBe('Missing required fields: role, session_id');
    });
  });

  describe('error responses', () => {
    it('returns 404 when session not found on DELETE', async () => {
      const { CredhelperError } = await import('../src/errors.js');
      mockSessionManager.endSession.mockRejectedValue(
        new CredhelperError('SESSION_NOT_FOUND', 'Session not found: no-such', {
          sessionId: 'no-such',
        }),
      );

      const res = await request(socketPath, 'DELETE', '/sessions/no-such');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
      expect(res.body.error).toBe('Session not found: no-such');
    });
  });

  describe('unknown routes', () => {
    it('returns 400 for GET /', async () => {
      const res = await request(socketPath, 'GET', '/');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.error).toBe('Not found: GET /');
    });

    it('returns 400 for PUT /sessions', async () => {
      const res = await request(socketPath, 'PUT', '/sessions', {
        role: 'x',
        session_id: 'y',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.error).toBe('Not found: PUT /sessions');
    });
  });

  describe('auth endpoints', () => {
    let authTmpDir: string;
    let authSocketPath: string;
    let authServer: ControlServer;
    let mockAuthSessionManager: {
      beginSession: ReturnType<typeof vi.fn>;
      endSession: ReturnType<typeof vi.fn>;
    };
    let mockSessionTokenStore: {
      setToken: ReturnType<typeof vi.fn>;
      clearToken: ReturnType<typeof vi.fn>;
      getStatus: ReturnType<typeof vi.fn>;
    };

    function requestAuth(
      socketPath: string,
      method: string,
      urlPath: string,
      body?: object,
    ): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = http.request(
          {
            socketPath,
            method,
            path: urlPath,
            headers: data
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(data),
                }
              : {},
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              resolve({
                status: res.statusCode!,
                body: raw === '' ? null : JSON.parse(raw),
              });
            });
          },
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
      });
    }

    function requestAuthRaw(
      socketPath: string,
      method: string,
      urlPath: string,
      rawBody: string,
    ): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            method,
            path: urlPath,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(rawBody),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              resolve({
                status: res.statusCode!,
                body: raw === '' ? null : JSON.parse(raw),
              });
            });
          },
        );
        req.on('error', reject);
        req.write(rawBody);
        req.end();
      });
    }

    beforeEach(async () => {
      authTmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'control-server-auth-test-'),
      );
      authSocketPath = path.join(authTmpDir, 'control.sock');

      mockAuthSessionManager = {
        beginSession: vi.fn(),
        endSession: vi.fn(),
      };

      mockSessionTokenStore = {
        setToken: vi.fn(),
        clearToken: vi.fn(),
        getStatus: vi.fn(),
      };

      authServer = new ControlServer(
        mockAuthSessionManager as unknown as SessionManager,
        process.getuid?.() ?? 1000,
        false,
        mockSessionTokenStore as unknown as SessionTokenStore,
      );
      await authServer.start(authSocketPath);
    });

    afterEach(async () => {
      await authServer.close();
      fs.rmSync(authTmpDir, { recursive: true, force: true });
    });

    describe('PUT /auth/session-token', () => {
      it('returns 204 on success', async () => {
        mockSessionTokenStore.setToken.mockResolvedValue(undefined);

        const res = await requestAuth(
          authSocketPath,
          'PUT',
          '/auth/session-token',
          { token: 'valid.jwt.token' },
        );

        expect(res.status).toBe(204);
        expect(res.body).toBeNull();
        expect(mockSessionTokenStore.setToken).toHaveBeenCalledWith(
          'valid.jwt.token',
        );
      });

      it('returns 400 INVALID_TOKEN for invalid JWT', async () => {
        mockSessionTokenStore.setToken.mockRejectedValue(
          new CredhelperError(
            'INVALID_TOKEN',
            'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
          ),
        );

        const res = await requestAuth(
          authSocketPath,
          'PUT',
          '/auth/session-token',
          { token: 'bad-token' },
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_TOKEN');
      });

      it('returns 400 EXPIRED_TOKEN for expired JWT', async () => {
        mockSessionTokenStore.setToken.mockRejectedValue(
          new CredhelperError('EXPIRED_TOKEN', 'JWT has expired (exp: 1000)'),
        );

        const res = await requestAuth(
          authSocketPath,
          'PUT',
          '/auth/session-token',
          { token: 'expired.jwt.token' },
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('EXPIRED_TOKEN');
      });

      it('returns 400 INVALID_SCOPE for wrong scope', async () => {
        mockSessionTokenStore.setToken.mockRejectedValue(
          new CredhelperError(
            'INVALID_SCOPE',
            "JWT scope must be 'credhelper', got 'other'",
          ),
        );

        const res = await requestAuth(
          authSocketPath,
          'PUT',
          '/auth/session-token',
          { token: 'wrong-scope.jwt.token' },
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_SCOPE');
      });

      it('returns 400 MALFORMED_REQUEST when token field is missing', async () => {
        const res = await requestAuth(
          authSocketPath,
          'PUT',
          '/auth/session-token',
          { notToken: 'value' },
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MALFORMED_REQUEST');
        expect(res.body.error).toBe('Missing required field: token');
      });

      it('returns 400 MALFORMED_REQUEST for invalid JSON', async () => {
        const res = await requestAuthRaw(
          authSocketPath,
          'PUT',
          '/auth/session-token',
          'not valid json {{{',
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MALFORMED_REQUEST');
        expect(res.body.error).toBe('Invalid JSON body');
      });
    });

    describe('DELETE /auth/session-token', () => {
      it('returns 204 on success', async () => {
        mockSessionTokenStore.clearToken.mockResolvedValue(undefined);

        const res = await requestAuth(
          authSocketPath,
          'DELETE',
          '/auth/session-token',
        );

        expect(res.status).toBe(204);
        expect(res.body).toBeNull();
        expect(mockSessionTokenStore.clearToken).toHaveBeenCalled();
      });

      it('returns 204 when no token is stored (idempotent)', async () => {
        mockSessionTokenStore.clearToken.mockResolvedValue(undefined);

        const res = await requestAuth(
          authSocketPath,
          'DELETE',
          '/auth/session-token',
        );

        expect(res.status).toBe(204);
        expect(res.body).toBeNull();
        expect(mockSessionTokenStore.clearToken).toHaveBeenCalled();
      });
    });

    describe('GET /auth/session-token/status', () => {
      it('returns 200 with user/org/expiresAt when authenticated', async () => {
        mockSessionTokenStore.getStatus.mockReturnValue({
          authenticated: true,
          user: 'user@example.com',
          org: 'org-123',
          expiresAt: '2026-12-31T23:59:59.000Z',
        });

        const res = await requestAuth(
          authSocketPath,
          'GET',
          '/auth/session-token/status',
        );

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          authenticated: true,
          user: 'user@example.com',
          org: 'org-123',
          expiresAt: '2026-12-31T23:59:59.000Z',
        });
      });

      it('returns 200 with authenticated: false when not authenticated', async () => {
        mockSessionTokenStore.getStatus.mockReturnValue({
          authenticated: false,
        });

        const res = await requestAuth(
          authSocketPath,
          'GET',
          '/auth/session-token/status',
        );

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ authenticated: false });
      });
    });
  });
});
