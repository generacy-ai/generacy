import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePostLifecycle } from '../../src/routes/lifecycle.js';
import { ControlPlaneError } from '../../src/errors.js';
import type { ActorContext } from '../../src/context.js';
import {
  setCodeServerManager,
  type CodeServerManager,
} from '../../src/services/code-server-manager.js';

vi.mock('../../src/services/default-role-writer.js', () => ({
  setDefaultRole: vi.fn(async () => {}),
}));
vi.mock('../../src/services/peer-repo-cloner.js', () => ({
  clonePeerRepos: vi.fn(async () => []),
}));
vi.mock('../../src/util/read-body.js', () => ({
  readBody: vi.fn(async () => '{}'),
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

  // --- set-default-role tests ---

  it('set-default-role — success: calls setDefaultRole and returns accepted', async () => {
    const { readBody } = await import('../../src/util/read-body.js');
    const { setDefaultRole } = await import('../../src/services/default-role-writer.js');
    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ role: 'developer' }));
    vi.mocked(setDefaultRole).mockResolvedValueOnce(undefined);

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'set-default-role' });

    expect(setDefaultRole).toHaveBeenCalledWith({ role: 'developer' });
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ accepted: true, action: 'set-default-role' });
  });

  it('set-default-role — invalid body: empty role triggers INVALID_REQUEST', async () => {
    const { readBody } = await import('../../src/util/read-body.js');
    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ role: '' }));

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'set-default-role' }),
    ).rejects.toThrow(ControlPlaneError);

    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ role: '' }));
    try {
      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'set-default-role' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('INVALID_REQUEST');
    }
  });

  it('set-default-role — role not found: propagates ControlPlaneError from service', async () => {
    const { readBody } = await import('../../src/util/read-body.js');
    const { setDefaultRole } = await import('../../src/services/default-role-writer.js');
    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ role: 'nonexistent' }));
    vi.mocked(setDefaultRole).mockRejectedValueOnce(
      new ControlPlaneError('INVALID_REQUEST', "Role 'nonexistent' not found"),
    );

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await expect(
      handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'set-default-role' }),
    ).rejects.toThrow(ControlPlaneError);

    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ role: 'nonexistent' }));
    vi.mocked(setDefaultRole).mockRejectedValueOnce(
      new ControlPlaneError('INVALID_REQUEST', "Role 'nonexistent' not found"),
    );
    try {
      await handlePostLifecycle(req, res, { userId: 'u-test' }, { action: 'set-default-role' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('INVALID_REQUEST');
      expect((err as ControlPlaneError).message).toBe("Role 'nonexistent' not found");
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

  // --- schema validation tests ---

  it('set-default-role and stop are valid actions (not UNKNOWN_ACTION)', async () => {
    // set-default-role needs a body, so mock readBody
    const { readBody } = await import('../../src/util/read-body.js');
    const { setDefaultRole } = await import('../../src/services/default-role-writer.js');
    vi.mocked(readBody).mockResolvedValueOnce(JSON.stringify({ role: 'dev' }));
    vi.mocked(setDefaultRole).mockResolvedValueOnce(undefined);

    const req = {} as IncomingMessage;
    const res1 = createMockResponse();

    // set-default-role should not throw UNKNOWN_ACTION
    await handlePostLifecycle(req, res1, { userId: 'u-test' }, { action: 'set-default-role' });
    expect(res1.writeHead).toHaveBeenCalledWith(200);

    // stop should not throw UNKNOWN_ACTION
    const res2 = createMockResponse();
    await handlePostLifecycle(req, res2, { userId: 'u-test' }, { action: 'stop' });
    expect(res2.writeHead).toHaveBeenCalledWith(200);
  });
});
