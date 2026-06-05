import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '../../..');
const distBinPath = path.join(pkgRoot, 'dist/bin/git-token-proxy.js');

interface UpstreamHandle {
  socketPath: string;
  server: http.Server;
  requests: Array<{ method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: string }>;
  setHandler: (h: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
  close: () => Promise<void>;
}

async function startUpstream(socketPath: string): Promise<UpstreamHandle> {
  const requests: UpstreamHandle['requests'] = [];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'ghs_fake_token', expiresAt: '2026-06-05T17:00:00.000Z' }));
    });
  };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    server,
    requests,
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface ProxyChildHandle {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  waitForLine: (predicate: (line: string) => boolean, timeoutMs?: number) => Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnProxy(env: Record<string, string>): ProxyChildHandle {
  const child = spawn(process.execPath, [distBinPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  let stdoutBuf = '';
  let stderrBuf = '';
  const lineListeners: Array<(line: string) => boolean> = [];

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    // Flush whole lines to listeners
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handle.stdout += line + '\n';
      for (let i = lineListeners.length - 1; i >= 0; i--) {
        if (lineListeners[i]!(line)) {
          lineListeners.splice(i, 1);
        }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    handle.stderr += chunk.toString('utf8');
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const handle: ProxyChildHandle = {
    child,
    stdout: '',
    stderr: '',
    waitForLine: (predicate, timeoutMs = 5_000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = lineListeners.findIndex((p) => p === wrapped);
          if (idx >= 0) lineListeners.splice(idx, 1);
          reject(new Error(`timed out waiting for line. stdout so far:\n${handle.stdout}\nstderr:\n${handle.stderr}`));
        }, timeoutMs);
        timer.unref();
        const wrapped = (line: string): boolean => {
          if (!predicate(line)) return false;
          clearTimeout(timer);
          resolve(line);
          return true;
        };
        lineListeners.push(wrapped);
      }),
    exited,
  };

  // Suppress unused-var warnings for stderrBuf/stdoutBuf
  void stderrBuf;
  void stdoutBuf;

  return handle;
}

function request(socketPath: string, method: string, urlPath: string, body?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: body !== undefined
          ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe.skipIf(process.platform === 'win32')('git-token-proxy bin — lifecycle smoke test', () => {
  let tmpDir: string;
  let listenSocket: string;
  let upstreamSocket: string;
  let upstream: UpstreamHandle | null = null;
  let proxy: ProxyChildHandle | null = null;

  beforeAll(() => {
    if (!existsSync(distBinPath)) {
      throw new Error(
        `git-token-proxy dist bin missing at ${distBinPath}. Run "pnpm -F @generacy-ai/control-plane build" first.`,
      );
    }
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-token-proxy-smoke-'));
    listenSocket = path.join(tmpDir, 'proxy.sock');
    upstreamSocket = path.join(tmpDir, 'upstream.sock');
    upstream = await startUpstream(upstreamSocket);
  });

  afterEach(async () => {
    if (proxy && proxy.child.exitCode === null && proxy.child.signalCode === null) {
      try {
        proxy.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    proxy = null;
    if (upstream) {
      await upstream.close().catch(() => undefined);
      upstream = null;
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('binds the listen socket at 0660 mode and emits git-token-proxy-init', async () => {
    proxy = spawnProxy({
      GIT_TOKEN_PROXY_SOCKET: listenSocket,
      CONTROL_PLANE_SOCKET_PATH: upstreamSocket,
    });
    const initLine = await proxy.waitForLine((l) => l.includes('git-token-proxy-init'));
    const parsed = JSON.parse(initLine) as { event: string; listenSocket: string; upstreamSocket: string };
    expect(parsed.event).toBe('git-token-proxy-init');
    expect(parsed.listenSocket).toBe(listenSocket);
    expect(parsed.upstreamSocket).toBe(upstreamSocket);

    expect(existsSync(listenSocket)).toBe(true);
    const mode = statSync(listenSocket).mode & 0o777;
    expect(mode).toBe(0o660);
  });

  it('forwards POST /git-token to the upstream and pipes the response back', async () => {
    proxy = spawnProxy({
      GIT_TOKEN_PROXY_SOCKET: listenSocket,
      CONTROL_PLANE_SOCKET_PATH: upstreamSocket,
    });
    await proxy.waitForLine((l) => l.includes('git-token-proxy-init'));

    const res = await request(listenSocket, 'POST', '/git-token', JSON.stringify({}));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      token: 'ghs_fake_token',
      expiresAt: '2026-06-05T17:00:00.000Z',
    });
    expect(upstream!.requests).toHaveLength(1);
    expect(upstream!.requests[0]!.method).toBe('POST');
    expect(upstream!.requests[0]!.url).toBe('/git-token');
  });

  it('returns 404 on GET /git-token without contacting upstream', async () => {
    proxy = spawnProxy({
      GIT_TOKEN_PROXY_SOCKET: listenSocket,
      CONTROL_PLANE_SOCKET_PATH: upstreamSocket,
    });
    await proxy.waitForLine((l) => l.includes('git-token-proxy-init'));

    const res = await request(listenSocket, 'GET', '/git-token');
    expect(res.statusCode).toBe(404);
    expect(upstream!.requests).toHaveLength(0);
  });

  it('returns 404 on POST /credentials/x without contacting upstream', async () => {
    proxy = spawnProxy({
      GIT_TOKEN_PROXY_SOCKET: listenSocket,
      CONTROL_PLANE_SOCKET_PATH: upstreamSocket,
    });
    await proxy.waitForLine((l) => l.includes('git-token-proxy-init'));

    const res = await request(listenSocket, 'POST', '/credentials/x', JSON.stringify({}));
    expect(res.statusCode).toBe(404);
    expect(upstream!.requests).toHaveLength(0);
  });

  it('exits cleanly on SIGTERM and removes the listen socket', async () => {
    proxy = spawnProxy({
      GIT_TOKEN_PROXY_SOCKET: listenSocket,
      CONTROL_PLANE_SOCKET_PATH: upstreamSocket,
    });
    await proxy.waitForLine((l) => l.includes('git-token-proxy-init'));
    expect(existsSync(listenSocket)).toBe(true);

    proxy.child.kill('SIGTERM');
    const result = await proxy.exited;
    expect(result.code).toBe(0);
    expect(existsSync(listenSocket)).toBe(false);
  });
});
