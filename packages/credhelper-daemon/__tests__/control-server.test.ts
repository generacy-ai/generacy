import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ControlServer } from '../src/control-server.js';
import type { SessionManager } from '../src/session-manager.js';

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
});
