import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handlePostLifecycle } from '../../src/routes/lifecycle.js';
import { ControlPlaneError } from '../../src/errors.js';
import type { ActorContext } from '../../src/context.js';
import {
  setCodeServerManager,
  type CodeServerManager,
} from '../../src/services/code-server-manager.js';
import { writeWizardEnvFile } from '../../src/services/wizard-env-writer.js';
import { getRelayPushEvent } from '../../src/relay-events.js';

vi.mock('../../src/services/peer-repo-cloner.js', () => ({
  clonePeerRepos: vi.fn(async () => []),
}));
vi.mock('../../src/util/read-body.js', () => ({
  readBody: vi.fn(async () => '{}'),
}));
vi.mock('../../src/services/wizard-env-writer.js', () => ({
  writeWizardEnvFile: vi.fn(async () => ({ written: [], failed: [], hasGitHubToken: false })),
}));
vi.mock('../../src/relay-events.js', () => ({
  getRelayPushEvent: vi.fn(() => undefined),
}));

function createMockResponse() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body = '';

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    writeHead: vi.fn((code: number) => {
      statusCode = code;
    }),
    end: vi.fn((data?: string) => {
      if (data) body = data;
    }),
    get _headers() {
      return headers;
    },
    get _statusCode() {
      return statusCode;
    },
    get _body() {
      return body;
    },
  } as unknown as ServerResponse & {
    _headers: Record<string, string>;
    _statusCode: number | undefined;
    _body: string;
  };

  return res;
}

function createFakeManager(overrides: Partial<CodeServerManager> = {}): CodeServerManager {
  return {
    start: vi.fn(async () => ({ status: 'starting' as const, socket_path: '/tmp/cs.sock' })),
    stop: vi.fn(async () => {}),
    touch: vi.fn(),
    getStatus: vi.fn(() => 'stopped' as const),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('handlePostLifecycle', () => {
  afterEach(() => {
    setCodeServerManager(null);
    delete process.env.AGENCY_DIR;
    delete process.env.WIZARD_CREDS_PATH;
  });

  it('returns 200 with accepted: true for clone-peer-repos', async () => {
    const { readBody } = await import('../../src/util/read-body.js');
    const { clonePeerRepos } = await import('../../src/services/peer-repo-cloner.js');
    vi.mocked(readBody).mockResolvedValueOnce(
      JSON.stringify({ repos: ['https://github.com/org/repo'] }),
    );
    vi.mocked(clonePeerRepos).mockResolvedValueOnce([
      { repo: 'https://github.com/org/repo', status: 'done' },
    ]);

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'clone-peer-repos' });

    expect(clonePeerRepos).toHaveBeenCalledWith({
      repos: ['https://github.com/org/repo'],
      token: undefined,
    });
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  it('starts code-server and returns its status + socket_path', async () => {
    const manager = createFakeManager({
      start: vi.fn(async () => ({ status: 'starting', socket_path: '/run/code-server.sock' })),
    });
    setCodeServerManager(manager);

    const req = {} as IncomingMessage;
    const res = createMockResponse();
    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'code-server-start' });

    expect(manager.start).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ status: 'starting', socket_path: '/run/code-server.sock' });
  });

  it('surfaces SERVICE_UNAVAILABLE if code-server fails to start', async () => {
    const manager = createFakeManager({
      start: vi.fn(async () => {
        throw new Error('binary not found');
      }),
    });
    setCodeServerManager(manager);

    await expect(
      handlePostLifecycle({} as IncomingMessage, createMockResponse(), { userId: 'u-test' }, {
        action: 'code-server-start',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'binary not found' });
  });

  it('stops code-server and returns accepted: true', async () => {
    const manager = createFakeManager();
    setCodeServerManager(manager);

    const req = {} as IncomingMessage;
    const res = createMockResponse();
    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'code-server-stop' });

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'code-server-stop' });
  });

  it('throws ControlPlaneError with code UNKNOWN_ACTION for invalid action', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'invalid-action' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'invalid-action' });
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe('UNKNOWN_ACTION');
    }
  });

  it('sets Content-Type to application/json', async () => {
    const { readBody } = await import('../../src/util/read-body.js');
    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ repos: [] }));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'clone-peer-repos' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res._headers['Content-Type']).toBe('application/json');
  });

  it('throws UNAUTHORIZED when actor userId is missing', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();
    const noActor: ActorContext = {};

    await expect(
      handlePostLifecycle(req, res, noActor, { action: 'stop' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      await handlePostLifecycle(req, res, noActor, { action: 'stop' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      expect((err as ControlPlaneError).message).toBe('Missing actor identity');
    }
  });

  // --- clone-peer-repos additional tests ---

  it('clone-peer-repos — empty repos array returns accepted', async () => {
    const { readBody } = await import('../../src/util/read-body.js');
    const { clonePeerRepos } = await import('../../src/services/peer-repo-cloner.js');
    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ repos: [] }));
    vi.mocked(clonePeerRepos).mockResolvedValueOnce([]);

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'clone-peer-repos' });

    expect(clonePeerRepos).toHaveBeenCalledWith({ repos: [], token: undefined });
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'clone-peer-repos' });
  });

  // --- stop tests ---

  it('stop — returns stub accepted response', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'stop' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'stop' });
  });

  // --- bootstrap-complete tests ---

  describe('bootstrap-complete', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
      // Default: pretend GH_TOKEN was sealed so bootstrap-complete takes the
      // happy path (writes sentinel + starts code-server/tunnel). Individual
      // tests targeting the FR-006 defer branch override with mockResolvedValueOnce.
      vi.mocked(writeWizardEnvFile).mockResolvedValue({
        written: ['github-app'],
        failed: [],
        hasGitHubToken: true,
      });
    });

    afterEach(() => {
      delete process.env.POST_ACTIVATION_TRIGGER;
      rmSync(tempDir, { recursive: true, force: true });
      vi.mocked(writeWizardEnvFile).mockReset();
      vi.mocked(writeWizardEnvFile).mockResolvedValue({ written: [], failed: [], hasGitHubToken: false });
    });

    it('returns 200 and writes sentinel file', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-complete');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({ accepted: true, action: 'bootstrap-complete', sentinel: sentinelPath });
      expect(existsSync(sentinelPath)).toBe(true);
      expect(readFileSync(sentinelPath, 'utf-8')).toBe('');
    });

    it('idempotent — second call also returns 200, no error', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-complete');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      const req = {} as IncomingMessage;

      const res1 = createMockResponse();
      await handlePostLifecycle(req, res1, { userId: 'u-test' }, { action: 'bootstrap-complete' });
      expect(res1.writeHead).toHaveBeenCalledWith(200);

      const res2 = createMockResponse();
      await handlePostLifecycle(req, res2, { userId: 'u-test' }, { action: 'bootstrap-complete' });
      expect(res2.writeHead).toHaveBeenCalledWith(200);

      const body = JSON.parse(res2._body);
      expect(body).toEqual({ accepted: true, action: 'bootstrap-complete', sentinel: sentinelPath });
    });

    it('POST_ACTIVATION_TRIGGER env var overrides default sentinel path', async () => {
      const customPath = join(tempDir, 'custom-sentinel');
      process.env.POST_ACTIVATION_TRIGGER = customPath;

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      const body = JSON.parse(res._body);
      expect(body.sentinel).toBe(customPath);
      expect(existsSync(customPath)).toBe(true);
    });

    it('triggers code-server start (fire-and-forget)', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-cs');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      const manager = createFakeManager();
      setCodeServerManager(manager);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(manager.start).toHaveBeenCalledOnce();
      expect(res.writeHead).toHaveBeenCalledWith(200);
      // Response returns immediately (not blocked by start)
      const body = JSON.parse(res._body);
      expect(body.accepted).toBe(true);
    });

    it('does not fail bootstrap-complete if code-server start rejects', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-cs-fail');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      const manager = createFakeManager({
        start: vi.fn(async () => { throw new Error('binary not found'); }),
      });
      setCodeServerManager(manager);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      // Should NOT throw — fire-and-forget
      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      expect(existsSync(sentinelPath)).toBe(true);
    });

    it('missing actor returns 401 UNAUTHORIZED', async () => {
      const req = {} as IncomingMessage;
      const res = createMockResponse();
      const noActor: ActorContext = {};

      await expect(
        handlePostLifecycle(req, res, noActor, { action: 'bootstrap-complete' }),
      ).rejects.toThrow(ControlPlaneError);

      try {
        await handlePostLifecycle(req, res, noActor, { action: 'bootstrap-complete' });
      } catch (err) {
        expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      }
    });

    it('bootstrap-complete writes env file before sentinel', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-env-before');
      const agencyDir = join(tempDir, 'agency');
      const envFilePath = join(tempDir, 'wizard-credentials.env');

      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;
      process.env.AGENCY_DIR = agencyDir;
      process.env.WIZARD_CREDS_PATH = envFilePath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: ['github-main-org'],
        failed: [],
        hasGitHubToken: true,
      });

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(writeWizardEnvFile).toHaveBeenCalledWith({ agencyDir, envFilePath });
      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({ accepted: true, action: 'bootstrap-complete', sentinel: sentinelPath });
    });

    it('bootstrap-complete with no credentials.yaml defers the sentinel (FR-006)', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-no-creds');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({ written: [], failed: [], hasGitHubToken: false });

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      // No token → sentinel deferred until later bootstrap-complete with credentials.
      expect(existsSync(sentinelPath)).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({ accepted: true, action: 'bootstrap-complete', sentinel: null });
    });

    it('bootstrap-complete with unseal failure defers the sentinel (non-fatal, FR-006)', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-unseal-fail');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockRejectedValueOnce(new Error('unseal exploded'));

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      // Should NOT throw — the catch swallows the error. Since hasGitHubToken
      // stays false on unseal failure, the sentinel is deferred to a later call.
      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(existsSync(sentinelPath)).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({ accepted: true, action: 'bootstrap-complete', sentinel: null });
    });

    // RT-004: fresh-wizard defer path — GH_TOKEN not sealed. Mirrors the
    // existing prepare-workspace gated-sentinel test: no sentinel written,
    // sentinel: null in response, awaiting-credentials event emitted, and
    // neither code-server nor tunnel started.
    it('defers the sentinel when hasGitHubToken is false and emits awaiting-credentials event', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-deferred');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: [],
        failed: [],
        hasGitHubToken: false,
      });

      const codeServer = createFakeManager();
      setCodeServerManager(codeServer);

      const mockPushEvent = vi.fn();
      vi.mocked(getRelayPushEvent).mockReturnValue(mockPushEvent);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({
        accepted: true,
        action: 'bootstrap-complete',
        sentinel: null,
      });
      // Sentinel MUST NOT be written on the defer path.
      expect(existsSync(sentinelPath)).toBe(false);
      // Awaiting-credentials event emitted exactly once with the FR-006 shape.
      const bootstrapCalls = mockPushEvent.mock.calls.filter(
        (call) => call[0] === 'cluster.bootstrap',
      );
      expect(bootstrapCalls).toContainEqual([
        'cluster.bootstrap',
        { status: 'awaiting-credentials', reason: 'github-token-not-sealed' },
      ]);
      // Neither code-server nor tunnel start on the defer path (defer semantics).
      expect(codeServer.start).not.toHaveBeenCalled();

      vi.mocked(getRelayPushEvent).mockReturnValue(undefined);
    });

    // Positive-path assertion (T005): when hasGitHubToken is true the handler
    // must behave exactly as before — writes sentinel, starts code-server, and
    // returns sentinel path. Guards D8 defer-not-remove-behavior.
    it('still writes sentinel and starts code-server when hasGitHubToken is true', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-sealed');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: ['github-app'],
        failed: [],
        hasGitHubToken: true,
      });

      const codeServer = createFakeManager();
      setCodeServerManager(codeServer);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({
        accepted: true,
        action: 'bootstrap-complete',
        sentinel: sentinelPath,
      });
      expect(existsSync(sentinelPath)).toBe(true);
      expect(codeServer.start).toHaveBeenCalledOnce();
    });

    it('relay warning emitted on partial credential unseal failure', async () => {
      const sentinelPath = join(tempDir, 'bootstrap-partial');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: ['good-cred'],
        failed: ['bad-cred'],
        hasGitHubToken: false,
      });

      const mockPushEvent = vi.fn();
      vi.mocked(getRelayPushEvent).mockReturnValueOnce(mockPushEvent);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'bootstrap-complete' });

      expect(mockPushEvent).toHaveBeenCalledWith('cluster.bootstrap', {
        warning: 'credential-unseal-partial',
        failed: ['bad-cred'],
        written: ['good-cred'],
      });
      expect(res.writeHead).toHaveBeenCalledWith(200);
    });
  });

  // --- prepare-workspace tests ---
  // Same wire shape as bootstrap-complete but deliberately skips
  // code-server / tunnel start so the wizard can fire it earlier (after the
  // GitHub App step) to kick off the workspace clone in parallel with the
  // remaining wizard steps.

  describe('prepare-workspace', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
    });

    afterEach(() => {
      delete process.env.POST_ACTIVATION_TRIGGER;
      delete process.env.AGENCY_DIR;
      delete process.env.WIZARD_CREDS_PATH;
      rmSync(tempDir, { recursive: true, force: true });
      vi.mocked(writeWizardEnvFile).mockReset();
      vi.mocked(writeWizardEnvFile).mockResolvedValue({ written: [], failed: [], hasGitHubToken: false });
    });

    it('writes the sentinel (same path bootstrap-complete uses) once the GitHub token is sealed', async () => {
      const sentinelPath = join(tempDir, 'prepare-workspace-sentinel');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;
      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: ['github-app'],
        failed: [],
        hasGitHubToken: true,
      });

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'prepare-workspace' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({ accepted: true, action: 'prepare-workspace', sentinel: sentinelPath });
      expect(existsSync(sentinelPath)).toBe(true);
    });

    it('defers the sentinel until the GitHub token is sealed (no token → no clone yet)', async () => {
      const sentinelPath = join(tempDir, 'prepare-workspace-deferred');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;
      // default mock: hasGitHubToken: false
      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'prepare-workspace' });

      expect(res.writeHead).toHaveBeenCalledWith(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({ accepted: true, action: 'prepare-workspace', sentinel: null });
      // No early clone — the one-shot post-activation hook must not fire before
      // GH_TOKEN exists; bootstrap-complete fires the sentinel later.
      expect(existsSync(sentinelPath)).toBe(false);
    });

    it('unseals whatever credentials are currently stored (partial is fine)', async () => {
      const sentinelPath = join(tempDir, 'prepare-workspace-partial');
      const agencyDir = join(tempDir, 'agency');
      const envFilePath = join(tempDir, 'wizard-credentials.env');

      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;
      process.env.AGENCY_DIR = agencyDir;
      process.env.WIZARD_CREDS_PATH = envFilePath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: ['github-main-org'],
        failed: [],
      });

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'prepare-workspace' });

      expect(writeWizardEnvFile).toHaveBeenCalledWith({ agencyDir, envFilePath });
      expect(res.writeHead).toHaveBeenCalledWith(200);
    });

    it('does NOT start code-server (that waits for bootstrap-complete)', async () => {
      const sentinelPath = join(tempDir, 'prepare-workspace-no-cs');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      const manager = createFakeManager();
      setCodeServerManager(manager);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'prepare-workspace' });

      expect(manager.start).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200);
    });

    it('idempotent — bootstrap-complete after prepare-workspace still succeeds', async () => {
      const sentinelPath = join(tempDir, 'prepare-then-bootstrap');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      // Simulate the real wizard sequence: prepare-workspace fires first
      // pre-credentials (defers), then bootstrap-complete fires post-wizard
      // with credentials sealed (writes sentinel).
      vi.mocked(writeWizardEnvFile)
        .mockResolvedValueOnce({ written: [], failed: [], hasGitHubToken: false })
        .mockResolvedValueOnce({ written: ['github-app'], failed: [], hasGitHubToken: true });

      const req = {} as IncomingMessage;

      const res1 = createMockResponse();
      await handlePostLifecycle(req, res1, { userId: 'u-test' }, { action: 'prepare-workspace' });
      expect(res1.writeHead).toHaveBeenCalledWith(200);

      const res2 = createMockResponse();
      await handlePostLifecycle(req, res2, { userId: 'u-test' }, { action: 'bootstrap-complete' });
      expect(res2.writeHead).toHaveBeenCalledWith(200);

      expect(existsSync(sentinelPath)).toBe(true);
    });

    it('unseal failure is non-fatal and defers the sentinel (no token → no clone yet)', async () => {
      const sentinelPath = join(tempDir, 'prepare-workspace-unseal-fail');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockRejectedValueOnce(new Error('unseal exploded'));

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'prepare-workspace' });

      // Still responds 200 (non-fatal), but with no GH_TOKEN the early clone is
      // deferred to bootstrap-complete rather than firing a token-less clone.
      expect(res.writeHead).toHaveBeenCalledWith(200);
      expect(existsSync(sentinelPath)).toBe(false);
    });

    it('partial unseal emits the same cluster.bootstrap relay warning', async () => {
      const sentinelPath = join(tempDir, 'prepare-workspace-partial-warn');
      process.env.POST_ACTIVATION_TRIGGER = sentinelPath;

      vi.mocked(writeWizardEnvFile).mockResolvedValueOnce({
        written: ['good-cred'],
        failed: ['bad-cred'],
        hasGitHubToken: false,
      });

      const mockPushEvent = vi.fn();
      vi.mocked(getRelayPushEvent).mockReturnValueOnce(mockPushEvent);

      const req = {} as IncomingMessage;
      const res = createMockResponse();

      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'prepare-workspace' });

      expect(mockPushEvent).toHaveBeenCalledWith('cluster.bootstrap', {
        warning: 'credential-unseal-partial',
        failed: ['bad-cred'],
        written: ['good-cred'],
      });
      expect(res.writeHead).toHaveBeenCalledWith(200);
    });
  });

  // --- schema validation tests ---

  it('stop is a valid action (not UNKNOWN_ACTION)', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'stop' });
    expect(res.writeHead).toHaveBeenCalledWith(200);
  });
});
