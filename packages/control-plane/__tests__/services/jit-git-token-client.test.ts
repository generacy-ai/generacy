import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createJitGitTokenClient,
  JitTokenError,
  type JitTokenErrorCode,
} from '../../src/services/jit-git-token-client.js';

interface FakeServerHandle {
  socketPath: string;
  setHandler: (h: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) => void;
  capturedBody: () => string | undefined;
  close: () => Promise<void>;
}

async function startSocketServer(socketPath: string): Promise<FakeServerHandle> {
  let capturedBody: string | undefined;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void = (
    _req,
    res,
  ) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'default', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      capturedBody = body;
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.once('error', reject);
  });
  return {
    socketPath,
    setHandler: (h) => {
      handler = h;
    },
    capturedBody: () => capturedBody,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function expectJitTokenError(
  promise: Promise<unknown>,
  code: JitTokenErrorCode,
): Promise<JitTokenError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(JitTokenError);
    expect((err as JitTokenError).code).toBe(code);
    return err as JitTokenError;
  }
  throw new Error(`expected JitTokenError(${code}) but promise resolved`);
}

describe('createJitGitTokenClient', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: FakeServerHandle | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jit-git-client-'));
    socketPath = path.join(tmpDir, 'control.sock');
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('happy path: 200 with valid body returns { token, expiresAt: Date }', async () => {
    server = await startSocketServer(socketPath);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'ghs_abc', expiresAt }));
    });

    const client = createJitGitTokenClient({ socketPath });
    const result = await client.fetch();

    expect(result.token).toBe('ghs_abc');
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.toISOString()).toBe(expiresAt);
  });

  it('400 with CREDENTIAL_NOT_CONFIGURED → throws JitTokenError with that code', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no cred configured', code: 'CREDENTIAL_NOT_CONFIGURED' }));
    });

    const client = createJitGitTokenClient({ socketPath });
    const err = await expectJitTokenError(client.fetch(), 'CREDENTIAL_NOT_CONFIGURED');
    expect(err.message).toBe('no cred configured');
  });

  it('502 with CLOUD_UNREACHABLE → throws with that code', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'cloud down', code: 'CLOUD_UNREACHABLE' }));
    });
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'CLOUD_UNREACHABLE');
  });

  it('503 with CLUSTER_API_KEY_MISSING → throws with that code', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no key', code: 'CLUSTER_API_KEY_MISSING' }));
    });
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'CLUSTER_API_KEY_MISSING');
  });

  it('200 with non-JSON body → throws RESPONSE_PARSE_ERROR', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('this-is-not-json');
    });
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'RESPONSE_PARSE_ERROR');
  });

  it('200 with missing token → throws RESPONSE_PARSE_ERROR', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    });
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'RESPONSE_PARSE_ERROR');
  });

  it('200 with bogus expiresAt → throws RESPONSE_PARSE_ERROR', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'abc', expiresAt: 'not-a-date' }));
    });
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'RESPONSE_PARSE_ERROR');
  });

  it('unknown error code in body → falls back to CLOUD_UPSTREAM_ERROR', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom', code: 'NEW_UNRECOGNIZED_CODE' }));
    });
    const client = createJitGitTokenClient({ socketPath });
    const err = await expectJitTokenError(client.fetch(), 'CLOUD_UPSTREAM_ERROR');
    expect(err.message).toBe('boom');
  });

  it('no body on error → CLOUD_UPSTREAM_ERROR with message HTTP <status>', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end();
    });
    const client = createJitGitTokenClient({ socketPath });
    const err = await expectJitTokenError(client.fetch(), 'CLOUD_UPSTREAM_ERROR');
    expect(err.message).toBe('HTTP 500');
  });

  it('socket does not exist → CONTROL_SOCKET_UNREACHABLE', async () => {
    // Use a path that definitely does not exist.
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'CONTROL_SOCKET_UNREACHABLE');
  });

  it('socket connects then destroys mid-stream → CONTROL_SOCKET_UNREACHABLE', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      // Hijack the underlying socket and destroy without writing a complete HTTP response.
      res.socket?.destroy();
    });
    const client = createJitGitTokenClient({ socketPath });
    await expectJitTokenError(client.fetch(), 'CONTROL_SOCKET_UNREACHABLE');
  });

  it('credentialId provided → body is {"credentialId":"<id>"}', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    });
    const client = createJitGitTokenClient({ socketPath });
    await client.fetch('cred-42');
    expect(server.capturedBody()).toBe('{"credentialId":"cred-42"}');
  });

  it('credentialId omitted → body is {}', async () => {
    server = await startSocketServer(socketPath);
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    });
    const client = createJitGitTokenClient({ socketPath });
    await client.fetch();
    expect(server.capturedBody()).toBe('{}');
  });
});
