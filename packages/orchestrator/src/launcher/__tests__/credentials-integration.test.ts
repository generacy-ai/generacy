import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AgentLauncher } from '../agent-launcher.js';
import { GenericSubprocessPlugin } from '../generic-subprocess-plugin.js';
import { CredhelperHttpClient } from '../credhelper-client.js';
import { CredhelperUnavailableError } from '../credhelper-errors.js';
import type { LaunchRequest } from '../types.js';
import type { ProcessFactory, ChildProcessHandle } from '../../worker/types.js';

function tmpSocketPath(): string {
  const suffix = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `credhelper-integ-${suffix}.sock`);
}

/**
 * A ProcessFactory that captures spawn args and exposes session env
 * so we can verify the credhelper session variables reached the child.
 */
class CapturingProcessFactory implements ProcessFactory {
  lastSpawn?: {
    command: string;
    args: string[];
    env: Record<string, string>;
    uid?: number;
    gid?: number;
  };

  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal; uid?: number; gid?: number; detached?: boolean },
  ): ChildProcessHandle {
    this.lastSpawn = {
      command,
      args: [...args],
      env: { ...options.env },
      uid: options.uid,
      gid: options.gid,
    };

    let exitResolve: (code: number | null) => void;
    const exitPromise = new Promise<number | null>((resolve) => {
      exitResolve = resolve;
    });

    // Simulate immediate exit
    void Promise.resolve().then(() => exitResolve(0));

    return {
      stdin: null,
      stdout: null,
      stderr: null,
      pid: 9999,
      kill: () => {
        exitResolve(0);
        return true;
      },
      exitPromise,
    };
  }
}

// --- T040: Full lifecycle integration test ---

describe('Credentials integration: full lifecycle with mock daemon', () => {
  let server: http.Server;
  let socketPath: string;
  const receivedRequests: { method: string; url: string; body: string }[] = [];

  beforeAll(async () => {
    socketPath = tmpSocketPath();

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedRequests.push({ method: req.method ?? '', url: req.url ?? '', body });

        if (req.method === 'POST' && req.url === '/sessions') {
          const parsed = JSON.parse(body) as { session_id: string };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            session_dir: `/run/generacy-credhelper/sessions/${parsed.session_id}`,
            expires_at: '2026-04-13T16:00:00.000Z',
          }));
        } else if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
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
    try { fs.unlinkSync(socketPath); } catch { /* already cleaned */ }
  });

  it('begin session → spawn with session env → exit → end session', async () => {
    receivedRequests.length = 0;

    const factory = new CapturingProcessFactory();
    const client = new CredhelperHttpClient({ socketPath, connectTimeout: 5000 });
    const launcher = new AgentLauncher(new Map([['default', factory]]), client);
    launcher.registerPlugin(new GenericSubprocessPlugin());

    const request: LaunchRequest = {
      intent: {
        kind: 'generic-subprocess',
        command: 'echo',
        args: ['hello'],
      },
      cwd: '/tmp',
      env: { AGENT_ID: 'test-agent', WORKFLOW_ID: 'wf-integ' },
      credentials: { role: 'developer', uid: 1001, gid: 1001 },
    };

    const handle = await launcher.launch(request);

    // 1. Verify beginSession was called
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].method).toBe('POST');
    expect(receivedRequests[0].url).toBe('/sessions');
    const beginBody = JSON.parse(receivedRequests[0].body) as { role: string; session_id: string };
    expect(beginBody.role).toBe('developer');
    expect(beginBody.session_id).toMatch(/^test-agent-wf-integ-\d+-[0-9a-f]{4}$/);

    // 2. Verify spawn was called with wrapped command and session env
    expect(factory.lastSpawn).toBeDefined();
    expect(factory.lastSpawn!.command).toBe('sh');
    expect(factory.lastSpawn!.args[0]).toBe('-c');
    expect(factory.lastSpawn!.args).toContain('echo');
    expect(factory.lastSpawn!.args).toContain('hello');
    expect(factory.lastSpawn!.uid).toBe(1001);
    expect(factory.lastSpawn!.gid).toBe(1001);

    // Session env vars are present
    const sessionDir = `/run/generacy-credhelper/sessions/${beginBody.session_id}`;
    expect(factory.lastSpawn!.env.GENERACY_SESSION_DIR).toBe(sessionDir);
    expect(factory.lastSpawn!.env.GIT_CONFIG_GLOBAL).toBe(`${sessionDir}/git/config`);
    expect(factory.lastSpawn!.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(`${sessionDir}/gcp/external-account.json`);
    expect(factory.lastSpawn!.env.DOCKER_HOST).toBe(`unix://${sessionDir}/docker.sock`);

    // 3. Wait for exit and endSession cleanup
    await handle.process.exitPromise;
    // Give the cleanup handler time to fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    // endSession should have been called
    expect(receivedRequests).toHaveLength(2);
    expect(receivedRequests[1].method).toBe('DELETE');
    expect(receivedRequests[1].url).toBe(`/sessions/${encodeURIComponent(beginBody.session_id)}`);
  });
});

// --- T041: Credentials requested but no daemon running ---

describe('Credentials integration: no daemon running', () => {
  it('throws CredhelperUnavailableError with descriptive message including socket path', async () => {
    const badSocketPath = '/tmp/nonexistent-credhelper-integ-test.sock';

    const factory = new CapturingProcessFactory();
    const client = new CredhelperHttpClient({ socketPath: badSocketPath, connectTimeout: 1000 });
    const launcher = new AgentLauncher(new Map([['default', factory]]), client);
    launcher.registerPlugin(new GenericSubprocessPlugin());

    const request: LaunchRequest = {
      intent: {
        kind: 'generic-subprocess',
        command: 'echo',
        args: ['should-not-run'],
      },
      cwd: '/tmp',
      credentials: { role: 'developer', uid: 1001, gid: 1001 },
    };

    await expect(launcher.launch(request)).rejects.toThrow(CredhelperUnavailableError);

    try {
      await launcher.launch(request);
    } catch (err) {
      const unavailErr = err as CredhelperUnavailableError;
      expect(unavailErr.socketPath).toBe(badSocketPath);
      expect(unavailErr.message).toContain(badSocketPath);
      expect(unavailErr.message).toContain('credhelper not responding');
    }

    // Factory should never have been called — launch fails before spawn
    expect(factory.lastSpawn).toBeUndefined();
  });
});
