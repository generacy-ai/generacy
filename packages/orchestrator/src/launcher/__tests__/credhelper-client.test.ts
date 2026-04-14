import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CredhelperHttpClient } from '../credhelper-client.js';
import { CredhelperUnavailableError, CredhelperSessionError } from '../credhelper-errors.js';

function tmpSocketPath(): string {
  const suffix = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `credhelper-test-${suffix}.sock`);
}

describe('CredhelperHttpClient', () => {
  let server: http.Server;
  let socketPath: string;
  let nextResponse: { statusCode: number; body: string };

  function setNextResponse(statusCode: number, body: object): void {
    nextResponse = { statusCode, body: JSON.stringify(body) };
  }

  beforeAll(async () => {
    socketPath = tmpSocketPath();

    server = http.createServer((_req, res) => {
      res.writeHead(nextResponse.statusCode, { 'Content-Type': 'application/json' });
      res.end(nextResponse.body);
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Socket file may already be cleaned up
    }
  });

  describe('beginSession', () => {
    it('returns sessionDir and expiresAt on success', async () => {
      setNextResponse(200, {
        session_dir: '/tmp/sess',
        expires_at: '2026-04-13T15:30:00.000Z',
      });

      const client = new CredhelperHttpClient({ socketPath });
      const result = await client.beginSession('my-role', 'sess-001');

      expect(result.sessionDir).toBe('/tmp/sess');
      expect(result.expiresAt).toEqual(new Date('2026-04-13T15:30:00.000Z'));
    });

    it('throws CredhelperSessionError on non-200 response', async () => {
      setNextResponse(400, {
        error: 'Role not found',
        code: 'ROLE_NOT_FOUND',
      });

      const client = new CredhelperHttpClient({ socketPath });

      await expect(client.beginSession('bad-role', 'sess-002')).rejects.toThrow(
        CredhelperSessionError,
      );

      try {
        await client.beginSession('bad-role', 'sess-002');
      } catch (err) {
        const sessionErr = err as CredhelperSessionError;
        expect(sessionErr.code).toBe('ROLE_NOT_FOUND');
        expect(sessionErr.role).toBe('bad-role');
        expect(sessionErr.sessionId).toBe('sess-002');
      }
    });
  });

  describe('endSession', () => {
    it('resolves without error on success', async () => {
      setNextResponse(200, { ok: true });

      const client = new CredhelperHttpClient({ socketPath });
      await expect(client.endSession('sess-003')).resolves.toBeUndefined();
    });

    it('throws CredhelperSessionError on non-200 response', async () => {
      setNextResponse(404, {
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND',
      });

      const client = new CredhelperHttpClient({ socketPath });

      await expect(client.endSession('sess-404')).rejects.toThrow(CredhelperSessionError);

      try {
        await client.endSession('sess-404');
      } catch (err) {
        const sessionErr = err as CredhelperSessionError;
        expect(sessionErr.code).toBe('SESSION_NOT_FOUND');
        expect(sessionErr.sessionId).toBe('sess-404');
      }
    });
  });

  describe('connection errors', () => {
    it('throws CredhelperUnavailableError when socket does not exist', async () => {
      const badPath = '/tmp/nonexistent-credhelper-socket.sock';
      const client = new CredhelperHttpClient({ socketPath: badPath });

      await expect(client.beginSession('role', 'sess-err')).rejects.toThrow(
        CredhelperUnavailableError,
      );

      try {
        await client.beginSession('role', 'sess-err');
      } catch (err) {
        const unavailableErr = err as CredhelperUnavailableError;
        expect(unavailableErr.socketPath).toBe(badPath);
      }
    });
  });

  describe('connectTimeout', () => {
    let hangServer: net.Server;
    let hangSocketPath: string;
    const hangSockets = new Set<net.Socket>();

    beforeAll(async () => {
      hangSocketPath = tmpSocketPath();

      // Create a TCP server that accepts connections but never responds
      hangServer = net.createServer((socket) => {
        hangSockets.add(socket);
        socket.on('close', () => hangSockets.delete(socket));
        // Intentionally do nothing else — connection hangs
      });

      await new Promise<void>((resolve, reject) => {
        hangServer.on('error', reject);
        hangServer.listen(hangSocketPath, resolve);
      });
    });

    afterAll(async () => {
      // Destroy all open connections so the server can close promptly
      for (const socket of hangSockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        hangServer.close(() => resolve());
      });

      try {
        fs.unlinkSync(hangSocketPath);
      } catch {
        // Socket file may already be cleaned up
      }
    });

    it('throws CredhelperUnavailableError when connect times out', async () => {
      const client = new CredhelperHttpClient({
        socketPath: hangSocketPath,
        connectTimeout: 100,
      });

      await expect(client.beginSession('role', 'sess-timeout')).rejects.toThrow(
        CredhelperUnavailableError,
      );

      try {
        await client.beginSession('role', 'sess-timeout');
      } catch (err) {
        const unavailableErr = err as CredhelperUnavailableError;
        expect(unavailableErr.socketPath).toBe(hangSocketPath);
      }
    });
  });
});
