import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '../..');
const distBinPath = path.join(pkgRoot, 'dist/bin/git-credential-generacy.js');

interface FakeServerHandle {
  socketPath: string;
  setResponse: (status: number, body: string | object) => void;
  setHandler: (h: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
  close: () => Promise<void>;
}

async function startSocketServer(socketPath: string): Promise<FakeServerHandle> {
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'default-token', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.once('error', reject);
  });
  return {
    socketPath,
    setHandler: (h) => {
      handler = h;
    },
    setResponse: (status, body) => {
      handler = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHelper(action: string, stdinInput: string, env: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distBinPath, action], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

const GET_INPUT = 'protocol=https\nhost=github.com\n\n';

describe('git-credential-generacy CLI wrapper', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: FakeServerHandle | undefined;

  beforeAll(() => {
    if (!existsSync(distBinPath)) {
      throw new Error(
        `Wrapper not built at ${distBinPath}. Run \`pnpm -F @generacy-ai/control-plane build\` first.`,
      );
    }
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gcg-test-'));
    socketPath = path.join(tmpDir, 'control.sock');
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('get happy path: emits expected stdout and exits 0', async () => {
    server = await startSocketServer(socketPath);
    server.setResponse(200, { token: 'ghs_abc', expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const result = await runHelper('get', GET_INPUT, { CONTROL_PLANE_SOCKET_PATH: socketPath });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('protocol=https');
    expect(result.stdout).toContain('host=github.com');
    expect(result.stdout).toContain('username=x-access-token');
    expect(result.stdout).toContain('password=ghs_abc');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('get echoes protocol and host lines verbatim', async () => {
    server = await startSocketServer(socketPath);
    server.setResponse(200, { token: 'ghs_xyz', expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const result = await runHelper('get', 'protocol=https\nhost=github.com\npath=foo/bar.git\n\n', {
      CONTROL_PLANE_SOCKET_PATH: socketPath,
    });

    const lines = result.stdout.split('\n');
    expect(lines).toContain('protocol=https');
    expect(lines).toContain('host=github.com');
    expect(lines).toContain('username=x-access-token');
    expect(lines).toContain('password=ghs_xyz');
  });

  it('get with non-github host: exit 0, no stdout, no socket call', async () => {
    server = await startSocketServer(socketPath);
    let called = false;
    server.setHandler((_req, res) => {
      called = true;
      res.writeHead(200);
      res.end('{}');
    });

    const result = await runHelper('get', 'protocol=https\nhost=gitlab.com\n\n', {
      CONTROL_PLANE_SOCKET_PATH: socketPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(called).toBe(false);
  });

  it('store: exit 0, no stdout regardless of stdin', async () => {
    server = await startSocketServer(socketPath);
    const result = await runHelper(
      'store',
      'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_secret\n\n',
      { CONTROL_PLANE_SOCKET_PATH: socketPath },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('erase: exit 0, no stdout', async () => {
    server = await startSocketServer(socketPath);
    const result = await runHelper('erase', GET_INPUT, { CONTROL_PLANE_SOCKET_PATH: socketPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('control socket unreachable: exit 2 + CONTROL_SOCKET_UNREACHABLE', async () => {
    // No server started; socketPath does not exist.
    const result = await runHelper('get', GET_INPUT, { CONTROL_PLANE_SOCKET_PATH: socketPath });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/generacy-git-helper: CONTROL_SOCKET_UNREACHABLE/);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['CLUSTER_API_KEY_MISSING', 503, 3],
    ['CLOUD_UNREACHABLE', 502, 4],
    ['CLOUD_AUTH_REJECTED', 502, 5],
    ['CLOUD_REQUEST_INVALID', 502, 6],
    ['CLOUD_UPSTREAM_ERROR', 502, 7],
    ['CLOUD_RESPONSE_INVALID', 502, 8],
    ['CREDENTIAL_NOT_CONFIGURED', 400, 9],
  ])('error code %s → exit %d', async (code, httpStatus, expectedExit) => {
    server = await startSocketServer(socketPath);
    server.setResponse(httpStatus, { error: 'failed', code });

    const result = await runHelper('get', GET_INPUT, { CONTROL_PLANE_SOCKET_PATH: socketPath });

    expect(result.exitCode).toBe(expectedExit);
    expect(result.stderr).toMatch(new RegExp(`generacy-git-helper: ${code}: `));
    expect(result.stdout).toBe('');
  });

  it('unknown action: exit 1 + INTERNAL_ERROR', async () => {
    server = await startSocketServer(socketPath);
    const result = await runHelper('weird', '', { CONTROL_PLANE_SOCKET_PATH: socketPath });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/generacy-git-helper: INTERNAL_ERROR/);
  });

  it('never logs the token on success', async () => {
    const secret = 'ghs_should_not_appear_in_stderr';
    server = await startSocketServer(socketPath);
    server.setResponse(200, { token: secret, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const result = await runHelper('get', GET_INPUT, { CONTROL_PLANE_SOCKET_PATH: socketPath });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(secret);
  });

  it('never logs the token on error paths', async () => {
    const secret = 'ghs_leaked_in_error';
    server = await startSocketServer(socketPath);
    server.setResponse(500, { token: secret, error: 'boom', code: 'CLOUD_UPSTREAM_ERROR' });

    const result = await runHelper('get', GET_INPUT, { CONTROL_PLANE_SOCKET_PATH: socketPath });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).toBe('');
  });
});
