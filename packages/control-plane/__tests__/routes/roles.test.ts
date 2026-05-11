import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type http from 'node:http';
import type { IncomingMessage } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { handleGetRole, handleListRoles, handlePutRole } from '../../src/routes/roles.js';
import type { ActorContext } from '../../src/context.js';
import { ControlPlaneError } from '../../src/errors.js';

function createMockResponse() {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function createBodyReq(body: object): http.IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(JSON.stringify(body));
  readable.push(null);
  return readable as unknown as http.IncomingMessage;
}

const stubActor: ActorContext = { userId: 'u-test', sessionId: 's-test' };

describe('handleListRoles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-list-test-'));
    process.env['CREDHELPER_AGENCY_DIR'] = path.join(tmpDir, '.agency');
  });

  afterEach(async () => {
    delete process.env['CREDHELPER_AGENCY_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns { roles: [] } when roles directory does not exist', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleListRoles(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ roles: [] });
  });

  it('returns { roles: [] } when roles directory is empty', async () => {
    await fs.mkdir(path.join(tmpDir, '.agency', 'roles'), { recursive: true });

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleListRoles(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ roles: [] });
  });

  it('returns parsed roles with id and description from .yaml files', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(
      path.join(rolesDir, 'reviewer.yaml'),
      'description: "Code review role"\ncredentials:\n  - ref: github-pat\n    type: github-pat\n',
    );
    await fs.writeFile(
      path.join(rolesDir, 'deployer.yaml'),
      'description: "Deploy role"\n',
    );

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleListRoles(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.roles).toHaveLength(2);
    const ids = body.roles.map((r: any) => r.id).sort();
    expect(ids).toEqual(['deployer', 'reviewer']);
    const reviewer = body.roles.find((r: any) => r.id === 'reviewer');
    expect(reviewer.description).toBe('Code review role');
  });

  it('ignores non-.yaml files', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(path.join(rolesDir, 'reviewer.yaml'), 'description: "A role"\n');
    await fs.writeFile(path.join(rolesDir, 'README.md'), '# Roles\n');
    await fs.writeFile(path.join(rolesDir, 'notes.txt'), 'some notes\n');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleListRoles(req, res as any, stubActor, {});

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0].id).toBe('reviewer');
  });

  it('includes role with id only when YAML is malformed', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(path.join(rolesDir, 'good.yaml'), 'description: "Good role"\n');
    await fs.writeFile(path.join(rolesDir, 'bad.yaml'), ':\n  - :\n  invalid: [yaml');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleListRoles(req, res as any, stubActor, {});

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.roles).toHaveLength(2);
    const bad = body.roles.find((r: any) => r.id === 'bad');
    expect(bad).toBeDefined();
    expect(bad.id).toBe('bad');
    // description should be absent or undefined for malformed YAML
  });

  it('sets Content-Type to application/json', async () => {
    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleListRoles(req, res as any, stubActor, {});

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});

describe('handleGetRole', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-get-test-'));
    process.env['CREDHELPER_AGENCY_DIR'] = path.join(tmpDir, '.agency');
  });

  afterEach(async () => {
    delete process.env['CREDHELPER_AGENCY_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns parsed YAML content when role file exists', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(
      path.join(rolesDir, 'reviewer.yaml'),
      'description: "Code review role"\ncredentials:\n  - ref: github-pat\n    type: github-pat\n',
    );

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'reviewer' });

    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.id).toBe('reviewer');
    expect(body.description).toBe('Code review role');
    expect(body.credentials).toEqual([{ ref: 'github-pat', type: 'github-pat' }]);
  });

  it('returns 404 with NOT_FOUND code when role file does not exist', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'nonexistent' });

    expect(res.writeHead).toHaveBeenCalledWith(404);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toContain('nonexistent');
  });

  it('returns 500 with INTERNAL_ERROR on parse failure', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(path.join(rolesDir, 'broken.yaml'), 'key: [unclosed');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'broken' });

    expect(res.writeHead).toHaveBeenCalledWith(500);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('sets Content-Type to application/json', async () => {
    const rolesDir = path.join(tmpDir, '.agency', 'roles');
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(path.join(rolesDir, 'test.yaml'), 'description: "Test"\n');

    const req = {} as IncomingMessage;
    const res = createMockResponse();

    await handleGetRole(req, res as any, stubActor, { id: 'test' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});

describe('handlePutRole', () => {
  it('returns 200 with { ok: true }', async () => {
    const req = createBodyReq({ description: 'Updated role' });
    const res = createMockResponse();

    await handlePutRole(req, res as any, stubActor, { id: 'role-1' });

    expect(res.writeHead).toHaveBeenCalledWith(200);

    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ ok: true });
  });

  it('sets Content-Type to application/json', async () => {
    const req = createBodyReq({ description: 'Updated role' });
    const res = createMockResponse();

    await handlePutRole(req, res as any, stubActor, { id: 'role-1' });

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });

  it('throws UNAUTHORIZED when actor userId is missing', async () => {
    const req = createBodyReq({ description: 'Updated role' });
    const res = createMockResponse();
    const noActor: ActorContext = {};

    await expect(
      handlePutRole(req, res as any, noActor, { id: 'role-1' }),
    ).rejects.toThrow(ControlPlaneError);

    try {
      const req2 = createBodyReq({ description: 'Updated role' });
      await handlePutRole(req2, res as any, noActor, { id: 'role-1' });
    } catch (err) {
      expect((err as ControlPlaneError).code).toBe('UNAUTHORIZED');
      expect((err as ControlPlaneError).message).toBe('Missing actor identity');
    }
  });
});
