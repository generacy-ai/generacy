import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ControlPlaneServer } from '../../src/server.js';
import { initClusterState } from '../../src/state.js';
import { createClusterApiKeyReader } from '../../src/services/cluster-api-key.js';
import { createCloudPullClient } from '../../src/services/cloud-pull-client.js';
import { createGitTokenManager } from '../../src/services/git-token-manager.js';
import { setGitTokenManager } from '../../src/routes/git-token.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '../..');
const distBinPath = path.join(pkgRoot, 'dist/bin/git-credential-generacy.js');

const GET_INPUT = 'protocol=https\nhost=github.com\n\n';

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHelper(socketPath: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distBinPath, 'get'], {
      env: { ...process.env, CONTROL_PLANE_SOCKET_PATH: socketPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.write(GET_INPUT);
    child.stdin.end();
  });
}

interface FakeCloud {
  url: string;
  callCount: () => number;
  setDelayMs: (ms: number) => void;
  setMintFn: (fn: () => { token: string; expiresAt: string }) => void;
  setStatus: (status: number, body: string) => void;
  close: () => Promise<void>;
}

async function startFakeCloud(): Promise<FakeCloud> {
  let count = 0;
  let delayMs = 0;
  let mintFn: () => { token: string; expiresAt: string } = () => ({
    token: `t-${Date.now()}`,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  let overrideStatus: number | undefined;
  let overrideBody: string | undefined;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', async () => {
      count++;
      if (delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
      if (overrideStatus !== undefined) {
        res.writeHead(overrideStatus, { 'content-type': 'application/json' });
        res.end(overrideBody ?? '');
        return;
      }
      const minted = mintFn();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(minted));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Could not get fake cloud address');
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    callCount: () => count,
    setDelayMs: (ms) => {
      delayMs = ms;
    },
    setMintFn: (fn) => {
      mintFn = fn;
    },
    setStatus: (status, body) => {
      overrideStatus = status;
      overrideBody = body;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Env {
  tmpDir: string;
  socketPath: string;
  keyPath: string;
  server: ControlPlaneServer;
  cloud: FakeCloud;
  clock: { current: number };
  prevApiUrl: string | undefined;
}

async function bootEnv(opts: { initialClockMs?: number } = {}): Promise<Env> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-token-e2e-'));
  const socketPath = path.join(tmpDir, 'control.sock');
  const keyPath = path.join(tmpDir, 'cluster-api-key');
  await fs.writeFile(keyPath, 'test-api-key\n', { mode: 0o600 });

  const cloud = await startFakeCloud();
  const prevApiUrl = process.env['GENERACY_API_URL'];
  process.env['GENERACY_API_URL'] = cloud.url;

  const clock = { current: opts.initialClockMs ?? Date.now() };
  const apiKeyReader = createClusterApiKeyReader({ keyPath });
  const cloudPullClient = createCloudPullClient({ apiKeyReader });
  const gitTokenManager = createGitTokenManager({
    cloudPullClient,
    now: () => clock.current,
  });
  setGitTokenManager(gitTokenManager, 'github-app');

  initClusterState({ deploymentMode: 'local', variant: 'cluster-base' });
  const server = new ControlPlaneServer();
  await server.start(socketPath);

  return { tmpDir, socketPath, keyPath, server, cloud, clock, prevApiUrl };
}

async function tearDown(env: Env): Promise<void> {
  await env.server.close();
  await env.cloud.close();
  if (env.prevApiUrl === undefined) {
    delete process.env['GENERACY_API_URL'];
  } else {
    process.env['GENERACY_API_URL'] = env.prevApiUrl;
  }
  await fs.rm(env.tmpDir, { recursive: true, force: true });
}

describe('integration: git-token e2e (real binary + real server + fake cloud)', () => {
  beforeAll(() => {
    if (!existsSync(distBinPath)) {
      throw new Error(
        `Wrapper not built at ${distBinPath}. Run \`pnpm -F @generacy-ai/control-plane build\` first.`,
      );
    }
  });

  let env: Env;

  afterEach(async () => {
    if (env) await tearDown(env);
  });

  it('1. real `git-credential-generacy get` against live socket → success, exit 0, expected stdout', async () => {
    env = await bootEnv();
    env.cloud.setMintFn(() => ({
      token: 'ghs_e2e_happy',
      expiresAt: new Date(env.clock.current + 60 * 60_000).toISOString(),
    }));

    const result = await runHelper(env.socketPath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.split('\n');
    expect(lines).toContain('protocol=https');
    expect(lines).toContain('host=github.com');
    expect(lines).toContain('username=x-access-token');
    expect(lines).toContain('password=ghs_e2e_happy');
    expect(env.cloud.callCount()).toBe(1);
  });

  it('2. two concurrent invocations → fake cloud invoked exactly once (FR-009 cross-process)', async () => {
    env = await bootEnv();
    env.cloud.setDelayMs(150);
    env.cloud.setMintFn(() => ({
      token: 'ghs_concurrent',
      expiresAt: new Date(env.clock.current + 60 * 60_000).toISOString(),
    }));

    const [a, b] = await Promise.all([runHelper(env.socketPath), runHelper(env.socketPath)]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toContain('password=ghs_concurrent');
    expect(b.stdout).toContain('password=ghs_concurrent');
    expect(env.cloud.callCount()).toBe(1);
  });

  it('3. clock advance into 5-min pre-expiry window → second get triggers refresh (FR-004)', async () => {
    const t0 = Date.now();
    env = await bootEnv({ initialClockMs: t0 });
    let mintCall = 0;
    env.cloud.setMintFn(() => {
      mintCall++;
      return {
        token: `ghs_refresh_${mintCall}`,
        expiresAt: new Date(env.clock.current + 60 * 60_000).toISOString(),
      };
    });

    const first = await runHelper(env.socketPath);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('password=ghs_refresh_1');
    expect(env.cloud.callCount()).toBe(1);

    // Advance manager clock to within the 5-minute pre-expiry window.
    // First token expiresAt = t0 + 60 min; jump clock to t0 + 56 min → remaining 4 min.
    env.clock.current = t0 + 56 * 60_000;

    const second = await runHelper(env.socketPath);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('password=ghs_refresh_2');
    expect(env.cloud.callCount()).toBe(2);
  });

  it('4. cloud stopped → wrapper exits 4 with stderr CLOUD_UNREACHABLE (FR-008 / SC-005)', async () => {
    env = await bootEnv();
    await env.cloud.close();

    const result = await runHelper(env.socketPath);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/generacy-git-helper: CLOUD_UNREACHABLE/);
    expect(result.stdout).toBe('');
  });
});
